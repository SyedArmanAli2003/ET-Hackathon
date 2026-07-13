"""
model/predict.py -- Real-time AQI inference and forecast persistence.

WHAT THIS DOES
--------------
1. Loads readings + weather from Supabase (same pattern as train.py).
2. Calls build_latest_features() -> one feature row per station ("now").
3. For each station, loads the saved artifact:
       model/artifacts/{city}_{model}_{horizon}h.pkl
4. Predicts AQI at (latest_reading_timestamp + horizon_hours).
5. Inserts into the forecasts table via ON CONFLICT DO NOTHING.

DESIGN DECISIONS
----------------

forecast_at = latest_reading_timestamp + horizon, NOT datetime.now() + horizon.
    Reason: a stale station (e.g. Mumbai, last reading 11h ago) should produce a
    forecast_at that reflects when its data is actually from, not wall-clock "now".
    This makes forecast_at semantically accurate: "based on the reading at T,
    the predicted AQI at T+horizon is X."

RMSE stored in artifact, not a separate file.
    train.py saves model_rmse and baseline_rmse inside the joblib artifact dict.
    predict.py reads them from there. This guarantees the metrics always match
    the exact model version that produced the prediction. A separate CSV file
    could drift out of sync if artifacts are retrained without updating the file.

DO NOTHING on conflict, not DO UPDATE.
    (station_id, forecast_at, model_version, horizon_hours) changes every run
    because forecast_at = latest_reading_ts + horizon moves forward as new readings
    arrive. Conflicts only happen if you run predict.py twice within the same
    reading interval (~15 min). DO NOTHING is correct: the first run's prediction
    for that window is preserved; the second run's duplicate is silently dropped.
    This accumulates a forecast history rather than overwriting it, which is useful
    for evaluating forecast accuracy retrospectively.

Usage
-----
    python model/predict.py --horizon 6          # default: XGB, 6h ahead
    python model/predict.py --horizon 1
    python model/predict.py --horizon 6 --model lgbm
    python model/predict.py --horizon 6 --dry-run  # print predictions, don't insert
"""

from __future__ import annotations

import argparse
import sys
from datetime import timezone
from pathlib import Path

import pandas as pd

