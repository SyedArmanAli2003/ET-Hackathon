"""
model/eval_agent.py -- Automated forecast evaluation against real outcomes.

WHAT THIS IS
------------
For every row in `forecasts` whose forecast_at has already passed, find the
actual reading closest to that timestamp and compute:

    model_abs_error    = |predicted_aqi - actual_aqi|
    baseline_abs_error = |persistence_prediction - actual_aqi|

Persistence baseline = the AQI reading closest to when the forecast was
MADE (created_at), carried forward unchanged -- "assume no change", the
same naive baseline train.py already compares against at training time.
This script closes the loop by checking that comparison against what
ACTUALLY happened, on an ongoing basis, not just at training time.

This is the automated version of the honesty-first reporting already in
train.py's per-city table: real model error vs. real baseline error,
per forecast, logged permanently to `model_evals` for later inspection
instead of only being visible in a one-off training run's console output.

IDEMPOTENT
----------
Skips any (station_id, forecast_at, model_version, horizon_hours) already
evaluated -- same ON CONFLICT DO NOTHING pattern used throughout
ingestion/, so re-running this script never double-counts or double-writes.

MATCHING TOLERANCE
-------------------
"The actual reading closest to forecast_at" uses the same +/-90 minute
tolerance as model/features.py's add_forecast_target() lag/target matching,
for consistency with how the training pipeline itself defines "the real
value at T+horizon". A forecast with no reading in that window yet (still
too fresh, or a gap in ingestion) is skipped, not guessed.

Usage
-----
    python model/eval_agent.py                 # evaluate every un-evaluated forecast
    python model/eval_agent.py --dry-run        # compute + print, skip DB writes
    python model/eval_agent.py --retrain-threshold 5   # consecutive-loss flag count
"""

from __future__ import annotations

import argparse
import sys
from datetime import timedelta
from pathlib import Path

import pandas as pd

# Force UTF-8 on Windows consoles
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT / "ingestion"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from dotenv import load_dotenv
load_dotenv(dotenv_path=_ROOT / "ingestion" / ".env")
load_dotenv()

MATCH_TOLERANCE_MIN = 90  # matches add_forecast_target()'s default tolerance
_MODEL_HEALTH_PATH = Path(__file__).resolve().parent / "model_health.md"


# =============================================================================
# DB loaders
# =============================================================================

def _load_df(engine, query: str, params: dict | None = None) -> pd.DataFrame:
    from sqlalchemy import text
    with engine.connect() as conn:
        df = pd.read_sql(text(query), conn, params=params or {})
    return df


def _load_unevaluated_forecasts(engine) -> pd.DataFrame:
    """
    Every forecast row whose forecast_at has passed and that does not
    already have a matching model_evals row (idempotency check done here,
    not just relied on at insert time, so we don't even fetch readings for
    forecasts we're about to skip anyway).
    """
    q = """
        SELECT f.id AS forecast_id, f.station_id::text, s.city, s.name AS station_name,
               f.forecast_at, f.predicted_aqi::float, f.model_version, f.horizon_hours,
               f.created_at AS forecast_created_at
        FROM forecasts f
        JOIN stations s ON s.id = f.station_id
        WHERE f.forecast_at <= now()
          AND NOT EXISTS (
              SELECT 1 FROM model_evals me
              WHERE me.station_id = f.station_id
                AND me.forecast_at = f.forecast_at
                AND me.model_version = f.model_version
                AND me.horizon_hours = f.horizon_hours
          )
        ORDER BY s.city, f.forecast_at
    """
    df = _load_df(engine, q)
    for col in ("forecast_at", "forecast_created_at"):
        df[col] = pd.to_datetime(df[col], utc=True)
    return df


