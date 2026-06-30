"""
model/features.py — Feature engineering for AQI forecasting.

Entrypoint
----------
    build_features(readings, weather) -> pd.DataFrame

Input DataFrames (from ingestion/explore_data.py or direct DB load):
    readings  columns: station_id, city, timestamp (UTC-aware), aqi, pm25, data_source
    weather   columns: station_id, city, timestamp (UTC-aware), temperature, wind_speed, humidity

Output columns added:
    temperature, wind_speed, humidity   — nearest-hour weather joined via merge_asof
    aqi_lag_1h                          — AQI ~1 h ago (per station, time-based)
    aqi_lag_6h                          — AQI ~6 h ago
    aqi_lag_24h                         — AQI ~24 h ago
    aqi_roll24h                         — rolling 24-hour mean AQI (per station)
    hour_of_day                         — 0-23 UTC hour
    day_of_week                         — 0=Monday … 6=Sunday

Lag strategy
------------
Readings arrive at irregular intervals (15 min for most stations, up to 78 min for
sparse ones). Row-based shift(N) would be meaningless: shift(4) means "4 readings
ago", not "1 hour ago". Instead we use pd.merge_asof with direction='backward' and
a per-lag tolerance window:

    lag 1h  → tolerance ±45 min  (catches 15-min and 30-min reporters)
    lag 6h  → tolerance ±45 min
    lag 24h → tolerance ±90 min  (wider window for sparse stations like Nagpur/Guwahati)

If no observation falls within the tolerance window the lag is NaN, which is the
correct ML signal (data gap) rather than a fabricated value.

Weather join
------------
Weather is hourly. Readings timestamps are irregular sub-hourly. We join with
merge_asof direction='nearest', tolerance=60 min, so each reading gets the
weather observation whose hour is closest to its own timestamp.

Usage
-----
    # Import and use directly
    from model.features import build_features

    # Or run as a script for a sanity-check printout
    python model/features.py
    python model/features.py --station Delhi --rows 20
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import pandas as pd

# ── path setup so this file works both as a module and as a standalone script
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT / "ingestion"))

from dotenv import load_dotenv
load_dotenv(dotenv_path=_ROOT / "ingestion" / ".env")
load_dotenv()

from sqlalchemy import text


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def build_features(
    readings: pd.DataFrame,
    weather: pd.DataFrame,
) -> pd.DataFrame:
    """
    Join readings with weather and engineer time-series features.

    Parameters
    ----------
    readings : DataFrame
        Must have columns: station_id, city, timestamp (UTC-aware), aqi, pm25
    weather : DataFrame
        Must have columns: station_id, timestamp (UTC-aware), temperature, wind_speed, humidity

    Returns
    -------
    DataFrame with all original readings columns plus the engineered features.
    Rows are sorted by (city, timestamp).
    """
    _validate(readings, ["station_id", "city", "timestamp", "aqi"])
    _validate(weather, ["station_id", "timestamp", "temperature", "wind_speed", "humidity"])

    df = readings.copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)

    # ── 1. Join nearest weather observation ──────────────────────────────────
    df = _join_weather(df, weather)

    # ── 2. Sort — required before any lag / rolling operation ────────────────
    df = df.sort_values(["station_id", "timestamp"]).reset_index(drop=True)

    # ── 3. Lag features (time-based, per station) ────────────────────────────
    df = _add_lag(df, lag_hours=1,  new_col="aqi_lag_1h",  tolerance_min=45)
    df = _add_lag(df, lag_hours=6,  new_col="aqi_lag_6h",  tolerance_min=45)
    df = _add_lag(df, lag_hours=24, new_col="aqi_lag_24h", tolerance_min=90)

    # ── 4. Rolling 24-hour mean AQI (per station) ────────────────────────────
    df = _add_rolling_mean(df, col="aqi", window="24h", new_col="aqi_roll24h")

    # ── 5. Calendar features ─────────────────────────────────────────────────
    df["hour_of_day"]  = df["timestamp"].dt.hour.astype("int8")
    df["day_of_week"]  = df["timestamp"].dt.dayofweek.astype("int8")  # 0=Mon

    # ── 6. Final sort by (city, timestamp) for readability ───────────────────
    df = df.sort_values(["city", "timestamp"]).reset_index(drop=True)

    return df


# ─────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ─────────────────────────────────────────────────────────────────────────────

def _validate(df: pd.DataFrame, required: list[str]) -> None:
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"DataFrame is missing columns: {missing}")


def _join_weather(df: pd.DataFrame, weather: pd.DataFrame) -> pd.DataFrame:
    """
    Left-join each reading to the nearest weather observation within ±60 min.

    Strategy: merge_asof with direction='nearest' and by='station_id' matches
    each reading's timestamp to the closest hourly weather timestamp for the
    same station.  Readings for stations that have no weather rows (e.g.
    if a station was added to readings but not yet to weather) get NaN weather
    columns — this is correct and safe.
    """
    weather_cols = weather[["station_id", "timestamp", "temperature", "wind_speed", "humidity"]].copy()
    weather_cols["timestamp"] = pd.to_datetime(weather_cols["timestamp"], utc=True)

    # merge_asof requires both sides sorted on the key column
    df_sorted  = df.sort_values("timestamp")
    wx_sorted  = weather_cols.sort_values("timestamp")

    merged = pd.merge_asof(
        df_sorted,
        wx_sorted,
        on="timestamp",
        by="station_id",
        direction="nearest",
        tolerance=pd.Timedelta("60min"),
        suffixes=("", "_wx"),      # avoid column name collision
    )
    return merged


def _add_lag(
    df: pd.DataFrame,
    lag_hours: int,
    new_col: str,
    tolerance_min: int,
) -> pd.DataFrame:
    """
    For each row, find the AQI value at (timestamp − lag_hours) within ±tolerance_min.

    Implementation detail
    ---------------------
    We build a "lookup" copy of the AQI column whose timestamps have been
    shifted FORWARD by the lag.  merge_asof with direction='backward' then
    matches each original timestamp to the closest shifted timestamp that is
    ≤ the original timestamp — which is equivalent to "closest to lag hours
    ago", with a tolerance cap.

    We loop per station so that observations from other stations are never
    accidentally used to fill a lag.
    """
    lag = pd.Timedelta(hours=lag_hours)
    tol = pd.Timedelta(minutes=tolerance_min)
    parts: list[pd.DataFrame] = []

    for _sid, grp in df.groupby("station_id", sort=False):
        grp = grp.sort_values("timestamp").copy()

        # Lookup: timestamps shifted forward by `lag` so that merge_asof
        # backward-search finds the value that was lag hours before each row.
        lookup = (
            grp[["timestamp", "aqi"]]
            .copy()
            .rename(columns={"aqi": new_col})
        )
        lookup["timestamp"] = lookup["timestamp"] + lag

        merged = pd.merge_asof(
            grp,
            lookup,
            on="timestamp",
            direction="backward",
            tolerance=tol,
        )
        parts.append(merged)

    result = pd.concat(parts, ignore_index=True)
    result[new_col] = result[new_col].astype("float64")
    return result


def _add_rolling_mean(
    df: pd.DataFrame,
    col: str,
    window: str,
    new_col: str,
) -> pd.DataFrame:
    """
    Compute a time-window rolling mean of `col` per station, using the
    timestamp as the index.

    We loop per station and write results back via the original positional
    index so the assignment is always aligned correctly.
    """
    df = df.sort_values(["station_id", "timestamp"]).reset_index(drop=True)
    roll_values = pd.Series(index=df.index, dtype="float64")

    for _sid, grp in df.groupby("station_id", sort=False):
        rolled = (
            grp.set_index("timestamp")[col]
            .rolling(window, min_periods=1)
            .mean()
        )
        roll_values.loc[grp.index] = rolled.values

    df[new_col] = roll_values
    return df


# ─────────────────────────────────────────────────────────────────────────────
# DB loaders (same queries as explore_data.py, kept local so this file is
# self-contained when run as a script)
# ─────────────────────────────────────────────────────────────────────────────

def _load_readings(engine) -> pd.DataFrame:
    q = """
        SELECT r.station_id::text, s.city,
               r.timestamp AT TIME ZONE 'UTC' AS timestamp,
               r.aqi::float, r.pm25::float, r.data_source
        FROM readings r
        JOIN stations s ON s.id = r.station_id
        ORDER BY s.city, r.timestamp
    """
    with engine.connect() as conn:
        df = pd.read_sql(text(q), conn)
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    return df


def _load_weather(engine) -> pd.DataFrame:
    q = """
        SELECT w.station_id::text, s.city,
               w.timestamp AT TIME ZONE 'UTC' AS timestamp,
               w.temperature::float, w.wind_speed::float, w.humidity::float
        FROM weather w
        JOIN stations s ON s.id = w.station_id
        ORDER BY s.city, w.timestamp
    """
    with engine.connect() as conn:
        df = pd.read_sql(text(q), conn)
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    return df


# ─────────────────────────────────────────────────────────────────────────────
# Sanity-check printout
# ─────────────────────────────────────────────────────────────────────────────

def _print_sanity_check(df: pd.DataFrame, station: str | None, n_rows: int) -> None:
    """Pretty-print the first n_rows rows for visual inspection."""
    if station:
        subset = df[df["city"].str.lower() == station.lower()]
        if subset.empty:
            print(f"  No rows found for station '{station}'. Available: {sorted(df['city'].unique())}")
            return
    else:
        # Pick the station with the most complete lag coverage (fewest NaNs)
        lag_cols = ["aqi_lag_1h", "aqi_lag_6h", "aqi_lag_24h"]
        completeness = df.groupby("city")[lag_cols].apply(lambda g: g.notna().mean().mean())
        best_city = completeness.idxmax()
        subset = df[df["city"] == best_city]
        print(f"  (Auto-selected station with best lag coverage: {best_city})")

    display_cols = [
        "city", "timestamp",
        "aqi", "pm25",
        "temperature", "wind_speed", "humidity",
        "aqi_lag_1h", "aqi_lag_6h", "aqi_lag_24h",
        "aqi_roll24h",
        "hour_of_day", "day_of_week",
    ]
    display_cols = [c for c in display_cols if c in subset.columns]

    pd.set_option("display.max_columns", None)
    pd.set_option("display.width", 200)
    pd.set_option("display.float_format", "{:.2f}".format)

    print(f"\n  First {n_rows} rows:\n")
    print(subset[display_cols].head(n_rows).to_string(index=False))

    # Lag coverage report
    print("\n  Lag fill-rate across ALL stations:")
    lag_cols = [c for c in ["aqi_lag_1h", "aqi_lag_6h", "aqi_lag_24h"] if c in df.columns]
    for col in lag_cols:
        filled = df[col].notna().sum()
        total  = len(df)
        print(f"    {col:<15}: {filled:>4}/{total} rows filled  ({100*filled/total:.1f}%)")

    print("\n  Weather join fill-rate:")
    for col in ["temperature", "wind_speed", "humidity"]:
        if col in df.columns:
            filled = df[col].notna().sum()
            print(f"    {col:<15}: {filled:>4}/{len(df)} rows filled  ({100*filled/len(df):.1f}%)")


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Build ML features from Supabase readings + weather and print a sanity-check view.",
    )
    p.add_argument("--station", default=None, help="City name to display (default: auto-select).")
    p.add_argument("--rows",    type=int, default=10, help="Number of rows to print (default: 10).")
    return p.parse_args()


def main() -> None:
    args = _parse_args()

    # Lazy import so the module is importable without a DB connection
    from db import get_engine  # noqa: PLC0415

    engine = get_engine()
    print("Loading readings…", end="", flush=True)
    readings = _load_readings(engine)
    print(f" {len(readings):,} rows")

    print("Loading weather… ", end="", flush=True)
    weather = _load_weather(engine)
    print(f" {len(weather):,} rows")

    print("Building features…")
    df = build_features(readings, weather)
    print(f"  Output shape: {df.shape[0]:,} rows x {df.shape[1]} columns")
    print(f"  Columns: {list(df.columns)}\n")

    _print_sanity_check(df, station=args.station, n_rows=args.rows)


if __name__ == "__main__":
    main()
