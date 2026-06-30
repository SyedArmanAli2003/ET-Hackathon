"""
ingest_readings.py — Fetch the last 24 h of AQI/PM2.5 readings from OpenAQ v3
and upsert them into the Supabase `readings` table.

Architecture:
  1. Load all stations from Supabase (id + external_id).
  2. For each station, fetch the location's sensor list from OpenAQ and find the
     PM2.5 sensor.
  3. Call /v3/sensors/{sensor_id}/measurements for the last 24 h.
  4. Load results into a pandas DataFrame for cleaning (drop nulls, cast types).
  5. Derive AQI from PM2.5 concentration using US EPA breakpoints.
  6. Batch-INSERT cleaned rows via raw parameterized SQL:
       INSERT INTO readings (...) VALUES ... ON CONFLICT (station_id, timestamp) DO NOTHING
  7. Log rows fetched, rows inserted, and rows skipped as duplicates — separately.

Usage:
    # All stations from the database
    python ingestion/ingest_readings.py

    # Single station by external_id (OpenAQ location id)
    python ingestion/ingest_readings.py --external-id 17

    # Override look-back window (hours)
    python ingestion/ingest_readings.py --hours 48

    # Preview without writing to DB
    python ingestion/ingest_readings.py --dry-run
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from datetime import datetime, timezone, timedelta
from typing import Optional

import pandas as pd
import requests
from dotenv import load_dotenv
from sqlalchemy import text

# ── path setup ────────────────────────────────────────────────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

load_dotenv(dotenv_path=os.path.join(_HERE, ".env"))
load_dotenv()

from config import DATA_SOURCE_LABEL  # noqa: E402
from db import get_engine             # noqa: E402

# ── logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# ── constants ─────────────────────────────────────────────────────────────────
OPENAQ_BASE_URL     = "https://api.openaq.org/v3"
_REQUEST_DELAY_S    = 0.15      # polite gap between API calls (free tier: 10 req/s)
_PAGE_LIMIT         = 1000      # max measurements per API page
DEFAULT_HOURS       = 24

# ── AQI calculation (US EPA PM2.5 breakpoints) ───────────────────────────────
# Table: (C_low, C_high, I_low, I_high)
_PM25_BREAKPOINTS = [
    (0.0,   12.0,    0,   50),
    (12.1,  35.4,   51,  100),
    (35.5,  55.4,  101,  150),
    (55.5, 150.4,  151,  200),
    (150.5, 250.4, 201,  300),
    (250.5, 350.4, 301,  400),
    (350.5, 500.4, 401,  500),
]


def pm25_to_aqi(pm25: float) -> Optional[float]:
    """
    Convert a PM2.5 concentration (µg/m³) to a US EPA AQI value.
    Returns None if the value is outside the defined breakpoints.
    Formula: AQI = ((I_high - I_low) / (C_high - C_low)) * (C - C_low) + I_low
    """
    if pm25 < 0:
        return None
    for c_low, c_high, i_low, i_high in _PM25_BREAKPOINTS:
        if c_low <= pm25 <= c_high:
            aqi = (i_high - i_low) / (c_high - c_low) * (pm25 - c_low) + i_low
            return round(aqi, 2)
    # Above 500.4 µg/m³ — beyond AQI scale; cap at 500
    if pm25 > 500.4:
        return 500.0
    return None


# ── OpenAQ helpers ────────────────────────────────────────────────────────────

def _openaq_headers() -> dict[str, str]:
    headers = {"Accept": "application/json"}
    api_key = os.getenv("OPENAQ_API_KEY", "").strip()
    if api_key and not api_key.startswith("your_"):
        headers["X-API-Key"] = api_key
    else:
        log.warning("OPENAQ_API_KEY missing or placeholder — unauthenticated rate limits apply.")
    return headers


def fetch_location_sensors(
    external_id: str,
    session: requests.Session,
) -> list[dict]:
    """
    GET /v3/locations/{id}/sensors
    Returns the list of sensor dicts for a location.
    """
    url = f"{OPENAQ_BASE_URL}/locations/{external_id}/sensors"
    resp = session.get(url, timeout=15)
    resp.raise_for_status()
    return resp.json().get("results", [])


def find_pm25_sensor_id(sensors: list[dict]) -> Optional[str]:
    """
    Find the sensor whose parameter name is 'pm25'.
    Returns the sensor id as a string, or None if not found.
    """
    for sensor in sensors:
        param = sensor.get("parameter") or {}
        name = (param.get("name") or "").lower()
        if name == "pm25":
            return str(sensor["id"])
    return None


def fetch_measurements(
    sensor_id: str,
    hours: int,
    session: requests.Session,
) -> list[dict]:
    """
    GET /v3/sensors/{sensor_id}/measurements
    Fetches up to _PAGE_LIMIT measurements from the last `hours` hours.

    OpenAQ v3 measurement objects use a `period` wrapper:
      period.datetimeTo.utc   — end of the measurement window (= observation time)
      period.datetimeFrom.utc — start of the measurement window
    The top-level `datetime` key does NOT exist in v3 measurements.

    Returns the raw result list.
    """
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    until = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    url = f"{OPENAQ_BASE_URL}/sensors/{sensor_id}/measurements"
    params = {
        "datetime_from": since,
        "datetime_to":   until,
        "limit": _PAGE_LIMIT,
    }
    resp = session.get(url, params=params, timeout=15)
    resp.raise_for_status()
    return resp.json().get("results", [])


# ── DataFrame cleaning ────────────────────────────────────────────────────────

def parse_measurements_to_df(
    raw: list[dict],
    station_id: str,
) -> pd.DataFrame:
    """
    Load raw OpenAQ v3 measurement dicts into a pandas DataFrame, then:
    - Extract the UTC timestamp from period.datetimeTo.utc
      (v3 wraps measurement timing inside a `period` object; there is NO
       top-level `datetime` key on measurements — that only exists on sensors)
    - Parse it to a timezone-aware datetime
    - Cast value (PM2.5 concentration µg/m³) to float
    - Drop rows with null timestamps or null PM2.5 values
    - Drop duplicate (station_id, timestamp) pairs within this batch
    Returns a clean DataFrame with columns:
        [station_id, timestamp, pm25, aqi, data_source]
    """
    if not raw:
        return pd.DataFrame(columns=["station_id", "timestamp", "pm25", "aqi", "data_source"])

    rows = []
    for m in raw:
        # v3 structure: m["period"]["datetimeTo"]["utc"] is the observation timestamp
        period   = m.get("period") or {}
        dt_to    = period.get("datetimeTo") or {}
        utc_str  = dt_to.get("utc") if isinstance(dt_to, dict) else None
        value    = m.get("value")
        rows.append({"timestamp_raw": utc_str, "pm25_raw": value})

    df = pd.DataFrame(rows)

    # ── parse timestamp ──────────────────────────────────────────────────────
    df["timestamp"] = pd.to_datetime(df["timestamp_raw"], utc=True, errors="coerce")

    # ── parse pm25 ───────────────────────────────────────────────────────────
    df["pm25"] = pd.to_numeric(df["pm25_raw"], errors="coerce")

    # ── drop nulls ───────────────────────────────────────────────────────────
    before_drop = len(df)
    df = df.dropna(subset=["timestamp", "pm25"])
    dropped = before_drop - len(df)
    if dropped:
        log.debug("Dropped %d rows with null timestamp or pm25.", dropped)

    # ── drop negative concentrations (sensor error) ──────────────────────────
    df = df[df["pm25"] >= 0]

    # ── derive AQI ───────────────────────────────────────────────────────────
    df["aqi"] = df["pm25"].apply(pm25_to_aqi)
    # Drop rows where PM2.5 could not be converted to AQI (shouldn't happen often)
    df = df.dropna(subset=["aqi"])

    # ── add metadata ─────────────────────────────────────────────────────────
    df["station_id"]  = station_id
    df["data_source"] = DATA_SOURCE_LABEL

    # ── deduplicate within batch ──────────────────────────────────────────────
    df = df.drop_duplicates(subset=["station_id", "timestamp"], keep="last")

    return df[["station_id", "timestamp", "pm25", "aqi", "data_source"]]


# ── database operations ───────────────────────────────────────────────────────

# All values bound via :param — no string interpolation.
# ON CONFLICT (station_id, timestamp) DO NOTHING means:
#   - Postgres silently discards any row that already exists for this station+time.
#   - The RETURNING clause only fires for rows that were actually inserted.
_INSERT_SQL = text("""
    INSERT INTO readings (station_id, timestamp, aqi, pm25, data_source)
    VALUES (:station_id, :timestamp, :aqi, :pm25, :data_source)
    ON CONFLICT (station_id, timestamp) DO NOTHING
    RETURNING id
