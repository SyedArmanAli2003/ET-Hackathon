"""
model/train.py -- True AQI forecast model with persistence baseline.

WHAT THIS IS
------------
A genuine forecast model: given features computed AT time T, predict AQI
at time T + horizon_hours. This is NOT a nowcast.

    Target = AQI nearest to T + horizon_hours
             (merge_asof, direction='forward', tolerance=+/-90 min)
             NaN when no reading exists near T + horizon

All input features (aqi_lag_*, aqi_roll24h, weather, calendar) are computed
at or before T. Only the target moves forward. No leakage.

PERSISTENCE BASELINE
--------------------
For every test row at T, the naive baseline predicts:
    "AQI in {horizon}h = AQI right now at T"   (no change assumption)

This requires zero ML. If the model does not beat this on RMSE/MAE,
it adds no value over "do nothing". The comparison table is the primary
evaluation output.

DATA VOLUME WARNING
-------------------
A horizon-N forecast requires rows where a reading exists N hours AFTER
the feature row's timestamp. The dataset must span MORE than N hours
before any (T, T+N) pair can form at all.

Current dataset: 22.25 h deep.
  -- horizon 24h: 0 usable rows  --> INFEASIBLE, exits cleanly
  -- horizon  6h: ~672 rows      --> OK
  -- horizon  1h: ~877 rows      --> OK

Usage
-----
    python model/train.py                    # default: horizon=6h, both models
    python model/train.py --horizon 24       # exits with clear INFEASIBLE message
    python model/train.py --horizon 1
    python model/train.py --model xgb
    python model/train.py --model lgbm
    python model/train.py --no-save          # skip writing artifacts
"""

from __future__ import annotations

import argparse
import sys
import warnings
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

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
# Feature configuration
# =============================================================================

# pm25 intentionally excluded: it IS the direct input to the AQI formula --
# including it would make the model trivially accurate (data leakage).
_FEATURE_CANDIDATES = [
    "aqi_lag_1h",
    "aqi_lag_6h",
    "aqi_lag_24h",   # auto-dropped when 0% filled
    "aqi_roll24h",
    "temperature",
    "wind_speed",
    "humidity",
    "hour_of_day",
    "day_of_week",
]


# =============================================================================
# Model factories
# =============================================================================

def _make_xgb(**kw):
    from xgboost import XGBRegressor
    cfg = dict(n_estimators=300, learning_rate=0.05, max_depth=4,
               subsample=0.8, colsample_bytree=0.8, random_state=42,
               n_jobs=-1, verbosity=0)
    cfg.update(kw)
    return XGBRegressor(**cfg)


def _make_lgbm(**kw):
    from lightgbm import LGBMRegressor
    cfg = dict(n_estimators=300, learning_rate=0.05, max_depth=4,
               subsample=0.8, colsample_bytree=0.8, random_state=42,
               n_jobs=-1, verbose=-1)
    cfg.update(kw)
    return LGBMRegressor(**cfg)


_FACTORIES = {"xgb": _make_xgb, "lgbm": _make_lgbm}


# =============================================================================
# Metrics
# =============================================================================

def _rmse(y_true, y_pred) -> float:
    return float(np.sqrt(mean_squared_error(y_true, y_pred)))


def _mae(y_true, y_pred) -> float:
    return float(mean_absolute_error(y_true, y_pred))


def _pct_improvement(baseline: float, model: float) -> float:
    """Positive = model better. Negative = model worse than baseline."""
    if baseline == 0:
        return 0.0
    return round(100 * (baseline - model) / baseline, 1)


def _resolve_features(df: pd.DataFrame) -> list[str]:
    """Drop candidates that are absent or entirely NaN."""
    usable  = [c for c in _FEATURE_CANDIDATES if c in df.columns and df[c].notna().any()]
    dropped = [c for c in _FEATURE_CANDIDATES if c not in usable]
    if dropped:
        print(f"  [features] Dropping zero/missing columns: {dropped}")
    return usable


