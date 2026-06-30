"""
model/split.py — Temporal train/test split for time-series AQI data.

Public API
----------
    train_df, test_df, meta = time_split(df, test_days=2)

Why a random split is INVALID for this data
-------------------------------------------
Our feature matrix contains time-lagged and rolling features:

    aqi_lag_1h    — AQI value 1 hour before each row's timestamp
    aqi_lag_6h    — AQI value 6 hours before
    aqi_lag_24h   — AQI value 24 hours before
    aqi_roll24h   — rolling 24-hour mean up to that timestamp

If we shuffled rows randomly and assigned, say, 2026-06-29 22:00 to the TRAIN set
and 2026-06-29 21:00 to the TEST set, then:

  - The test row at 21:00 has aqi_lag_1h = AQI at 20:00.
  - The train row at 22:00 has aqi_lag_1h = AQI at 21:00 — which IS the target
    variable of a test row.

This is temporal data leakage: the model trains on features derived from timestamps
that appear in the test set, so it effectively "sees" future information during
training.  The resulting train score will be overfit and the test score will be
optimistic/misleading.

The correct split strategy for time series:
    - Establish a hard cutoff date T_cutoff.
    - Train set: all rows with timestamp < T_cutoff.
    - Test set:  all rows with timestamp >= T_cutoff.
    - No row in the test set contributes to any feature of a train row.

This preserves the causal order of the data and gives a realistic evaluation of
how the model performs when predicting future (unseen) hours.

Handling the "short dataset" case
----------------------------------
Our current readings span only ~22 hours (one full ingestion cycle).  A 2-day
test window would consume the entire dataset, leaving an empty train set.

time_split() handles this transparently:
  1. It computes the requested cutoff (max_ts - test_days).
  2. If that would leave < min_train_frac of the data in train, it FALLS BACK to
     a fraction-based split (default: last 30% of data = test) and emits a clear
     WARNING.
  3. The returned `meta` dict always records which strategy was used, the exact
     cutoff timestamp, and the resulting row counts, so callers can log or assert
     on these values.

Usage
-----
    python model/split.py                    # uses build_features internally
    python model/split.py --test-days 1      # last 1 day as test
    python model/split.py --test-frac 0.2   # fraction fallback threshold
"""

from __future__ import annotations

import argparse
import sys
import warnings
from pathlib import Path
from typing import Any

import pandas as pd

# Force UTF-8 on Windows so print() does not hit cp1252 limits
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# -- path setup ---------------------------------------------------------------
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT / "ingestion"))

from dotenv import load_dotenv
load_dotenv(dotenv_path=_ROOT / "ingestion" / ".env")
load_dotenv()


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

