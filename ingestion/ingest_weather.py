"""
ingest_weather.py — Fetch the last 24 h of hourly weather data from Open-Meteo
and upsert into the Supabase `weather` table.

Open-Meteo is free, open-source, and requires no API key.

Architecture:
  1. Load all stations from Supabase (id + lat + lng).
  2. For each station, call Open-Meteo /v1/forecast with:
       hourly=temperature_2m,wind_speed_10m,relative_humidity_2m
       past_hours=24  forecast_hours=0  timezone=UTC  wind_speed_unit=ms
  3. Zip the parallel arrays into a pandas DataFrame for cleaning
     (drop rows where any of the three values is null).
  4. Batch-INSERT cleaned rows via raw parameterized SQL:
       INSERT INTO weather (...) ON CONFLICT (station_id, timestamp) DO NOTHING
       RETURNING id   ← used to count inserts vs skips without a second query
  5. Log rows fetched / rows inserted / rows skipped (three separate numbers).

Usage:
    # All stations in the database
    python ingestion/ingest_weather.py

    # Single station by its Supabase UUID
    python ingestion/ingest_weather.py --station-id <uuid>

    # Override look-back window (hours, max ≈ 2 weeks on free tier)
    python ingestion/ingest_weather.py --hours 48

    # Preview without writing to DB
    python ingestion/ingest_weather.py --dry-run
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

from db import get_engine  # noqa: E402

# ── logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

# ── constants ─────────────────────────────────────────────────────────────────
OPEN_METEO_URL  = "https://api.open-meteo.com/v1/forecast"
_REQUEST_DELAY_S = 0.1      # Open-Meteo is generous but let's be polite
DEFAULT_HOURS    = 24


# ── Open-Meteo fetch ──────────────────────────────────────────────────────────

def fetch_weather(
    lat: float,
    lng: float,
    hours: int,
    session: requests.Session,
) -> dict:
    """
    Call Open-Meteo and return the raw JSON response dict.

    Key query parameters:
      past_hours     — how many hours of history to include
      forecast_hours — set to 0 so we get no future data
      timezone       — UTC so timestamps need no offset conversion
      wind_speed_unit — ms gives m/s directly (schema stores m/s)

    The `hourly` block contains parallel arrays:
        time[]                  — ISO 8601 strings (no offset, already UTC)
        temperature_2m[]        — °C
        wind_speed_10m[]        — m/s
        relative_humidity_2m[]  — percentage 0-100
    """
    params = {
        "latitude":         lat,
        "longitude":        lng,
        "hourly":           "temperature_2m,wind_speed_10m,relative_humidity_2m",
        "wind_speed_unit":  "ms",
        "timezone":         "UTC",
        "past_hours":       hours,
        "forecast_hours":   0,
    }
    resp = session.get(OPEN_METEO_URL, params=params, timeout=15)
    resp.raise_for_status()
    return resp.json()


# ── DataFrame cleaning ────────────────────────────────────────────────────────

def parse_weather_to_df(
    raw: dict,
    station_id: str,
) -> pd.DataFrame:
    """
    Zip the parallel hourly arrays from Open-Meteo into a tidy DataFrame.

    Open-Meteo returns arrays of equal length:
        hourly.time[i], temperature_2m[i], wind_speed_10m[i], relative_humidity_2m[i]

    Steps:
      1. Zip into rows.
      2. Parse timestamps — they are UTC ISO 8601 without a 'Z' suffix, so we
         append '+00:00' before parsing to ensure tzinfo is set correctly.
      3. Cast numeric columns to float.
      4. Drop any row where timestamp, temperature, wind_speed, or humidity is null
         (all four are NOT NULL in the schema).
      5. Clip humidity to [0, 100] — Open-Meteo can occasionally return 101%.
      6. Deduplicate within this batch on (station_id, timestamp).

    Returns a DataFrame with columns:
        [station_id, timestamp, temperature, wind_speed, humidity]
    """
    _empty = pd.DataFrame(
        columns=["station_id", "timestamp", "temperature", "wind_speed", "humidity"]
    )

    hourly = raw.get("hourly") or {}
    times        = hourly.get("time") or []
    temperatures = hourly.get("temperature_2m") or []
    wind_speeds  = hourly.get("wind_speed_10m") or []
    humidities   = hourly.get("relative_humidity_2m") or []

    if not times:
        return _empty

    # Ensure all arrays are the same length (defensive)
    n = min(len(times), len(temperatures), len(wind_speeds), len(humidities))
    if n == 0:
        return _empty

    df = pd.DataFrame({
        "timestamp_raw": times[:n],
        "temperature":   temperatures[:n],
        "wind_speed":    wind_speeds[:n],
        "humidity":      humidities[:n],
    })

    # ── parse timestamps ─────────────────────────────────────────────────────
    # Open-Meteo returns "2026-06-30T05:00" (no offset) when timezone=UTC.
    # Appending 'Z' makes pd.to_datetime recognise it as UTC-aware.
    df["timestamp"] = pd.to_datetime(
        df["timestamp_raw"].astype(str) + "Z",
        utc=True,
        errors="coerce",
    )

    # ── cast numerics ────────────────────────────────────────────────────────
    for col in ("temperature", "wind_speed", "humidity"):
        df[col] = pd.to_numeric(df[col], errors="coerce")

    # ── drop nulls — all four schema columns are NOT NULL ────────────────────
    before = len(df)
    df = df.dropna(subset=["timestamp", "temperature", "wind_speed", "humidity"])
    dropped = before - len(df)
    if dropped:
        log.debug("Dropped %d rows with nulls.", dropped)

    # ── clip humidity to valid range ─────────────────────────────────────────
    df["humidity"] = df["humidity"].clip(lower=0.0, upper=100.0)

    # ── clip wind_speed to non-negative ──────────────────────────────────────
    df["wind_speed"] = df["wind_speed"].clip(lower=0.0)

    # ── add station metadata ─────────────────────────────────────────────────
    df["station_id"] = station_id

    # ── deduplicate within batch ─────────────────────────────────────────────
    df = df.drop_duplicates(subset=["station_id", "timestamp"], keep="last")

    return df[["station_id", "timestamp", "temperature", "wind_speed", "humidity"]]


# ── database operations ───────────────────────────────────────────────────────

# Raw parameterized SQL — no string interpolation anywhere.
# ON CONFLICT (station_id, timestamp) DO NOTHING matches the
# `uq_weather_station_timestamp` unique constraint in the schema.
# RETURNING id only fires when the INSERT actually succeeds (not on conflict),
# letting us distinguish inserts from skips without a second query.
_INSERT_SQL = text("""
    INSERT INTO weather (station_id, timestamp, temperature, wind_speed, humidity)
    VALUES (:station_id, :timestamp, :temperature, :wind_speed, :humidity)
    ON CONFLICT (station_id, timestamp) DO NOTHING
    RETURNING id