""")


def load_stations(conn) -> list[dict]:
    """
    Return all stations that have an external_id (i.e., linked to OpenAQ).
    Each dict: {id: UUID-str, external_id: str}
    """
    result = conn.execute(text("""
        SELECT id::text, external_id
        FROM   stations
        WHERE  external_id IS NOT NULL
        ORDER  BY city
    """))
    return [{"id": str(row.id), "external_id": row.external_id} for row in result]


def batch_insert_readings(
    conn,
    df: pd.DataFrame,
) -> tuple[int, int]:
    """
    Insert all rows from the DataFrame into `readings` in a single batch using
    executemany-style execution (SQLAlchemy passes the list as separate params,
    not as a single multi-value SQL string).

    Returns (inserted_count, skipped_count).
    - inserted_count: rows where RETURNING id came back (new row written)
    - skipped_count:  rows where ON CONFLICT DO NOTHING suppressed the insert
    """
    if df.empty:
        return 0, 0

    records = [
        {
            "station_id":  row.station_id,
            # Convert pandas Timestamp → Python datetime with UTC tzinfo
            "timestamp":   row.timestamp.to_pydatetime(),
            "aqi":         float(row.aqi),
            "pm25":        float(row.pm25),
            "data_source": row.data_source,
        }
        for row in df.itertuples(index=False)
    ]

    inserted = 0
    for record in records:
        result = conn.execute(_INSERT_SQL, record)
        # RETURNING only emits a row when the INSERT actually happened
        if result.fetchone() is not None:
            inserted += 1

    skipped = len(records) - inserted
    return inserted, skipped


# ── orchestration ─────────────────────────────────────────────────────────────

def process_station(
    station: dict,
    hours: int,
    session: requests.Session,
    dry_run: bool,
    conn,
) -> tuple[int, int, int]:
    """
    Full pipeline for one station.
    Returns (fetched, inserted, skipped).
    """
    ext_id      = station["external_id"]
    station_id  = station["id"]

    # 1. Get sensors for this OpenAQ location
    try:
        sensors = fetch_location_sensors(ext_id, session)
        time.sleep(_REQUEST_DELAY_S)
    except requests.HTTPError as exc:
        log.error("[%s] Failed to fetch sensors: %s", ext_id, exc)
        return 0, 0, 0

    # 2. Find the PM2.5 sensor
    pm25_sensor_id = find_pm25_sensor_id(sensors)
    if not pm25_sensor_id:
        log.warning("[%s] No PM2.5 sensor found — skipping station.", ext_id)
        return 0, 0, 0

    # 3. Fetch measurements
    try:
        raw = fetch_measurements(pm25_sensor_id, hours, session)
        time.sleep(_REQUEST_DELAY_S)
    except requests.HTTPError as exc:
        log.error("[%s] Failed to fetch measurements (sensor %s): %s", ext_id, pm25_sensor_id, exc)
        return 0, 0, 0

    fetched = len(raw)

    # 4. Clean with pandas
    df = parse_measurements_to_df(raw, station_id)
    cleaned = len(df)

    log.debug("[%s] Fetched %d raw → %d after cleaning.", ext_id, fetched, cleaned)

    if dry_run:
        log.info("[%s] DRY RUN — would insert %d rows (fetched=%d).", ext_id, cleaned, fetched)
        return fetched, 0, 0

    if df.empty:
        log.info("[%s] No clean rows to insert.", ext_id)
        return fetched, 0, 0

    # 5. Batch insert
    inserted, skipped = batch_insert_readings(conn, df)
    return fetched, inserted, skipped


def run(
    hours: int,
    dry_run: bool,
    filter_external_id: Optional[str],
) -> None:
    session = requests.Session()
    session.headers.update(_openaq_headers())

    engine = get_engine()

    # ── Load stations from DB ─────────────────────────────────────────────────
    with engine.connect() as read_conn:
        all_stations = load_stations(read_conn)

    if not all_stations:
        log.error("No stations with external_id found in the database. Run setup_stations.py first.")
        sys.exit(1)

    if filter_external_id:
        stations = [s for s in all_stations if s["external_id"] == filter_external_id]
        if not stations:
            log.error("No station with external_id=%s found in the database.", filter_external_id)
            sys.exit(1)
    else:
        stations = all_stations

    log.info("Processing %d station(s) — last %d h of readings.", len(stations), hours)

    # Aggregate totals across all stations
    total_fetched  = 0
    total_inserted = 0
    total_skipped  = 0

    # ── Write transaction (one transaction covers all stations) ───────────────
    with engine.begin() as conn:
        for station in stations:
            ext_id = station["external_id"]
            fetched, inserted, skipped = process_station(
                station=station,
                hours=hours,
                session=session,
                dry_run=dry_run,
                conn=conn,
            )

            total_fetched  += fetched
            total_inserted += inserted
            total_skipped  += skipped

            if not dry_run:
                log.info(
                    "[%s]  fetched=%d  inserted=%d  skipped(duplicate)=%d",
                    ext_id, fetched, inserted, skipped,
                )

    # ── Final summary — three numbers, separately ─────────────────────────────
    log.info("=" * 60)
    log.info("SUMMARY  stations=%d  hours=%d", len(stations), hours)
    log.info("  Rows fetched from OpenAQ  : %d", total_fetched)
    log.info("  Rows inserted into DB     : %d", total_inserted)
    log.info("  Rows skipped (duplicate)  : %d", total_skipped)
    log.info("=" * 60)


# ── CLI ───────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Ingest PM2.5 readings from OpenAQ into the readings table.",
    )
    parser.add_argument(
        "--hours",
        type=int,
        default=DEFAULT_HOURS,
        metavar="N",
        help=f"How many hours of history to fetch (default: {DEFAULT_HOURS}).",
    )
    parser.add_argument(
        "--external-id",
        metavar="ID",
        help="Process only the station with this OpenAQ external_id.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch and clean data but do not write to the database.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    run(
        hours=args.hours,
        dry_run=args.dry_run,
        filter_external_id=args.external_id,
    )


if __name__ == "__main__":
    main()