def _load_readings_near(engine, station_ids: list[str], earliest: pd.Timestamp, latest: pd.Timestamp) -> pd.DataFrame:
    """
    Load all readings for the given stations in the time window that could
    possibly be needed as either an "actual" match (near forecast_at) or a
    "baseline" match (near forecast_created_at). One bulk query instead of
    one query per forecast row.
    """
    if not station_ids:
        return pd.DataFrame(columns=["station_id", "timestamp", "aqi"])
    from sqlalchemy import text
    # Cast station_id to text on the LEFT side instead of casting the bound
    # array parameter to uuid[] -- psycopg2 sends the Python list as a text[]
    # literal by default, and casting the array itself inside a :param
    # breaks SQLAlchemy's parameter substitution syntax. Comparing as text
    # on both sides sidesteps that without needing a special bind type.
    q = text("""
        SELECT station_id::text, timestamp, aqi::float
        FROM readings
        WHERE station_id::text = ANY(:station_ids)
          AND timestamp BETWEEN :earliest AND :latest
        ORDER BY station_id, timestamp
    """)
    with engine.connect() as conn:
        df = pd.read_sql(q, conn, params={
            "station_ids": station_ids,
            "earliest": (earliest - timedelta(hours=6)).to_pydatetime(),
            "latest": (latest + timedelta(hours=6)).to_pydatetime(),
        })
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    return df


def _nearest_reading(
    readings_by_station: dict[str, pd.DataFrame],
    station_id: str,
    target_ts: pd.Timestamp,
    tolerance_min: int = MATCH_TOLERANCE_MIN,
) -> float | None:
    """Return the AQI of the reading closest to target_ts within tolerance, or None."""
    df = readings_by_station.get(station_id)
    if df is None or df.empty:
        return None
    deltas = (df["timestamp"] - target_ts).abs()
    idx = deltas.idxmin()
    if deltas.loc[idx] > pd.Timedelta(minutes=tolerance_min):
        return None
    return float(df.loc[idx, "aqi"])


# =============================================================================
# Evaluation
# =============================================================================

def evaluate(engine) -> pd.DataFrame:
    """
    Build the evaluation rows for every un-evaluated, past-due forecast.
    Returns a DataFrame ready for insertion (or empty if nothing to do).
    """
    forecasts = _load_unevaluated_forecasts(engine)
    if forecasts.empty:
        return forecasts

    station_ids = forecasts["station_id"].unique().tolist()
    earliest = min(forecasts["forecast_at"].min(), forecasts["forecast_created_at"].min())
    latest = max(forecasts["forecast_at"].max(), forecasts["forecast_created_at"].max())
    readings = _load_readings_near(engine, station_ids, earliest, latest)
    readings_by_station = {sid: grp for sid, grp in readings.groupby("station_id")}

    rows = []
    skipped_no_actual = 0
    skipped_no_baseline = 0

    for _, fc in forecasts.iterrows():
        actual_aqi = _nearest_reading(readings_by_station, fc["station_id"], fc["forecast_at"])
        if actual_aqi is None:
            skipped_no_actual += 1
            continue

        baseline_aqi = _nearest_reading(readings_by_station, fc["station_id"], fc["forecast_created_at"])
        if baseline_aqi is None:
            skipped_no_baseline += 1
            continue

        predicted_aqi = float(fc["predicted_aqi"])
        model_err = abs(predicted_aqi - actual_aqi)
        baseline_err = abs(baseline_aqi - actual_aqi)

        rows.append({
            "station_id": fc["station_id"],
            "city": fc["city"],
            "station_name": fc["station_name"],
            "forecast_at": fc["forecast_at"],
            "model_version": fc["model_version"],
            "horizon_hours": int(fc["horizon_hours"]),
            "predicted_aqi": round(predicted_aqi, 2),
            "actual_aqi": round(actual_aqi, 2),
            "baseline_predicted_aqi": round(baseline_aqi, 2),
            "model_abs_error": round(model_err, 2),
            "baseline_abs_error": round(baseline_err, 2),
            "model_beat_baseline": bool(model_err < baseline_err),
        })

    print(f"  Forecasts due for evaluation : {len(forecasts)}")
    print(f"  Skipped (no actual reading)  : {skipped_no_actual}")
    print(f"  Skipped (no baseline reading): {skipped_no_baseline}")
    print(f"  Evaluated                    : {len(rows)}")

    return pd.DataFrame(rows)