def time_split(
    df: pd.DataFrame,
    test_days: float = 2.0,
    min_train_frac: float = 0.30,
    timestamp_col: str = "timestamp",
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    """
    Split a time-series DataFrame into train and test by timestamp.

    Parameters
    ----------
    df : DataFrame
        Feature matrix from build_features().  Must contain `timestamp_col`.
    test_days : float
        Number of days to reserve for the test set, counting back from the
        maximum timestamp in the data.  Default: 2.
    min_train_frac : float
        Minimum fraction of total rows that must remain in the train set.
        If the requested test_days cutoff would produce a train set smaller
        than this fraction, the function falls back to a fraction-based cutoff
        and emits a UserWarning.  Default: 0.30 (30%).
    timestamp_col : str
        Name of the UTC-aware datetime column.  Default: "timestamp".

    Returns
    -------
    train_df : DataFrame  — rows with timestamp < cutoff, sorted by timestamp
    test_df  : DataFrame  — rows with timestamp >= cutoff, sorted by timestamp
    meta     : dict       — split metadata (see keys below)

    meta keys
    ---------
    strategy        "date_cutoff" | "fraction_fallback"
    cutoff          pd.Timestamp — the exact split boundary (UTC)
    test_days_req   float        — the requested test_days argument
    data_span_h     float        — total data span in hours
    train_rows      int
    test_rows       int
    train_pct       float        — % of rows in train
    test_pct        float        — % of rows in test
    train_start     pd.Timestamp
    train_end       pd.Timestamp
    test_start      pd.Timestamp
    test_end        pd.Timestamp
    """
    if timestamp_col not in df.columns:
        raise ValueError(f"Column '{timestamp_col}' not found in DataFrame.")

    ts = df[timestamp_col]
    t_min = ts.min()
    t_max = ts.max()
    span_h = (t_max - t_min).total_seconds() / 3600

    # ── Attempt the date-based cutoff ────────────────────────────────────────
    requested_cutoff = t_max - pd.Timedelta(days=test_days)
    train_mask_date  = ts < requested_cutoff
    train_frac_date  = train_mask_date.mean()

    if train_frac_date >= min_train_frac:
        # Happy path: enough data for a proper date-based split
        cutoff   = requested_cutoff
        strategy = "date_cutoff"
        mask     = train_mask_date
    else:
        # ── Fallback: fraction-based split ───────────────────────────────────
        # A random split would still be WRONG here (see module docstring).
        # We use a fraction-based TEMPORAL cutoff: sort by time, take the
        # first (1 - test_frac) rows as train, the rest as test.
        # The causal ordering is preserved — no data leakage.
        warnings.warn(
            f"\n"
            f"  [time_split] WARNING: Requested test_days={test_days} would leave only "
            f"{train_frac_date:.1%} of rows in train (< min_train_frac={min_train_frac:.0%}).\n"
            f"  Data span is only {span_h:.1f} h — the pipeline has not yet accumulated "
            f"{test_days} days of history.\n"
            f"  Falling back to a TEMPORAL fraction-based split (last 30% of rows = test).\n"
            f"  This maintains causal ordering — it is NOT a random split.\n"
            f"  Re-run with more ingested data for a proper {test_days}-day test window.",
            UserWarning,
            stacklevel=2,
        )
        df_sorted = df.sort_values(timestamp_col)
        cutoff_idx = int(len(df_sorted) * (1 - 0.30))
        cutoff = df_sorted[timestamp_col].iloc[cutoff_idx]
        strategy = "fraction_fallback"
        mask = ts < cutoff

    # ── Build the split ───────────────────────────────────────────────────────
    train_df = df[mask].sort_values(timestamp_col).reset_index(drop=True)
    test_df  = df[~mask].sort_values(timestamp_col).reset_index(drop=True)

    # ── Assertion: no temporal leakage ───────────────────────────────────────
    # This is the invariant that makes the split valid.  It must always hold.
    if not train_df.empty and not test_df.empty:
        assert train_df[timestamp_col].max() < test_df[timestamp_col].min(), (
            "SPLIT INVARIANT VIOLATED: latest train timestamp >= earliest test timestamp. "
            "This would constitute temporal data leakage."
        )

    # ── Build metadata ────────────────────────────────────────────────────────
    n = len(df)
    meta: dict[str, Any] = {
        "strategy":      strategy,
        "cutoff":        cutoff,
        "test_days_req": test_days,
        "data_span_h":   round(span_h, 2),
        "train_rows":    len(train_df),
        "test_rows":     len(test_df),
        "train_pct":     round(100 * len(train_df) / n, 1),
        "test_pct":      round(100 * len(test_df) / n, 1),
        "train_start":   train_df[timestamp_col].min() if not train_df.empty else None,
        "train_end":     train_df[timestamp_col].max() if not train_df.empty else None,
        "test_start":    test_df[timestamp_col].min()  if not test_df.empty  else None,
        "test_end":      test_df[timestamp_col].max()  if not test_df.empty  else None,
    }

    return train_df, test_df, meta


# ─────────────────────────────────────────────────────────────────────────────
# Pretty-printer
# ─────────────────────────────────────────────────────────────────────────────

def print_split_report(
    train_df: pd.DataFrame,
    test_df: pd.DataFrame,
    meta: dict[str, Any],
) -> None:
    """Print a human-readable split summary."""
    w = 68
    print()
    print("=" * w)
    print("  TRAIN / TEST SPLIT REPORT")
    print("=" * w)
    print(f"  Strategy      : {meta['strategy']}")
    print(f"  Cutoff (UTC)  : {meta['cutoff']}")
    print(f"  Data span     : {meta['data_span_h']} h")
    print(f"  Test days req : {meta['test_days_req']}")
    print()
    print(f"  TRAIN  {meta['train_rows']:>5} rows  ({meta['train_pct']}%)")
    if meta["train_start"]:
        print(f"         {meta['train_start']}  ->  {meta['train_end']}")
    else:
        print("         (empty)")
    print()
    print(f"  TEST   {meta['test_rows']:>5} rows  ({meta['test_pct']}%)")
    if meta["test_start"]:
        print(f"         {meta['test_start']}  ->  {meta['test_end']}")
    else:
        print("         (empty)")
    print()

    # Per-station breakdown
    ts_col = "timestamp"
    for label, part in [("TRAIN", train_df), ("TEST", test_df)]:
        if part.empty:
            continue
        print(f"  {label} — rows per station:")
        by_city = (
            part.groupby("city")[ts_col]
            .agg(count="count", first="min", last="max")
            .sort_values("count", ascending=False)
        )
        for city, row in by_city.iterrows():
            print(
                f"    {city:<18}  {row['count']:>4} rows  "
                f"{row['first'].strftime('%m-%d %H:%M')} -> {row['last'].strftime('%m-%d %H:%M')} UTC"
            )
        print()

    # Show first 10 train rows
    display_cols = [
        "city", "timestamp", "aqi", "aqi_lag_1h", "aqi_lag_6h",
        "aqi_roll24h", "temperature", "hour_of_day", "day_of_week",
    ]
    display_cols = [c for c in display_cols if c in train_df.columns]
    pd.set_option("display.max_columns", None)
    pd.set_option("display.width", 220)
    pd.set_option("display.float_format", "{:.2f}".format)

    print("  First 10 TRAIN rows:")
    print(train_df[display_cols].head(10).to_string(index=False))
    print()
    print("  First 10 TEST rows:")
    print(test_df[display_cols].head(10).to_string(index=False))
    print("=" * w)
    print()


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Temporal train/test split of the AQI feature matrix."
    )
    p.add_argument(
        "--test-days",
        type=float,
        default=2.0,
        help="Days to reserve as test set (default: 2).",
    )
    p.add_argument(
        "--min-train-frac",
        type=float,
        default=0.30,
        help="Minimum train fraction before fraction-fallback triggers (default: 0.30).",
    )
    return p.parse_args()