# =============================================================================
# Training and evaluation
# =============================================================================

def train_and_evaluate(
    train_df: pd.DataFrame,
    test_df: pd.DataFrame,
    horizon_hours: int,
    model_name: str = "xgb",
    save_artifacts: bool = True,
) -> pd.DataFrame:
    """
    Train one model per station on the forward-shifted target.
    Compute model RMSE/MAE vs persistence baseline RMSE/MAE on the same test set.

    Persistence baseline: y_baseline = aqi at time T (AQI won't change assumption).
    This is the correct naive baseline for time-series AQI prediction.
    """
    try:
        import joblib
    except ImportError:
        save_artifacts = False

    target_col   = f"aqi_target_{horizon_hours}h"
    feature_cols = _resolve_features(train_df)
    cities       = sorted(set(train_df["city"].unique()) & set(test_df["city"].unique()))
    factory      = _FACTORIES[model_name]
    records: list[dict[str, Any]] = []

    if save_artifacts:
        _ARTIFACTS.mkdir(parents=True, exist_ok=True)

    print(f"\n  Training {model_name.upper()} | horizon={horizon_hours}h | {len(cities)} stations")
    print(f"  Features ({len(feature_cols)}): {feature_cols}")
    print(f"  Target  : {target_col}\n")

    for city in cities:
        # Drop rows where target is NaN (no reading near T+horizon)
        tr = train_df[train_df["city"] == city].dropna(subset=feature_cols + [target_col])
        te = test_df[test_df["city"]   == city].dropna(subset=feature_cols + [target_col, "aqi"])

        if len(tr) < 5:
            print(f"  [{city:<20}] SKIP train -- only {len(tr)} usable rows after NaN drop")
            continue
        if len(te) == 0:
            print(f"  [{city:<20}] SKIP test  -- 0 usable rows")
            continue

        X_train, y_train = tr[feature_cols], tr[target_col]
        X_test,  y_true  = te[feature_cols], te[target_col]

        # Persistence baseline: AQI at T (no shift) -- the raw aqi column
        y_baseline = te["aqi"].values

        # Train model
        model = factory()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            model.fit(X_train, y_train)
        y_pred = model.predict(X_test)

        # Metrics
        m_rmse  = _rmse(y_true, y_pred)
        m_mae   = _mae(y_true, y_pred)
        m_r2    = float(r2_score(y_true, y_pred))
        b_rmse  = _rmse(y_true, y_baseline)
        b_mae   = _mae(y_true, y_baseline)
        rmse_imp = _pct_improvement(b_rmse, m_rmse)
        mae_imp  = _pct_improvement(b_mae,  m_mae)
        winner   = "MODEL" if m_rmse < b_rmse else "BASELINE"

        print(
            f"  [{city:<20}] n_train={len(tr):>3}  n_test={len(te):>3}  "
            f"model_RMSE={m_rmse:>7.2f}  base_RMSE={b_rmse:>7.2f}  "
            f"imp={rmse_imp:>+6.1f}%  [{winner}]"
        )

        if save_artifacts:
            try:
                path = _ARTIFACTS / f"{city.lower().replace(' ','_')}_{model_name}_{horizon_hours}h.pkl"
                import joblib
                joblib.dump({"model": model, "features": feature_cols,
                             "city": city, "horizon_h": horizon_hours}, path)
            except Exception as e:
                print(f"    [warn] Could not save artifact: {e}")

        records.append(dict(
            city=city, model=model_name, horizon_h=horizon_hours,
            n_train=len(tr), n_test=len(te),
            model_rmse=round(m_rmse, 3), base_rmse=round(b_rmse, 3), rmse_imp_pct=rmse_imp,
            model_mae=round(m_mae,  3),  base_mae=round(b_mae,  3),  mae_imp_pct=mae_imp,
            model_r2=round(m_r2, 4),
            winner=winner,
        ))

    return pd.DataFrame(records).sort_values("rmse_imp_pct", ascending=False).reset_index(drop=True)


