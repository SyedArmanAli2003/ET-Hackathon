"""
model/features.py -- Feature engineering for AQI forecasting.

Public API
----------
    build_features(readings, weather)         -> DataFrame
    add_forecast_target(df, horizon_hours)    -> DataFrame
    forecast_feasibility(df, horizon_hours)   -> dict

Input DataFrames:
    readings  columns: station_id, city, timestamp (UTC-aware), aqi, pm25, data_source
    weather   columns: station_id, city, timestamp (UTC-aware), temperature, wind_speed, humidity

Feature columns produced by build_features():
    temperature, wind_speed, humidity   -- nearest-hour weather join (merge_asof)
    aqi_lag_1h                          -- AQI ~1 h ago (time-based, per station)
    aqi_lag_6h                          -- AQI ~6 h ago
    aqi_lag_24h                         -- AQI ~24 h ago
    aqi_roll24h                         -- rolling 24-hour mean AQI (per station)
    hour_of_day                         -- 0-23 UTC hour
    day_of_week                         -- 0=Monday ... 6=Sunday

Lag strategy
------------
Readings arrive at irregular intervals (15 min for most stations, up to 78 min for
sparse ones). Row-based shift(N) is meaningless ("4 readings ago" != "1 hour ago").
We use pd.merge_asof per station with direction='backward' and a tolerance window:

    lag 1h  -- tolerance +/-45 min
    lag 6h  -- tolerance +/-45 min
    lag 24h -- tolerance +/-90 min  (wider for sparse stations)

NaN = no observation in tolerance window = correct ML signal for a data gap.

Weather join
------------
merge_asof direction='nearest', tolerance=60 min, by station_id.

Target creation (add_forecast_target)
--------------------------------------
Uses the symmetric mirror of _add_lag: shifts lookup timestamps BACKWARD by the
horizon, then merge_asof forward. For each row at T this finds the AQI reading
nearest to T + horizon_hours. Returns NaN when no reading exists in window.
ONLY the target moves forward -- all input features remain at or before T.

Usage
-----
    from model.features import build_features, add_forecast_target, forecast_feasibility
    python model/features.py
    python model/features.py --station Delhi --rows 20
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT / "ingestion"))

from dotenv import load_dotenv
load_dotenv(dotenv_path=_ROOT / "ingestion" / ".env")
load_dotenv()

from sqlalchemy import text


# =============================================================================
# Public API
# =============================================================================

def build_features(
    readings: pd.DataFrame,
    weather: pd.DataFrame,
) -> pd.DataFrame:
    """
    Join readings with weather and engineer time-series features.

    All features are computed using data at or before time T for each row.
    No future information leaks into the feature columns -- only the TARGET
    (added separately by add_forecast_target) moves forward in time.

    Parameters
    ----------
    readings : DataFrame with station_id, city, timestamp (UTC-aware), aqi, pm25
    weather  : DataFrame with station_id, timestamp (UTC-aware), temperature, wind_speed, humidity

    Returns
    -------
    DataFrame with all original readings columns plus engineered features,
    sorted by (city, timestamp).
    """
    _validate(readings, ["station_id", "city", "timestamp", "aqi"])
    _validate(weather, ["station_id", "timestamp", "temperature", "wind_speed", "humidity"])

    df = readings.copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)

    # 1. Join nearest weather observation (direction='nearest', tol=60 min)
    df = _join_weather(df, weather)

    # 2. Sort before any lag/rolling operation
    df = df.sort_values(["station_id", "timestamp"]).reset_index(drop=True)

    # 3. Lag features -- all use data at or before T (direction='backward')
    df = _add_lag(df, lag_hours=1,  new_col="aqi_lag_1h",  tolerance_min=45)
    df = _add_lag(df, lag_hours=6,  new_col="aqi_lag_6h",  tolerance_min=45)
    df = _add_lag(df, lag_hours=24, new_col="aqi_lag_24h", tolerance_min=90)

    # 4. Rolling 24-hour mean (per station, causal -- only past data)
    df = _add_rolling_mean(df, col="aqi", window="24h", new_col="aqi_roll24h")

    # 5. Calendar features
    df["hour_of_day"] = df["timestamp"].dt.hour.astype("int8")
    df["day_of_week"] = df["timestamp"].dt.dayofweek.astype("int8")  # 0=Mon

    # 6. Final sort
    df = df.sort_values(["city", "timestamp"]).reset_index(drop=True)
    return df


def add_forecast_target(
    df: pd.DataFrame,
    horizon_hours: int,
    tolerance_min: int = 90,
) -> pd.DataFrame:
    """
    Attach a FORWARD-shifted AQI target column for true forecast training.

    For each row at time T, finds the AQI reading closest to T + horizon_hours
    within +/-tolerance_min. Returns NaN when no reading falls in that window.
    Rows with NaN target must be DROPPED before fitting, never imputed.

    Causal guarantee
    ----------------
    Only the target moves forward. All input features from build_features()
    are computed at or before T. The model learns:
        "Given what I know at T, predict AQI at T + horizon_hours."

    This is a genuine forecast, not a nowcast.

    Implementation -- symmetric mirror of _add_lag()
    -------------------------------------------------
    _add_lag shifts lookup timestamps FORWARD by lag, uses direction='backward'.
    Here we shift lookup timestamps BACKWARD by horizon, use direction='forward':

        lookup['timestamp'] = original_ts - horizon

    For each row at T, merge_asof forward finds the smallest lookup_ts >= T:
        original_ts - horizon >= T  =>  original_ts >= T + horizon

    i.e. the first reading at or after T + horizon, within tolerance.

    Parameters
    ----------
    df           : feature matrix from build_features()
    horizon_hours: forecast horizon in hours (1, 6, 24, ...)
    tolerance_min: max deviation from exact T + horizon (default 90 min)

    Returns
    -------
    df with new column aqi_target_{horizon_hours}h (float64, NaN = no target found)
    """
    horizon    = pd.Timedelta(hours=horizon_hours)
    tol        = pd.Timedelta(minutes=tolerance_min)
    target_col = f"aqi_target_{horizon_hours}h"
    parts: list[pd.DataFrame] = []

    for _sid, grp in df.groupby("station_id", sort=False):
        grp = grp.sort_values("timestamp").copy()

        # Shift lookup timestamps BACK by horizon so merge_asof forward
        # effectively finds the reading at T + horizon for each row at T.
        lookup = (
            grp[["timestamp", "aqi"]]
            .copy()
            .rename(columns={"aqi": target_col})
        )
        lookup["timestamp"] = lookup["timestamp"] - horizon

        merged = pd.merge_asof(
            grp,
            lookup,
            on="timestamp",
            direction="forward",
            tolerance=tol,
        )
        parts.append(merged)

    result = pd.concat(parts, ignore_index=True)
    result[target_col] = result[target_col].astype("float64")
    result = result.sort_values(["city", "timestamp"]).reset_index(drop=True)
    return result


def forecast_feasibility(
    df: pd.DataFrame,
    horizon_hours: int,
) -> dict:
    """
    Report how many rows can form a (features, target) pair for the given
    horizon BEFORE any train/test split.

    Call this before training to catch the "dataset too short" problem early
    rather than silently training on zero rows.

    Returns dict with keys:
        total_rows, usable_rows, usable_pct, data_span_h,
        horizon_h, feasible (True if usable_pct >= 10), verdict
    """
    target_col = f"aqi_target_{horizon_hours}h"
    if target_col not in df.columns:
        df = add_forecast_target(df, horizon_hours)

    ts       = df["timestamp"]
    span_h   = (ts.max() - ts.min()).total_seconds() / 3600
    total    = len(df)
    usable   = int(df[target_col].notna().sum())
    pct      = 100 * usable / total if total > 0 else 0.0
    feasible = pct >= 10.0

    if usable == 0:
        need_more = max(0.0, horizon_hours - span_h + 1)
        verdict = (
            f"INFEASIBLE: 0/{total} rows have a {horizon_hours}h-ahead target. "
            f"Dataset spans only {span_h:.1f} h -- must span MORE THAN {horizon_hours} h "
            f"before any (T, T+{horizon_hours}h) pair can form. "
            f"Wait ~{need_more:.0f} more hours of ingestion."
        )
    elif not feasible:
        verdict = (
            f"MARGINAL: {usable}/{total} rows ({pct:.1f}%) have a target. "
            f"Very few training examples -- results will be unreliable."
        )
    else:
        verdict = f"OK: {usable}/{total} rows ({pct:.1f}%) have a {horizon_hours}h-ahead target."

    return dict(
        total_rows=total,
        usable_rows=usable,
        usable_pct=round(pct, 1),
        data_span_h=round(span_h, 2),
        horizon_h=horizon_hours,
        feasible=feasible,
        verdict=verdict,
    )


# =============================================================================
# Internal helpers
# =============================================================================

def _validate(df: pd.DataFrame, required: list[str]) -> None:
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"DataFrame is missing columns: {missing}")


def _join_weather(df: pd.DataFrame, weather: pd.DataFrame) -> pd.DataFrame:
    """Left-join each reading to the nearest weather observation within +/-60 min."""
    wx = weather[["station_id", "timestamp", "temperature", "wind_speed", "humidity"]].copy()
    wx["timestamp"] = pd.to_datetime(wx["timestamp"], utc=True)
    merged = pd.merge_asof(
        df.sort_values("timestamp"),
        wx.sort_values("timestamp"),
        on="timestamp",
        by="station_id",
        direction="nearest",
        tolerance=pd.Timedelta("60min"),
        suffixes=("", "_wx"),
    )
    return merged


def _add_lag(
    df: pd.DataFrame,
    lag_hours: int,
    new_col: str,
    tolerance_min: int,
) -> pd.DataFrame:
    """
    For each row, find AQI at (timestamp - lag_hours) within +/-tolerance_min.
    Uses lookup timestamps shifted FORWARD by lag + merge_asof backward.
    """
    lag = pd.Timedelta(hours=lag_hours)
    tol = pd.Timedelta(minutes=tolerance_min)
    parts: list[pd.DataFrame] = []
    for _sid, grp in df.groupby("station_id", sort=False):
        grp = grp.sort_values("timestamp").copy()
        lookup = grp[["timestamp", "aqi"]].copy().rename(columns={"aqi": new_col})
        lookup["timestamp"] = lookup["timestamp"] + lag
        merged = pd.merge_asof(grp, lookup, on="timestamp", direction="backward", tolerance=tol)
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
    """Rolling time-window mean per station, written back via positional index."""
    df = df.sort_values(["station_id", "timestamp"]).reset_index(drop=True)
    roll_values = pd.Series(index=df.index, dtype="float64")
    for _sid, grp in df.groupby("station_id", sort=False):
        rolled = grp.set_index("timestamp")[col].rolling(window, min_periods=1).mean()
        roll_values.loc[grp.index] = rolled.values
    df[new_col] = roll_values
    return df


# =============================================================================
# DB loaders (self-contained for standalone use)
# =============================================================================

def _load_readings(engine) -> pd.DataFrame:
    q = """
        SELECT r.station_id::text, s.city,
               r.timestamp AT TIME ZONE 'UTC' AS timestamp,
               r.aqi::float, r.pm25::float, r.data_source
        FROM readings r JOIN stations s ON s.id = r.station_id
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
        FROM weather w JOIN stations s ON s.id = w.station_id
        ORDER BY s.city, w.timestamp
    """
    with engine.connect() as conn:
        df = pd.read_sql(text(q), conn)
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    return df


# =============================================================================
# Sanity-check CLI
# =============================================================================

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Build AQI feature matrix and sanity-check it.")
    p.add_argument("--station", default=None)
    p.add_argument("--rows",    type=int, default=10)
    return p.parse_args()


def main() -> None:
    args = _parse_args()
    from db import get_engine  # noqa: PLC0415
    engine = get_engine()
    print("Loading readings...", end="", flush=True)
    readings = _load_readings(engine)
    print(f" {len(readings):,} rows")
    print("Loading weather...",  end="", flush=True)
    weather = _load_weather(engine)
    print(f" {len(weather):,} rows")
    print("Building features...")
    df = build_features(readings, weather)
    print(f"  Shape: {df.shape[0]:,} x {df.shape[1]}")
    print(f"  Columns: {list(df.columns)}\n")

    # Lag fill-rate
    for col in ["aqi_lag_1h", "aqi_lag_6h", "aqi_lag_24h", "aqi_roll24h"]:
        if col in df.columns:
            pct = 100 * df[col].notna().sum() / len(df)
            print(f"  {col:<18}: {pct:.1f}% filled")

    # Feasibility check for common horizons
    print()
    for h in [1, 6, 24]:
        f = forecast_feasibility(df, h)
        print(f"  horizon={h:>2}h  usable={f['usable_rows']:>4}/{f['total_rows']}  ({f['usable_pct']}%)  {f['verdict'][:60]}")

    # Print sample rows
    if args.station:
        subset = df[df["city"].str.lower() == args.station.lower()]
    else:
        lag_cols = [c for c in ["aqi_lag_1h", "aqi_lag_6h"] if c in df.columns]
        if lag_cols:
            best = df.groupby("city")[lag_cols].apply(lambda g: g.notna().mean().mean()).idxmax()
        else:
            best = df["city"].value_counts().idxmax()
        subset = df[df["city"] == best]
        print(f"\n  (Auto-selected: {best})")

    cols = [c for c in ["city","timestamp","aqi","aqi_lag_1h","aqi_lag_6h",
                         "aqi_roll24h","temperature","wind_speed","humidity",
                         "hour_of_day","day_of_week"] if c in subset.columns]
    pd.set_option("display.max_columns", None)
    pd.set_option("display.width", 220)
    pd.set_option("display.float_format", "{:.2f}".format)
    print(f"\n  First {args.rows} rows:\n")
    print(subset[cols].head(args.rows).to_string(index=False))


if __name__ == "__main__":
    main()