""")


def load_stations(conn) -> list[dict]:
    """
    Return all stations with their lat/lng coordinates.
    Each dict: {id: str, city: str, name: str, latitude: float, longitude: float}
    """
    result = conn.execute(text("""
        SELECT id::text, city, name, latitude::float, longitude::float
        FROM   stations
        ORDER  BY city
    """))
    return [
        {
            "id":        str(row.id),
            "city":      row.city,
            "name":      row.name,
            "latitude":  float(row.latitude),
            "longitude": float(row.longitude),
        }
        for row in result
    ]


def batch_insert_weather(conn, df: pd.DataFrame) -> tuple[int, int]:
    """
    Insert all rows from the DataFrame one by one using the parameterized
    INSERT ... ON CONFLICT DO NOTHING ... RETURNING id pattern.

    Iterating row-by-row (rather than executemany) lets us inspect RETURNING
    per row to accurately tally inserts vs conflict-skips.

    Returns (inserted_count, skipped_count).
    """
    if df.empty:
        return 0, 0

    inserted = 0
    for row in df.itertuples(index=False):
        result = conn.execute(
            _INSERT_SQL,
            {
                "station_id":  row.station_id,
                "timestamp":   row.timestamp.to_pydatetime(),
                "temperature": round(float(row.temperature), 2),
                "wind_speed":  round(float(row.wind_speed), 2),
                "humidity":    round(float(row.humidity), 2),
            },
        )
        # RETURNING id emits a row only when the INSERT was not suppressed
        if result.fetchone() is not None:
            inserted += 1

    skipped = len(df) - inserted
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
    Full pipeline for one station. Returns (fetched, inserted, skipped).
    """
    station_id = station["id"]
    city       = station["city"]

    # 1. Fetch from Open-Meteo
    try:
        raw = fetch_weather(station["latitude"], station["longitude"], hours, session)
        time.sleep(_REQUEST_DELAY_S)
    except requests.HTTPError as exc:
        log.error("[%s] Open-Meteo HTTP error: %s", city, exc)
        return 0, 0, 0
    except requests.RequestException as exc:
        log.error("[%s] Network error: %s", city, exc)
        return 0, 0, 0

    # 2. Parse + clean with pandas
    df = parse_weather_to_df(raw, station_id)
    fetched = len(df)

    if dry_run:
        log.info("[%s] DRY RUN — would insert %d rows.", city, fetched)
        return fetched, 0, 0

    if df.empty:
        log.info("[%s] No clean rows to insert.", city)
        return 0, 0, 0

    # 3. Batch INSERT via raw parameterized SQL
    inserted, skipped = batch_insert_weather(conn, df)
    return fetched, inserted, skipped