def print_comparison_table(results: pd.DataFrame, split_meta: dict, horizon: int) -> None:
    """Print the full model vs baseline comparison table."""
    w = 80
    print()
    print("=" * w)
    model_name = results["model"].iloc[0].upper() if not results.empty else "?"
    print(f"  FORECAST EVALUATION -- {horizon}h ahead | {model_name}")
    print("=" * w)
    print(f"  Split    : {split_meta['strategy']}")
    print(f"  Train    : {split_meta['train_start']} -> {split_meta['train_end']}")
    print(f"  Test     : {split_meta['test_start']}  -> {split_meta['test_end']}")
    print()

    pd.set_option("display.float_format", "{:.3f}".format)
    pd.set_option("display.max_columns", None)
    pd.set_option("display.width", 220)

    cols = ["city", "n_train", "n_test",
            "model_rmse", "base_rmse", "rmse_imp_pct",
            "model_mae",  "base_mae",  "mae_imp_pct",
            "winner"]
    print(results[cols].to_string(index=False))
    print()

    if not results.empty:
        model_wins = (results["winner"] == "MODEL").sum()
        print(f"  Model wins   : {model_wins}/{len(results)} stations")
        print(f"  Baseline wins: {len(results) - model_wins}/{len(results)} stations")
        print()
        print(f"  Median model RMSE    : {results['model_rmse'].median():.2f}")
        print(f"  Median baseline RMSE : {results['base_rmse'].median():.2f}")
        print(f"  Median RMSE impr.    : {results['rmse_imp_pct'].median():+.1f}%")
        print(f"  Median model MAE     : {results['model_mae'].median():.2f}")
        print(f"  Median baseline MAE  : {results['base_mae'].median():.2f}")
        print(f"  Median MAE impr.     : {results['mae_imp_pct'].median():+.1f}%")
    print("=" * w)
    print()


# =============================================================================
# CLI
# =============================================================================

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Train AQI forecast models and compare against persistence baseline."
    )
    p.add_argument("--horizon",   type=int,   default=6,
                   help="Forecast horizon in hours (default 6). Use 24 once >24h of data exists.")
    p.add_argument("--model",     choices=["xgb", "lgbm", "both"], default="both")
    p.add_argument("--test-days", type=float, default=2.0,
                   help="Test window in days (default 2). Fallback fraction split used if data is shallow.")
    p.add_argument("--no-save",   action="store_true", help="Skip saving model artifacts.")
    return p.parse_args()