# =============================================================================
# DB insertion
# =============================================================================

def insert_evals(engine, df: pd.DataFrame) -> int:
    """Insert eval rows via ON CONFLICT DO NOTHING. Returns rows actually inserted."""
    if df.empty:
        return 0
    from sqlalchemy import text
    sql = text("""
        INSERT INTO model_evals
            (station_id, forecast_at, model_version, horizon_hours,
             predicted_aqi, actual_aqi, baseline_predicted_aqi,
             model_abs_error, baseline_abs_error, model_beat_baseline)
        VALUES
            (:station_id, :forecast_at, :model_version, :horizon_hours,
             :predicted_aqi, :actual_aqi, :baseline_predicted_aqi,
             :model_abs_error, :baseline_abs_error, :model_beat_baseline)
        ON CONFLICT (station_id, forecast_at, model_version, horizon_hours)
        DO NOTHING
        RETURNING id
    """)
    inserted = 0
    with engine.begin() as conn:
        for _, row in df.iterrows():
            result = conn.execute(sql, {
                "station_id": row["station_id"],
                "forecast_at": row["forecast_at"].to_pydatetime(),
                "model_version": row["model_version"],
                "horizon_hours": row["horizon_hours"],
                "predicted_aqi": row["predicted_aqi"],
                "actual_aqi": row["actual_aqi"],
                "baseline_predicted_aqi": row["baseline_predicted_aqi"],
                "model_abs_error": row["model_abs_error"],
                "baseline_abs_error": row["baseline_abs_error"],
                "model_beat_baseline": row["model_beat_baseline"],
            })
            if result.fetchone() is not None:
                inserted += 1
    return inserted


# =============================================================================
# Per-city rolling summary + retrain-candidate flag
# =============================================================================

def load_recent_evals(engine, per_city_limit: int = 20) -> pd.DataFrame:
    """
    Load the most recent evals per city (across ALL history, not just this
    run) for the rolling summary -- a "retrain candidate" city is judged on
    its recent track record, not just what this one run happened to touch.
    """
    from sqlalchemy import text
    q = text("""
        SELECT s.city, me.model_abs_error, me.baseline_abs_error,
               me.model_beat_baseline, me.evaluated_at
        FROM model_evals me
        JOIN stations s ON s.id = me.station_id
        ORDER BY s.city, me.evaluated_at DESC
    """)
    with engine.connect() as conn:
        df = pd.read_sql(q, conn)
    if df.empty:
        return df
    df["evaluated_at"] = pd.to_datetime(df["evaluated_at"], utc=True)
    # Keep only the most recent N per city, preserving recency order
    return (
        df.sort_values("evaluated_at", ascending=False)
          .groupby("city", group_keys=False)
          .head(per_city_limit)
    )


def build_summary(recent: pd.DataFrame, retrain_threshold: int) -> tuple[pd.DataFrame, list[str]]:
    """
    Returns (per_city_summary_df, retrain_candidate_cities).
    A city is a "retrain candidate" if its most recent `retrain_threshold`
    evals are ALL baseline wins (model lost every one), consecutively --
    the same signal train.py's own per-city table already surfaces at
    training time, extended into an ongoing, automated check.
    """
    if recent.empty:
        return pd.DataFrame(), []

    summaries = []
    retrain_candidates = []

    for city, grp in recent.groupby("city"):
        grp_sorted = grp.sort_values("evaluated_at", ascending=False)
        summaries.append({
            "city": city,
            "n_evals": len(grp_sorted),
            "median_model_error": round(grp_sorted["model_abs_error"].median(), 2),
            "median_baseline_error": round(grp_sorted["baseline_abs_error"].median(), 2),
            "model_win_rate_pct": round(100 * grp_sorted["model_beat_baseline"].mean(), 1),
        })

        recent_n = grp_sorted.head(retrain_threshold)
        if len(recent_n) >= retrain_threshold and not recent_n["model_beat_baseline"].any():
            retrain_candidates.append(city)

    summary_df = pd.DataFrame(summaries).sort_values("model_win_rate_pct")
    return summary_df, retrain_candidates