def run(
    hours: int,
    dry_run: bool,
    filter_station_id: Optional[str],
) -> None:
    session = requests.Session()
    session.headers.update({"Accept": "application/json"})

    engine = get_engine()

    # ── Load stations ──────────────────────────────────────────────────────────
    with engine.connect() as read_conn:
        all_stations = load_stations(read_conn)

    if not all_stations:
        log.error("No stations found. Run setup_stations.py first.")
        sys.exit(1)

    if filter_station_id:
        stations = [s for s in all_stations if s["id"] == filter_station_id]
        if not stations:
            log.error("No station with id=%s found.", filter_station_id)
            sys.exit(1)
    else:
        stations = all_stations

    log.info("Processing %d station(s) — last %d h of weather.", len(stations), hours)

    total_fetched  = 0
    total_inserted = 0
    total_skipped  = 0

    # ── Single transaction covers all stations ────────────────────────────────
    with engine.begin() as conn:
        for station in stations:
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

            if not dry_run and fetched > 0:
                log.info(
                    "[%s]  fetched=%d  inserted=%d  skipped(duplicate)=%d",
                    station["city"], fetched, inserted, skipped,
                )

    # ── Summary — three numbers, separately ───────────────────────────────────
    log.info("=" * 60)
    log.info("SUMMARY  stations=%d  hours=%d", len(stations), hours)
    log.info("  Rows fetched from Open-Meteo : %d", total_fetched)
    log.info("  Rows inserted into DB        : %d", total_inserted)
    log.info("  Rows skipped (duplicate)     : %d", total_skipped)
    log.info("=" * 60)


# ── CLI ───────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Ingest hourly weather data from Open-Meteo into the weather table.",
    )
    parser.add_argument(
        "--hours",
        type=int,
        default=DEFAULT_HOURS,
        metavar="N",
        help=f"Hours of history to fetch (default: {DEFAULT_HOURS}).",
    )
    parser.add_argument(
        "--station-id",
        metavar="UUID",
        help="Process only the station with this Supabase UUID.",
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
        filter_station_id=args.station_id,
    )


if __name__ == "__main__":
    main()