def main() -> None:
    args = _parse_args()

    from db import get_engine
    from features import build_features, add_forecast_target, forecast_feasibility
    from split import time_split, print_split_report
    from sqlalchemy import text

    engine = get_engine()

    def _load(q: str) -> pd.DataFrame:
        with engine.connect() as conn:
            df = pd.read_sql(text(q), conn)
        df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
        return df

    print("Loading readings...", end="", flush=True)
    readings = _load("""
        SELECT r.station_id::text, s.city,
               r.timestamp AT TIME ZONE 'UTC' AS timestamp,
               r.aqi::float, r.pm25::float, r.data_source
        FROM readings r JOIN stations s ON s.id = r.station_id
        ORDER BY s.city, r.timestamp""")
    print(f" {len(readings):,} rows")

    print("Loading weather...", end="", flush=True)
    weather = _load("""
        SELECT w.station_id::text, s.city,
               w.timestamp AT TIME ZONE 'UTC' AS timestamp,
               w.temperature::float, w.wind_speed::float, w.humidity::float
        FROM weather w JOIN stations s ON s.id = w.station_id
        ORDER BY s.city, w.timestamp""")
    print(f" {len(weather):,} rows")

    print("Building features...")
    df = build_features(readings, weather)
    print(f"  Shape: {df.shape[0]:,} x {df.shape[1]}")

    # ── HONEST FEASIBILITY CHECK (always reported, even if feasible) ──────────
    print(f"\n--- Data feasibility for {args.horizon}h-ahead forecast ---")
    df = add_forecast_target(df, args.horizon)
    check = forecast_feasibility(df, args.horizon)

    print(f"  Dataset spans : {check['data_span_h']} h")
    print(f"  Horizon       : {check['horizon_h']} h")
    print(f"  Usable rows   : {check['usable_rows']}/{check['total_rows']} ({check['usable_pct']}%)")
    print(f"  Verdict       : {check['verdict']}")

    if not check["feasible"]:
        print()
        print("  STOPPING before training.")
        print("  Presenting results on 0 usable rows would be meaningless and dishonest.")
        print()
        print("  Current feasible horizons:")
        for h in [1, 6]:
            fh = forecast_feasibility(
                add_forecast_target(build_features(readings, weather), h), h
            )
            print(f"    --horizon {h:>2}  -->  {fh['usable_rows']:>4}/{fh['total_rows']} rows usable ({fh['usable_pct']}%)")
        print()
        print(f"  Re-run with --horizon 6 (recommended) or --horizon 1.")
        print(f"  Use --horizon {args.horizon} once the cron has accumulated >{args.horizon} h of data.")
        return

    # ── SPLIT ─────────────────────────────────────────────────────────────────
    print(f"\nSplitting (test_days={args.test_days})...")
    train_df, test_df, meta = time_split(df, test_days=args.test_days)
    print_split_report(train_df, test_df, meta)

    target_col = f"aqi_target_{args.horizon}h"
    tr_fill = train_df[target_col].notna().sum()
    te_fill = test_df[target_col].notna().sum()
    print(f"  Target fill TRAIN: {tr_fill}/{len(train_df)} ({100*tr_fill/len(train_df):.1f}%)")
    print(f"  Target fill TEST : {te_fill}/{len(test_df)} ({100*te_fill/len(test_df):.1f}%)")

    # ── TRAIN ─────────────────────────────────────────────────────────────────
    models_to_run = ["xgb", "lgbm"] if args.model == "both" else [args.model]
    all_results: list[pd.DataFrame] = []

    for model_name in models_to_run:
        results = train_and_evaluate(
            train_df, test_df,
            horizon_hours=args.horizon,
            model_name=model_name,
            save_artifacts=not args.no_save,
        )
        all_results.append(results)
        print_comparison_table(results, meta, args.horizon)

    # ── XGB vs LGBM side-by-side ──────────────────────────────────────────────
    if len(all_results) == 2 and all(not r.empty for r in all_results):
        xr = all_results[0][["city", "base_rmse", "model_rmse", "rmse_imp_pct"]].rename(
            columns={"model_rmse": "xgb_rmse", "rmse_imp_pct": "xgb_imp%"})
        lr = all_results[1][["city", "model_rmse", "rmse_imp_pct"]].rename(
            columns={"model_rmse": "lgbm_rmse", "rmse_imp_pct": "lgbm_imp%"})
        cmp = xr.merge(lr, on="city")
        cmp["best"] = cmp.apply(
            lambda r: "XGB" if r["xgb_rmse"] < r["lgbm_rmse"] else "LGBM", axis=1)
        print("\n  XGB vs LGBM head-to-head:")
        pd.set_option("display.float_format", "{:.3f}".format)
        print(cmp[["city", "base_rmse", "xgb_rmse", "xgb_imp%",
                    "lgbm_rmse", "lgbm_imp%", "best"]].to_string(index=False))
        wins = cmp["best"].value_counts()
        print(f"\n  XGB wins: {wins.get('XGB',0)}/{len(cmp)}   "
              f"LGBM wins: {wins.get('LGBM',0)}/{len(cmp)}")

    if not args.no_save:
        print(f"\n  Artifacts saved to: {_ARTIFACTS.resolve()}")


if __name__ == "__main__":
    main()
