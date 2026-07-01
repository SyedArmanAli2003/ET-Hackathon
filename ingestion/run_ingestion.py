"""
run_ingestion.py — Master orchestrator for the air quality ingestion pipeline.

Runs three steps in sequence:
  1. setup_stations  — sync monitoring stations from OpenAQ
  2. ingest_readings — fetch last N hours of PM2.5/AQI readings
  3. ingest_weather  — fetch last N hours of hourly weather

Each step is isolated in its own try/except block so a transient API outage
(e.g. OpenAQ is briefly down) does not abort the remaining steps.

Counts are derived by querying the database BEFORE and AFTER each step, not
from the individual scripts' log output, so they are exact even if a step
partially succeeds.

Usage:
    # Full run (all three steps, last 24 h)
    python ingestion/run_ingestion.py

    # Change the look-back window for readings + weather
    python ingestion/run_ingestion.py --hours 48

    # Skip station setup (stations already seeded)
    python ingestion/run_ingestion.py --skip-stations

    # Skip a step entirely
    python ingestion/run_ingestion.py --skip-readings
    python ingestion/run_ingestion.py --skip-weather

    # Preview — no DB writes anywhere
    python ingestion/run_ingestion.py --dry-run
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
import traceback
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

# ── path setup ────────────────────────────────────────────────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

from dotenv import load_dotenv
load_dotenv(dotenv_path=os.path.join(_HERE, ".env"))
load_dotenv()

# ── logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# ── lazy imports (after path is set) ─────────────────────────────────────────
from sqlalchemy import text                         # noqa: E402
from config import TRACKED_CITIES, OPENAQ_RADIUS_KM # noqa: E402
from db import get_engine, validate_table_name       # noqa: E402
import setup_stations                               # noqa: E402
import ingest_readings                              # noqa: E402
import ingest_weather                               # noqa: E402


# ─────────────────────────────────────────────────────────────────────────────
# Step result bookkeeping
# ─────────────────────────────────────────────────────────────────────────────

class StepStatus(str, Enum):
    SUCCESS = "SUCCESS"
    FAILED  = "FAILED"
    SKIPPED = "SKIPPED"


@dataclass
class StepResult:
    name:       str
    status:     StepStatus     = StepStatus.SKIPPED
    rows_before: int           = 0
    rows_after:  int           = 0
    error:       Optional[str] = None
    elapsed_s:   float         = 0.0

    @property
    def new_rows(self) -> int:
        return max(0, self.rows_after - self.rows_before)

    def summary_line(self) -> str:
        if self.status == StepStatus.SKIPPED:
            return f"  {self.name:<20}  SKIPPED"
        if self.status == StepStatus.FAILED:
            return f"  {self.name:<20}  FAILED   ({self.error})"
        return (
            f"  {self.name:<20}  OK       "
            f"new_rows={self.new_rows:>5}  "
            f"total={self.rows_after:>6}  "
            f"elapsed={self.elapsed_s:.1f}s"
        )


# ─────────────────────────────────────────────────────────────────────────────
# DB helpers
# ─────────────────────────────────────────────────────────────────────────────

def _count(table: str) -> int:
    """Return the current row count of a table via a parameterized query.
    Table name is validated against an allowlist to prevent SQL injection.
    """
    safe_table = validate_table_name(table)
    with get_engine().connect() as conn:
        row = conn.execute(
            text(f"SELECT COUNT(*) FROM {safe_table}")
        ).fetchone()
        return int(row[0]) if row else 0


# ─────────────────────────────────────────────────────────────────────────────
# Individual step runners
# Each returns a StepResult with before/after counts and elapsed time.
# ─────────────────────────────────────────────────────────────────────────────

def run_stations(dry_run: bool) -> StepResult:
    result = StepResult(name="stations")
    result.rows_before = _count("stations")

    log.info("=" * 60)
    log.info("STEP 1/3  setup_stations")
    log.info("=" * 60)
    t0 = time.monotonic()

    try:
        setup_stations.process_cities(
            cities=TRACKED_CITIES,
            radius_km=OPENAQ_RADIUS_KM,
            dry_run=dry_run,
        )
        result.rows_after = _count("stations")
        result.status = StepStatus.SUCCESS
    except Exception:
        result.rows_after = _count("stations")
        result.status = StepStatus.FAILED
        result.error  = traceback.format_exc().strip().splitlines()[-1]
        log.error("stations step failed:\n%s", traceback.format_exc())

    result.elapsed_s = time.monotonic() - t0
    return result


def run_readings(hours: int, dry_run: bool) -> StepResult:
    result = StepResult(name="readings")
    result.rows_before = _count("readings")

    log.info("=" * 60)
    log.info("STEP 2/3  ingest_readings  (last %d h)", hours)
    log.info("=" * 60)
    t0 = time.monotonic()

    try:
        ingest_readings.run(
            hours=hours,
            dry_run=dry_run,
            filter_external_id=None,   # all stations
        )
        result.rows_after = _count("readings")
        result.status = StepStatus.SUCCESS
    except Exception:
        result.rows_after = _count("readings")
        result.status = StepStatus.FAILED
        result.error  = traceback.format_exc().strip().splitlines()[-1]
        log.error("readings step failed:\n%s", traceback.format_exc())

    result.elapsed_s = time.monotonic() - t0
    return result


def run_weather(hours: int, dry_run: bool) -> StepResult:
    result = StepResult(name="weather")
    result.rows_before = _count("weather")

    log.info("=" * 60)
    log.info("STEP 3/3  ingest_weather   (last %d h)", hours)
    log.info("=" * 60)
    t0 = time.monotonic()

    try:
        ingest_weather.run(
            hours=hours,
            dry_run=dry_run,
            filter_station_id=None,    # all stations
        )
        result.rows_after = _count("weather")
        result.status = StepStatus.SUCCESS
    except Exception:
        result.rows_after = _count("weather")
        result.status = StepStatus.FAILED
        result.error  = traceback.format_exc().strip().splitlines()[-1]
        log.error("weather step failed:\n%s", traceback.format_exc())

    result.elapsed_s = time.monotonic() - t0
    return result


# ─────────────────────────────────────────────────────────────────────────────
# Orchestrator
# ─────────────────────────────────────────────────────────────────────────────

def run_pipeline(
    hours:          int,
    dry_run:        bool,
    skip_stations:  bool,
    skip_readings:  bool,
    skip_weather:   bool,
) -> list[StepResult]:
    """
    Execute up to three steps in order, collecting a StepResult for each.
    Steps that are flagged as --skip-* are recorded as SKIPPED without running.
    A failed step does NOT prevent subsequent steps from running.
    """
    pipeline_start = time.monotonic()
    log.info("*" * 60)
    log.info("  INGESTION PIPELINE START")
    if dry_run:
        log.info("  DRY RUN — no database writes")
    log.info("*" * 60)

    results: list[StepResult] = []

    # ── Step 1: stations ───────────────────────────────────────────────────
    if skip_stations:
        log.info("Skipping stations step (--skip-stations).")
        r = StepResult(name="stations", status=StepStatus.SKIPPED)
        r.rows_after = _count("stations")
    else:
        r = run_stations(dry_run=dry_run)
    results.append(r)

    # ── Step 2: readings ───────────────────────────────────────────────────
    if skip_readings:
        log.info("Skipping readings step (--skip-readings).")
        r = StepResult(name="readings", status=StepStatus.SKIPPED)
        r.rows_after = _count("readings")
    else:
        r = run_readings(hours=hours, dry_run=dry_run)
    results.append(r)

    # ── Step 3: weather ────────────────────────────────────────────────────
    if skip_weather:
        log.info("Skipping weather step (--skip-weather).")
        r = StepResult(name="weather", status=StepStatus.SKIPPED)
        r.rows_after = _count("weather")
    else:
        r = run_weather(hours=hours, dry_run=dry_run)
    results.append(r)

    # ── Final summary ──────────────────────────────────────────────────────
    total_elapsed = time.monotonic() - pipeline_start
    errors = [r for r in results if r.status == StepStatus.FAILED]

    s_stations = next(r for r in results if r.name == "stations")
    s_readings = next(r for r in results if r.name == "readings")
    s_weather  = next(r for r in results if r.name == "weather")

    log.info("")
    log.info("*" * 60)
    log.info("  INGESTION PIPELINE COMPLETE  (%.1f s total)", total_elapsed)
    log.info("*" * 60)
    log.info("")
    log.info("  Step results:")
    for r in results:
        log.info(r.summary_line())
    log.info("")
    log.info("  ── Totals ───────────────────────────────────────────────")
    log.info("  Total stations in DB    : %d", s_stations.rows_after)
    log.info("  New readings inserted   : %d", s_readings.new_rows)
    log.info("  New weather rows inserted: %d", s_weather.new_rows)
    if errors:
        log.info("")
        log.info("  !! %d step(s) encountered errors:", len(errors))
        for r in errors:
            log.info("     - %s: %s", r.name, r.error)
    log.info("*" * 60)
    log.info("")

    return results


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the full air quality ingestion pipeline.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python ingestion/run_ingestion.py                # full run, last 24 h
  python ingestion/run_ingestion.py --hours 48     # backfill last 48 h
  python ingestion/run_ingestion.py --skip-stations # skip station sync
  python ingestion/run_ingestion.py --dry-run       # preview, no writes
        """,
    )
    parser.add_argument(
        "--hours",
        type=int,
        default=24,
        metavar="N",
        help="Hours of history to fetch for readings + weather (default: 24).",
    )
    parser.add_argument(
        "--skip-stations",
        action="store_true",
        help="Skip the stations sync step.",
    )
    parser.add_argument(
        "--skip-readings",
        action="store_true",
        help="Skip the readings ingestion step.",
    )
    parser.add_argument(
        "--skip-weather",
        action="store_true",
        help="Skip the weather ingestion step.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch data but do not write anything to the database.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    results = run_pipeline(
        hours=args.hours,
        dry_run=args.dry_run,
        skip_stations=args.skip_stations,
        skip_readings=args.skip_readings,
        skip_weather=args.skip_weather,
    )

    # Exit with code 1 if any step failed (useful for CI/cron alerting)
    if any(r.status == StepStatus.FAILED for r in results):
        sys.exit(1)


if __name__ == "__main__":
    main()