def main() -> None:
    args = _parse_args()

    # Import here so the module is importable without a live DB
    from db import get_engine          # noqa: PLC0415
    from features import build_features  # noqa: PLC0415
    from sqlalchemy import text        # noqa: PLC0415

    engine = get_engine()

    def _load(query: str) -> pd.DataFrame:
        with engine.connect() as conn:
            df = pd.read_sql(text(query), conn)
        df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
        return df

    print("Loading readings…", end="", flush=True)
    readings = _load("""
        SELECT r.station_id::text, s.city,
               r.timestamp AT TIME ZONE 'UTC' AS timestamp,
               r.aqi::float, r.pm25::float, r.data_source
        FROM readings r JOIN stations s ON s.id = r.station_id
        ORDER BY s.city, r.timestamp
    """)
    print(f" {len(readings):,} rows")

    print("Loading weather… ", end="", flush=True)
    weather = _load("""
        SELECT w.station_id::text, s.city,
               w.timestamp AT TIME ZONE 'UTC' AS timestamp,
               w.temperature::float, w.wind_speed::float, w.humidity::float
        FROM weather w JOIN stations s ON s.id = w.station_id
        ORDER BY s.city, w.timestamp
    """)
    print(f" {len(weather):,} rows")

    print("Building features…")
    df = build_features(readings, weather)
    print(f"  Feature matrix: {df.shape[0]:,} rows x {df.shape[1]} columns")

    print(f"Splitting (test_days={args.test_days})…")
    train_df, test_df, meta = time_split(
        df,
        test_days=args.test_days,
        min_train_frac=args.min_train_frac,
    )

    print_split_report(train_df, test_df, meta)


if __name__ == "__main__":
    main()
