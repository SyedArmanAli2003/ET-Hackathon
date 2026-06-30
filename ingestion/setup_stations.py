"""
setup_stations.py — Seed / sync the `stations` table from OpenAQ v3.

For each city in config.TRACKED_CITIES:
  1. Queries the OpenAQ v3 /locations endpoint (radius search around lat/lng).
  2. Picks the best location (most sensors, most recent measurement, active only).
  3. Upserts into `stations` via raw parameterized SQL:
       INSERT ... ON CONFLICT (external_id) WHERE external_id IS NOT NULL
       DO UPDATE SET name=..., city=..., latitude=..., longitude=...
       RETURNING id, (xmax = 0) AS was_inserted
  4. Logs how many rows were newly inserted vs updated.

Usage:
    # All cities
    python ingestion/setup_stations.py

    # Single city (case-insensitive)
    python ingestion/setup_stations.py --city Delhi

    # Preview without writing to the database
    python ingestion/setup_stations.py --dry-run

    # Widen the search radius (km) if a city has no results
    python ingestion/setup_stations.py --radius 50
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from dataclasses import dataclass
from typing import Optional

import requests
from dotenv import load_dotenv
from sqlalchemy import text

# ── resolve paths so the script can be run from any cwd ─────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

load_dotenv(dotenv_path=os.path.join(_HERE, ".env"))
load_dotenv()  # project-root fallback

from config import (  # noqa: E402  (imports after path manipulation)
    ALL_CITY_NAMES,
    DATA_SOURCE_LABEL,
    OPENAQ_RADIUS_KM,
    TRACKED_CITIES,
    get_city,
)
from db import get_engine  # noqa: E402

# ── logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# ── constants ────────────────────────────────────────────────────────────────
OPENAQ_BASE_URL = "https://api.openaq.org/v3"
OPENAQ_LOCATIONS_URL = f"{OPENAQ_BASE_URL}/locations"
# Respect OpenAQ rate limits: 10 req/s on free tier — 120 ms gap is safe
_REQUEST_DELAY_S = 0.15
_MAX_RESULTS_PER_CITY = 100  # OpenAQ max per page


# ── data model (plain dataclass — no ORM) ────────────────────────────────────
@dataclass
class StationRecord:
    external_id: str       # OpenAQ location id (str-cast of the integer id)
    city: str              # our tracked city name
    name: str              # OpenAQ station name
    latitude: float
    longitude: float


# ── OpenAQ helpers ───────────────────────────────────────────────────────────

def _openaq_headers() -> dict[str, str]:
    """Build request headers; include API key when provided."""
    headers = {"Accept": "application/json"}
    api_key = os.getenv("OPENAQ_API_KEY", "").strip()
    if api_key and not api_key.startswith("your_"):
        headers["X-API-Key"] = api_key
    else:
        log.warning(
            "OPENAQ_API_KEY not set or is still the placeholder value. "
            "Requests will be rate-limited to the unauthenticated tier."
        )
    return headers


def fetch_openaq_locations(
    lat: float,
    lng: float,
    radius_km: int,
    session: requests.Session,
) -> list[dict]:
    """
    Call GET /v3/locations?coordinates=lat,lng&radius=<meters>&limit=...
    Returns the raw list of location dicts from the `results` field.
    Raises requests.HTTPError on non-2xx responses.
    """
    radius_m = radius_km * 1000
    params = {
        "coordinates": f"{lat},{lng}",
        "radius": radius_m,
        "limit": _MAX_RESULTS_PER_CITY,
    }
    response = session.get(
        OPENAQ_LOCATIONS_URL,
        params=params,
        timeout=15,
    )
    response.raise_for_status()
    payload = response.json()
    return payload.get("results", [])


def _score_location(loc: dict) -> tuple:
    """
    Return a sort key (higher = better) so we can pick the best location
    for a city when multiple exist within the search radius.

    Priority:
      1. Active sensors (has sensors list)
      2. More sensors → more parameters measured
      3. Most recent measurement datetime (datetimeLast.utc)
    """
    sensors = loc.get("sensors") or []
    sensor_count = len(sensors)

    # datetimeLast may be a dict {"utc": "...", "local": "..."} or None
    datetime_last = loc.get("datetimeLast") or {}
    last_utc = datetime_last.get("utc") or ""  # ISO string sorts lexicographically

    return (sensor_count, last_utc)


def pick_best_location(
    locations: list[dict],
    city_name: str,
) -> Optional[StationRecord]:
    """
    From a list of OpenAQ location dicts, select the single best one for
    the given city and return a StationRecord, or None if list is empty.
    """
    if not locations:
        log.warning("[%s] No OpenAQ locations found within search radius.", city_name)
        return None

    best = max(locations, key=_score_location)

    coords = best.get("coordinates") or {}
    lat = coords.get("latitude")
    lng = coords.get("longitude")

    if lat is None or lng is None:
        log.warning(
            "[%s] Best location id=%s has no coordinates — skipping.",
            city_name,
            best.get("id"),
        )
        return None

    # OpenAQ location id is an integer; store as string for external_id TEXT column
    external_id = str(best["id"])
    name = (best.get("name") or "").strip() or f"OpenAQ-{external_id}"

    return StationRecord(
        external_id=external_id,
        city=city_name,
        name=name,
        latitude=float(lat),
        longitude=float(lng),
    )


# ── upsert SQL ───────────────────────────────────────────────────────────────

# All values are passed as bound parameters (:param_name).
# `xmax = 0` is a Postgres internal column:
#   - For a freshly inserted row → xmax = 0  → was_inserted = TRUE
#   - For a row reached via DO UPDATE path → xmax = previous txid → was_inserted = FALSE
# This lets us count inserts vs updates from the RETURNING clause in one query.
_UPSERT_SQL = text("""
    INSERT INTO stations (external_id, city, name, latitude, longitude)
    VALUES (:external_id, :city, :name, :latitude, :longitude)
    ON CONFLICT (external_id) WHERE external_id IS NOT NULL
    DO UPDATE SET
        name      = EXCLUDED.name,
        city      = EXCLUDED.city,
        latitude  = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude
    RETURNING id, (xmax = 0) AS was_inserted
