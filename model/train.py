"""
model/train.py — Train and evaluate AQI forecasting models.

What this script does
---------------------
1. Loads readings + weather from Supabase via SQLAlchemy.
2. Builds the feature matrix (build_features from features.py).
3. Splits into train / test by time (time_split from split.py).
4. Trains TWO baseline models per station:
     - XGBoost (gradient-boosted trees, fast, strong baseline)
     - LightGBM (gradient-boosted trees, faster on large datasets)
   Both are trained in a multi-output fashion: one model per station,
   predicting AQI for that station at the next measurement time.
5. Evaluates on the held-out test set (RMSE, MAE, R2 per station).
6. Saves the best model per station to model/artifacts/<station>.pkl
   (using joblib, which is more reliable than pickle for sklearn/xgb).
7. Prints a ranked summary table.

Target variable
---------------
AQI at the CURRENT timestamp (nowcast / 1-step-ahead proxy).
With only ~22 h of data we cannot yet do true multi-step forecasting.
The model learns: given these features right now, what is the AQI?
Once the pipeline has >48 h of data, shift the target by N steps to
predict N-hours-ahead AQI.

Feature columns used
--------------------
aqi_lag_1h, aqi_lag_6h, aqi_roll24h,
temperature, wind_speed, humidity,
hour_of_day, day_of_week

Columns intentionally excluded
-------------------------------
aqi_lag_24h — 0% fill rate currently (dataset < 24 h deep); added
              automatically once filled.
pm25        — near-perfect linear correlation with AQI (it IS aqi),
              would make the model trivially accurate and useless.
station_id  — raw UUID, not meaningful as a feature; station identity
              is handled by training one model per station.

Usage
-----
    python model/train.py                      # train both models, all stations
    python model/train.py --model xgb         # XGBoost only
    python model/train.py --model lgbm        # LightGBM only
    python model/train.py --test-days 1       # override split window
    python model/train.py --no-save           # skip saving artifacts
"""

from __future__ import annotations

import argparse
import os
import sys
import warnings
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