def print_summary(summary_df: pd.DataFrame, retrain_candidates: list[str], retrain_threshold: int) -> None:
    print()
    print("=" * 78)
    print("  MODEL HEALTH -- per-city rolling summary")
    print("=" * 78)
    if summary_df.empty:
        print("  No evaluated forecasts yet.")
    else:
        pd.set_option("display.float_format", "{:.2f}".format)
        pd.set_option("display.width", 200)
        print(summary_df.to_string(index=False))
    print()
    if retrain_candidates:
        print(f"  RETRAIN CANDIDATES (lost to baseline on every one of the last {retrain_threshold} evals):")
        for city in retrain_candidates:
            print(f"    - {city}")
    else:
        print(f"  No retrain candidates (no city lost {retrain_threshold}+ consecutive evals to baseline).")
    print("=" * 78)
    print()


def write_model_health_md(summary_df: pd.DataFrame, retrain_candidates: list[str], retrain_threshold: int) -> None:
    lines = [
        "# Model Health — Rolling Forecast Evaluation",
        "",
        f"Generated by `model/eval_agent.py`. Each row compares the model's real prediction error",
        f"against the persistence-baseline's real error, evaluated against the actual observed AQI",
        f"once each forecast's target time has passed.",
        "",
    ]
    if summary_df.empty:
        lines.append("No evaluated forecasts yet.")
    else:
        lines.append("| City | Evals | Median model error | Median baseline error | Model win rate |")
        lines.append("|---|---|---|---|---|")
        for _, row in summary_df.iterrows():
            lines.append(
                f"| {row['city']} | {row['n_evals']} | {row['median_model_error']} | "
                f"{row['median_baseline_error']} | {row['model_win_rate_pct']}% |"
            )
    lines.append("")
    if retrain_candidates:
        lines.append(f"## Retrain candidates (lost to baseline on every one of the last {retrain_threshold} evals)")
        for city in retrain_candidates:
            lines.append(f"- {city}")
    else:
        lines.append(f"## No retrain candidates")
        lines.append(f"No city has lost {retrain_threshold}+ consecutive evals to the persistence baseline.")
    _MODEL_HEALTH_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


# =============================================================================
# CLI
# =============================================================================

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Evaluate past forecasts against real outcomes and the persistence baseline."
    )
    p.add_argument("--dry-run", action="store_true", help="Compute and print, skip DB writes.")
    p.add_argument("--retrain-threshold", type=int, default=5,
                   help="Consecutive baseline-losses before flagging a city as a retrain candidate (default 5).")
    p.add_argument("--no-model-health-file", action="store_true",
                   help="Skip writing model/model_health.md.")
    return p.parse_args()


def main() -> None:
    args = _parse_args()

    from db import get_engine
    engine = get_engine()

    print("Loading un-evaluated, past-due forecasts...")
    eval_rows = evaluate(engine)

    if args.dry_run:
        if not eval_rows.empty:
            pd.set_option("display.width", 200)
            print()
            print(eval_rows.to_string(index=False))
        print("\n  [dry-run] No DB writes performed.")
    elif not eval_rows.empty:
        print(f"\nInserting {len(eval_rows)} evaluation row(s)...")
        inserted = insert_evals(engine, eval_rows)
        print(f"  Inserted  : {inserted}")
        print(f"  Conflicts : {len(eval_rows) - inserted} (DO NOTHING -- already evaluated)")

    print("\nBuilding rolling per-city summary from full model_evals history...")
    recent = load_recent_evals(engine)
    summary_df, retrain_candidates = build_summary(recent, args.retrain_threshold)
    print_summary(summary_df, retrain_candidates, args.retrain_threshold)

    if not args.no_model_health_file:
        write_model_health_md(summary_df, retrain_candidates, args.retrain_threshold)
        print(f"  Wrote {_MODEL_HEALTH_PATH.name}")


if __name__ == "__main__":
    main()