""")


def upsert_station(conn, record: StationRecord) -> bool:
    """
    Execute the upsert for a single StationRecord using a bound-parameter
    SQLAlchemy text query. Returns True if the row was inserted, False if updated.

    Never constructs SQL by string formatting — all values go through
    SQLAlchemy's bound-parameter mechanism, which passes them to psycopg2
    as separate protocol-level parameters (not interpolated into the query text).
    """
    result = conn.execute(
        _UPSERT_SQL,
        {
            "external_id": record.external_id,
            "city": record.city,
            "name": record.name,
            "latitude": record.latitude,
            "longitude": record.longitude,
        },
    )
    row = result.fetchone()
    return bool(row.was_inserted) if row else False


# ── orchestration ─────────────────────────────────────────────────────────────

def process_cities(
    cities: list[dict],
    radius_km: int,
    dry_run: bool,
) -> None:
    """
    Main loop: fetch OpenAQ locations for each city, pick the best one,
    and upsert into the stations table. Logs a per-city summary and a final
    aggregate count of inserts vs updates.
    """
    session = requests.Session()
    session.headers.update(_openaq_headers())

    records: list[StationRecord] = []

    # ── Phase 1: fetch from OpenAQ ────────────────────────────────────────────
    log.info("Fetching OpenAQ locations for %d cities (radius=%d km)…", len(cities), radius_km)

    for city_cfg in cities:
        city_name = city_cfg["name"]
        try:
            raw_locations = fetch_openaq_locations(
                lat=city_cfg["lat"],
                lng=city_cfg["lng"],
                radius_km=radius_km,
                session=session,
            )
            log.debug("[%s] OpenAQ returned %d candidate locations.", city_name, len(raw_locations))

            record = pick_best_location(raw_locations, city_name)
            if record:
                records.append(record)
                log.info(
                    "[%s] ✓  Selected: id=%s  name=%r  lat=%.4f  lng=%.4f",
                    city_name,
                    record.external_id,
                    record.name,
                    record.latitude,
                    record.longitude,
                )
            else:
                log.warning("[%s] ✗  No suitable location found — city will be skipped.", city_name)

        except requests.HTTPError as exc:
            log.error("[%s] OpenAQ HTTP error: %s", city_name, exc)
        except requests.RequestException as exc:
            log.error("[%s] Network error: %s", city_name, exc)

        # Polite delay between API calls
        time.sleep(_REQUEST_DELAY_S)

    if not records:
        log.error("No records to upsert. Exiting.")
        sys.exit(1)

    log.info("Fetched %d station records to upsert.", len(records))

    if dry_run:
        log.info("── DRY RUN — no database writes ──────────────────────────────")
        for r in records:
            log.info("  Would upsert: external_id=%s  city=%s  name=%r", r.external_id, r.city, r.name)
        return

    # ── Phase 2: upsert into Supabase ─────────────────────────────────────────
    inserted = 0
    updated = 0

    engine = get_engine()
    with engine.begin() as conn:   # begin() auto-commits on exit, rolls back on exception
        for record in records:
            try:
                was_inserted = upsert_station(conn, record)
                if was_inserted:
                    inserted += 1
                    log.info("[%s] ← INSERTED  external_id=%s", record.city, record.external_id)
                else:
                    updated += 1
                    log.info("[%s] ↻ UPDATED   external_id=%s", record.city, record.external_id)
            except Exception as exc:
                log.error("[%s] Upsert failed: %s", record.city, exc)
                raise  # re-raise to trigger rollback of the whole transaction

    # ── Summary ───────────────────────────────────────────────────────────────
    log.info(
        "Done. %d inserted, %d updated, %d skipped (no OpenAQ location found).",
        inserted,
        updated,
        len(cities) - len(records),
    )


# ── CLI entry point ───────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Seed the stations table from OpenAQ v3.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"Available cities:\n  {chr(10)+'  '.join(ALL_CITY_NAMES)}",
    )
    parser.add_argument(
        "--city",
        metavar="NAME",
        help="Process a single city by name instead of all tracked cities.",
    )
    parser.add_argument(
        "--radius",
        type=int,
        default=OPENAQ_RADIUS_KM,
        metavar="KM",
        help=f"Search radius in km (default: {OPENAQ_RADIUS_KM}).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch from OpenAQ but do not write to the database.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.city:
        try:
            cities = [get_city(args.city)]
        except ValueError as exc:
            log.error("%s", exc)
            sys.exit(1)
    else:
        cities = TRACKED_CITIES

    process_cities(
        cities=cities,
        radius_km=args.radius,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()