# Force UTF-8 on Windows terminals
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# -- path setup ---------------------------------------------------------------
_ROOT = Path(__file__).resolve().parent.parent
_ARTIFACTS_DIR = Path(__file__).resolve().parent / "artifacts"
sys.path.insert(0, str(_ROOT / "ingestion"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from dotenv import load_dotenv
load_dotenv(dotenv_path=_ROOT / "ingestion" / ".env")
load_dotenv()


# ─────────────────────────────────────────────────────────────────────────────
# Feature configuration
# ─────────────────────────────────────────────────────────────────────────────

# All candidate features in priority order.
# Columns absent from the DataFrame (e.g. aqi_lag_24h when data < 24h) are
# silently dropped before training, so this list is future-proof.
_ALL_FEATURES = [
    "aqi_lag_1h",
    "aqi_lag_6h",
    "aqi_lag_24h",      # NaN until >24h of data; excluded automatically
    "aqi_roll24h",
    "temperature",
    "wind_speed",
    "humidity",
    "hour_of_day",
    "day_of_week",
]

_TARGET = "aqi"


# ─────────────────────────────────────────────────────────────────────────────
# Model factories
# ─────────────────────────────────────────────────────────────────────────────

def _make_xgb(**kwargs):
    from xgboost import XGBRegressor
    defaults = dict(
        n_estimators=300,
        learning_rate=0.05,
        max_depth=4,
        subsample=0.8,
        colsample_bytree=0.8,
        random_state=42,
        n_jobs=-1,
        verbosity=0,
    )
    defaults.update(kwargs)
    return XGBRegressor(**defaults)


def _make_lgbm(**kwargs):
    from lightgbm import LGBMRegressor
    defaults = dict(
        n_estimators=300,
        learning_rate=0.05,
        max_depth=4,
        subsample=0.8,
        colsample_bytree=0.8,
        random_state=42,
        n_jobs=-1,
        verbose=-1,
    )
    defaults.update(kwargs)
    return LGBMRegressor(**defaults)


_MODEL_FACTORIES = {
    "xgb":  _make_xgb,
    "lgbm": _make_lgbm,
}


# ─────────────────────────────────────────────────────────────────────────────
# Training & evaluation
# ─────────────────────────────────────────────────────────────────────────────

def _resolve_features(df: pd.DataFrame) -> list[str]:
    """Return the subset of _ALL_FEATURES that exist and have enough non-NaN rows."""
    present = [c for c in _ALL_FEATURES if c in df.columns]
    # Drop any column that is entirely NaN (e.g. aqi_lag_24h on short datasets)
    usable = [c for c in present if df[c].notna().sum() > 0]
    dropped = set(present) - set(usable)
    if dropped:
        print(f"  [features] Dropping all-NaN columns: {sorted(dropped)}")
    return usable


def _prepare_station(
    df: pd.DataFrame,
    city: str,
    feature_cols: list[str],
) -> tuple[pd.DataFrame, pd.Series]:
    """
    Subset to one city, drop rows where ANY feature or target is NaN,
    and return (X, y).
    """
    sub = df[df["city"] == city].copy()
    cols = feature_cols + [_TARGET]
    sub = sub.dropna(subset=cols)
    X = sub[feature_cols].reset_index(drop=True)
    y = sub[_TARGET].reset_index(drop=True)
    return X, y


def train_and_evaluate(
    train_df: pd.DataFrame,
    test_df: pd.DataFrame,
    model_name: str = "xgb",
    save_artifacts: bool = True,
) -> pd.DataFrame:
    """
    Train one model per station on train_df, evaluate on test_df.

    Returns a DataFrame with columns:
        city, model, n_train, n_test, features_used,
        rmse, mae, r2
    sorted by RMSE ascending (best first).
    """
    factory      = _MODEL_FACTORIES[model_name]
    feature_cols = _resolve_features(train_df)
    cities       = sorted(train_df["city"].unique())
    records: list[dict[str, Any]] = []

    if save_artifacts:
        _ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)

    print(f"\n  Training {model_name.upper()} on {len(cities)} station(s)...")
    print(f"  Features ({len(feature_cols)}): {feature_cols}\n")

    for city in cities:
        X_train, y_train = _prepare_station(train_df, city, feature_cols)
        X_test,  y_test  = _prepare_station(test_df,  city, feature_cols)

        if len(X_train) < 5:
            print(f"  [{city}] SKIP — only {len(X_train)} train rows after dropping NaNs")
            continue
        if len(X_test) == 0:
            print(f"  [{city}] SKIP — no test rows after dropping NaNs")
            continue

        model = factory()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            model.fit(X_train, y_train)

        y_pred = model.predict(X_test)
        rmse = float(np.sqrt(mean_squared_error(y_test, y_pred)))
        mae  = float(mean_absolute_error(y_test, y_pred))
        r2   = float(r2_score(y_test, y_pred))

        print(
            f"  [{city:<18}]  train={len(X_train):>3}  test={len(X_test):>3}"
            f"  RMSE={rmse:>6.2f}  MAE={mae:>6.2f}  R2={r2:>+.3f}"
        )

        if save_artifacts:
            artifact_path = _ARTIFACTS_DIR / f"{city.lower().replace(' ', '_')}_{model_name}.pkl"
            joblib.dump({"model": model, "features": feature_cols, "city": city}, artifact_path)

        records.append({
            "city":          city,
            "model":         model_name,
            "n_train":       len(X_train),
            "n_test":        len(X_test),
            "features_used": len(feature_cols),
            "rmse":          round(rmse, 4),
            "mae":           round(mae, 4),
            "r2":            round(r2, 4),
        })

    results = pd.DataFrame(records).sort_values("rmse").reset_index(drop=True)
    return results


def print_summary(results: pd.DataFrame, split_meta: dict) -> None:
    """Print a ranked summary table and overall stats."""
    w = 72
    print()
    print("=" * w)
    print("  MODEL EVALUATION SUMMARY")
    print("=" * w)
    print(f"  Split strategy : {split_meta['strategy']}")
    print(f"  Train period   : {split_meta['train_start']} -> {split_meta['train_end']}")
    print(f"  Test period    : {split_meta['test_start']}  -> {split_meta['test_end']}")
    print()

    pd.set_option("display.float_format", "{:.4f}".format)
    pd.set_option("display.max_columns", None)
    pd.set_option("display.width", 200)

    print(results[["city", "model", "n_train", "n_test", "rmse", "mae", "r2"]].to_string(index=False))

    if not results.empty:
        print()
        print(f"  Across {len(results)} stations:")
        print(f"    Median RMSE : {results['rmse'].median():.2f}")
        print(f"    Median MAE  : {results['mae'].median():.2f}")
        print(f"    Median R2   : {results['r2'].median():.3f}")
        best = results.iloc[0]
        worst = results.iloc[-1]
        print(f"    Best  city  : {best['city']} (RMSE {best['rmse']:.2f})")
        print(f"    Worst city  : {worst['city']} (RMSE {worst['rmse']:.2f})")
    print("=" * w)
    print()


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Train AQI forecasting models per station.")
    p.add_argument(
        "--model", choices=["xgb", "lgbm", "both"], default="both",
        help="Which model to train (default: both).",
    )
    p.add_argument(
        "--test-days", type=float, default=2.0,
        help="Days to reserve for the test set (default: 2).",
    )
    p.add_argument(
        "--no-save", action="store_true",
        help="Skip saving model artifacts to disk.",
    )
    return p.parse_args()


def main() -> None:
    args = _parse_args()

    from db import get_engine
    from features import build_features
    from split import time_split, print_split_report
    from sqlalchemy import text

    engine = get_engine()

    def _load(query: str) -> pd.DataFrame:
        with engine.connect() as conn:
            df = pd.read_sql(text(query), conn)
        df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
        return df

    print("Loading readings...", end="", flush=True)
    readings = _load("""
        SELECT r.station_id::text, s.city,
               r.timestamp AT TIME ZONE 'UTC' AS timestamp,
               r.aqi::float, r.pm25::float, r.data_source
        FROM readings r JOIN stations s ON s.id = r.station_id
        ORDER BY s.city, r.timestamp
    """)
    print(f" {len(readings):,} rows")

    print("Loading weather...", end="", flush=True)
    weather = _load("""
        SELECT w.station_id::text, s.city,
               w.timestamp AT TIME ZONE 'UTC' AS timestamp,
               w.temperature::float, w.wind_speed::float, w.humidity::float
        FROM weather w JOIN stations s ON s.id = w.station_id
        ORDER BY s.city, w.timestamp
    """)
    print(f" {len(weather):,} rows")

    print("Building features...")
    df = build_features(readings, weather)
    print(f"  Shape: {df.shape[0]:,} x {df.shape[1]}")

    print(f"Splitting (test_days={args.test_days})...")
    train_df, test_df, meta = time_split(df, test_days=args.test_days)
    print_split_report(train_df, test_df, meta)

    models_to_run = ["xgb", "lgbm"] if args.model == "both" else [args.model]
    all_results: list[pd.DataFrame] = []

    for model_name in models_to_run:
        results = train_and_evaluate(
            train_df, test_df,
            model_name=model_name,
            save_artifacts=not args.no_save,
        )
        all_results.append(results)
        print_summary(results, meta)

    if len(all_results) == 2 and not all_results[0].empty and not all_results[1].empty:
        # Side-by-side comparison
        xgb_r  = all_results[0][["city", "rmse", "mae"]].rename(columns={"rmse": "xgb_rmse", "mae": "xgb_mae"})
        lgbm_r = all_results[1][["city", "rmse", "mae"]].rename(columns={"rmse": "lgbm_rmse", "mae": "lgbm_mae"})
        cmp = xgb_r.merge(lgbm_r, on="city")
        cmp["winner"] = cmp.apply(
            lambda r: "XGB" if r["xgb_rmse"] < r["lgbm_rmse"] else "LGBM", axis=1
        )
        print()
        print("  XGB vs LGBM comparison:")
        print(cmp[["city", "xgb_rmse", "lgbm_rmse", "xgb_mae", "lgbm_mae", "winner"]].to_string(index=False))
        wins = cmp["winner"].value_counts()
        print(f"\n  XGB wins: {wins.get('XGB', 0)}/{len(cmp)}   LGBM wins: {wins.get('LGBM', 0)}/{len(cmp)}")

    if not args.no_save:
        print(f"\n  Artifacts saved to: {_ARTIFACTS_DIR.resolve()}")


if __name__ == "__main__":
    main()