# Force UTF-8 on Windows consoles
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_ROOT      = Path(__file__).resolve().parent.parent
_ARTIFACTS = Path(__file__).resolve().parent / "artifacts"
sys.path.insert(0, str(_ROOT / "ingestion"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from dotenv import load_dotenv
load_dotenv(dotenv_path=_ROOT / "ingestion" / ".env")
load_dotenv()


# =============================================================================
# DB helpers
# =============================================================================

def _load_df(engine, query: str) -> pd.DataFrame:
    from sqlalchemy import text
    with engine.connect() as conn:
        df = pd.read_sql(text(query), conn)
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    return df


def _load_station_ids(engine) -> set[str]:
    """
    Return the set of valid station UUIDs, for validating that a station_id
    from the feature matrix actually exists in the stations table.

    IMPORTANT: this used to return {city_lower: station_uuid}, which silently
    collapsed multi-station cities to a single UUID (whichever row came last
    in SQL order) -- every station in that city had its prediction written
    under one station's identity, and the rest never got a forecast row at
    all. `latest` (from build_latest_features) already carries the correct
    per-row station_id, so run_inference() below uses that directly instead
    of re-deriving it from city name.
    """
    from sqlalchemy import text
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT id::text FROM stations")).fetchall()
    return {row[0] for row in rows}


# =============================================================================
# Artifact loader
# =============================================================================

def _artifact_path(city: str, model_name: str, horizon: int) -> Path:
    """Canonical artifact filename: e.g. model/artifacts/delhi_xgb_6h.pkl"""
    slug = city.lower().replace(" ", "_")
    return _ARTIFACTS / f"{slug}_{model_name}_{horizon}h.pkl"


def _load_artifact(city: str, model_name: str, horizon: int) -> dict | None:
    """
    Load artifact dict. Returns None (with reason logged) if not found.
    Expected keys: model, features, city, horizon_h,
                   model_version, model_rmse, baseline_rmse.
    """
    import joblib
    path = _artifact_path(city, model_name, horizon)
    if not path.exists():
        return None
    try:
        return joblib.load(path)
    except Exception as e:
        print(f"  [warn] Could not load artifact for {city}: {e}")
        return None


# =============================================================================
# Inference
# =============================================================================

def run_inference(
    latest: pd.DataFrame,
    model_name: str,
    horizon: int,
    valid_station_ids: set[str],
) -> list[dict]:
    """
    For each station in `latest` (one row per station), load its artifact,
    predict AQI at T+horizon, and return a list of forecast dicts ready
    for DB insertion.
    """
    from datetime import timedelta

    forecasts: list[dict] = []
    skipped:   list[tuple[str, str]] = []

    for _, row in latest.iterrows():
        city     = row["city"]
        city_key = city.lower()

        # ── 1. Load artifact ─────────────────────────────────────────────────
        art = _load_artifact(city, model_name, horizon)
        if art is None:
            skipped.append((city, f"artifact not found: {_artifact_path(city, model_name, horizon).name}"))
            continue

        feature_cols  = art["features"]
        model         = art["model"]
        model_version = art.get("model_version", f"{model_name}-v1.0")
        model_rmse    = art.get("model_rmse")   # None for old artifacts pre-RMSE save
        baseline_rmse = art.get("baseline_rmse")

        # ── 2. Build input vector ─────────────────────────────────────────────
        # Only include features the model was trained on; fill missing with NaN
        missing = [c for c in feature_cols if c not in row.index or pd.isna(row[c])]
        X = pd.DataFrame([{c: row.get(c, float("nan")) for c in feature_cols}])

        if missing:
            skipped.append((city, f"{len(missing)} feature(s) NaN: {', '.join(missing)} — model was never trained on incomplete rows"))
            continue

        # ── 3. Predict ────────────────────────────────────────────────────────
        try:
            predicted_aqi = float(model.predict(X)[0])
        except Exception as e:
            skipped.append((city, f"predict() failed: {e}"))
            continue

        # Sanity-check: AQI must be in [0, 500]
        # (WHO max meaningful value; beyond 500 is "hazardous off-scale")
        if not (0 <= predicted_aqi <= 500):
            old = predicted_aqi
            predicted_aqi = max(0.0, min(500.0, predicted_aqi))
            print(f"  [clip] {city}: predicted {old:.1f} clipped to {predicted_aqi:.1f}")


        # ── 4. Compute forecast_at ────────────────────────────────────────────
        # forecast_at = latest reading timestamp for this station + horizon
        # NOT datetime.now() + horizon — see module docstring for rationale.
        latest_ts  = row["timestamp"]  # pd.Timestamp, UTC-aware
        forecast_at = latest_ts + timedelta(hours=horizon)

        # ── 5. Validate station_id UUID ───────────────────────────────────────
        # Use the row's own station_id (already present per-row in `latest`)
        # instead of re-deriving it from city name -- see _load_station_ids()
        # docstring for why a city-keyed lookup silently dropped stations.
        station_uuid = row["station_id"]
        if station_uuid not in valid_station_ids:
            skipped.append((city, f"station_id {station_uuid} not found in stations table"))
            continue

        forecasts.append({
            "station_id":    station_uuid,
            "city":          city,
            "latest_ts":     latest_ts,
            "forecast_at":   forecast_at,
            "predicted_aqi": round(predicted_aqi, 4),
            "model_version": model_version,
            "horizon_hours": horizon,
            "model_rmse":    model_rmse,
            "baseline_rmse": baseline_rmse,
            "missing_features": missing,
        })

    # ── Log skipped stations ──────────────────────────────────────────────────
    if skipped:
        print(f"\n  Skipped {len(skipped)} station(s):")
        for city, reason in skipped:
            print(f"    [{city:<20}] {reason}")

    return forecasts


# =============================================================================
# DB insertion
# =============================================================================

def insert_forecasts(engine, forecasts: list[dict]) -> int:
    """
    Insert forecast rows via ON CONFLICT DO NOTHING.
    Returns number of rows actually inserted (conflicts silently skipped).
    """
    from sqlalchemy import text

    sql = text("""
        INSERT INTO forecasts
            (station_id, forecast_at, predicted_aqi,
             model_version, horizon_hours, model_rmse, baseline_rmse)
        VALUES
            (:station_id, :forecast_at, :predicted_aqi,
             :model_version, :horizon_hours, :model_rmse, :baseline_rmse)
        ON CONFLICT (station_id, forecast_at, model_version, horizon_hours)
        DO NOTHING
    """)

    inserted = 0
    with engine.begin() as conn:
        for fc in forecasts:
            result = conn.execute(sql, {
                "station_id":    fc["station_id"],
                "forecast_at":   fc["forecast_at"].to_pydatetime(),
                "predicted_aqi": fc["predicted_aqi"],
                "model_version": fc["model_version"],
                "horizon_hours": fc["horizon_hours"],
                "model_rmse":    fc["model_rmse"],
                "baseline_rmse": fc["baseline_rmse"],
            })
            inserted += result.rowcount
    return inserted


# =============================================================================
# CLI
# =============================================================================

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Run AQI inference and persist forecasts to Supabase."
    )
    p.add_argument("--horizon",   type=int,   default=6,
                   choices=[1, 6, 24],
                   help="Forecast horizon in hours (default 6).")
    p.add_argument("--model",     default="xgb", choices=["xgb", "lgbm"],
                   help="Model type to use (default xgb).")
    p.add_argument("--dry-run",   action="store_true",
                   help="Print predictions without inserting to DB.")
    return p.parse_args()


def main() -> None:
    args = _parse_args()

    from db import get_engine
    from features import build_latest_features

    engine = get_engine()

    # ── Load data ─────────────────────────────────────────────────────────────
    print("Loading readings...", end="", flush=True)
    readings = _load_df(engine, """
        SELECT r.station_id::text, s.city,
               r.timestamp AT TIME ZONE 'UTC' AS timestamp,
               r.aqi::float, r.pm25::float, r.data_source
        FROM readings r JOIN stations s ON s.id = r.station_id
        ORDER BY s.city, r.timestamp""")
    print(f" {len(readings):,} rows")

    print("Loading weather...",  end="", flush=True)
    weather = _load_df(engine, """
        SELECT w.station_id::text, s.city,
               w.timestamp AT TIME ZONE 'UTC' AS timestamp,
               w.temperature::float, w.wind_speed::float, w.humidity::float
        FROM weather w JOIN stations s ON s.id = w.station_id
        ORDER BY s.city, w.timestamp""")
    print(f" {len(weather):,} rows")

    # ── Build latest feature snapshot ─────────────────────────────────────────
    print("Building latest features (one row per station)...")
    latest = build_latest_features(readings, weather)
    print(f"  {len(latest)} stations")

    # ── Load valid station UUIDs (for validation, not lookup) ────────────────
    valid_station_ids = _load_station_ids(engine)

    # ── Run inference ─────────────────────────────────────────────────────────
    print(f"\nRunning inference | model={args.model} | horizon={args.horizon}h\n")
    forecasts = run_inference(latest, args.model, args.horizon, valid_station_ids)

    if not forecasts:
        print("\n  No predictions produced. Check that artifacts exist:")
        print(f"    ls {_ARTIFACTS}/")
        return

    # ── Print preview ─────────────────────────────────────────────────────────
    print(f"\n  {'City':<20} {'Latest reading':>22} {'Forecast at (T+{})'.format(args.horizon):>26}  "
          f"{'Pred AQI':>9}  {'Model RMSE':>10}  {'Base RMSE':>10}  {'NaN feats'}")
    print(f"  {'-'*20} {'-'*22} {'-'*26}  {'-'*9}  {'-'*10}  {'-'*10}  {'-'*10}")
    for fc in forecasts:
        nan_note = f"{len(fc['missing_features'])} ({','.join(fc['missing_features'][:2])})" \
                   if fc["missing_features"] else "none"
        rmse_str  = f"{fc['model_rmse']:.4f}" if fc["model_rmse"]    is not None else "n/a"
        brmse_str = f"{fc['baseline_rmse']:.4f}" if fc["baseline_rmse"] is not None else "n/a"
        print(f"  {fc['city']:<20} {str(fc['latest_ts']):>22}  {str(fc['forecast_at']):>26}  "
              f"{fc['predicted_aqi']:>9.2f}  {rmse_str:>10}  {brmse_str:>10}  {nan_note}")

    # ── Insert or dry-run ─────────────────────────────────────────────────────
    if args.dry_run:
        print(f"\n  [dry-run] Would insert {len(forecasts)} row(s). No DB writes.")
        return

    print(f"\nInserting {len(forecasts)} forecast(s) into forecasts table...")
    n_inserted = insert_forecasts(engine, forecasts)
    n_conflict = len(forecasts) - n_inserted
    print(f"  Inserted  : {n_inserted}")
    print(f"  Conflicts : {n_conflict} (DO NOTHING — already in table for this window)")
    print(f"\nDone.")


if __name__ == "__main__":
    main()
