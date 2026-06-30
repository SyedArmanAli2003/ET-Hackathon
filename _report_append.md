---

## 12. Data Exploration — `ingestion/explore_data.py`

> **Timestamp:** 2026-06-30 08:52 UTC

### 12.1 Purpose
Standalone diagnostic script: loads `readings` + `weather` from Supabase into pandas, prints a full console report, and saves a PNG plot. Uses `matplotlib.use("Agg")` — non-interactive backend — so it is safe in headless/CI environments.

### 12.2 Console Report Covers
- Date range and total rows per table
- Row count per station (descending)
- Null audit for all critical columns
- AQI stats per station: min / mean / max
- Temperature stats per station: min / mean / max

### 12.3 Plot Output
`ingestion/aqi_over_time.png` — dark-themed line chart, AQI over time for the top N stations by data volume, with US EPA health band reference lines (Good=50, Moderate=100, Unhealthy(sens.)=150, Unhealthy=200).

### 12.4 Live Results (2026-06-30 08:53 UTC)

| Metric | Value |
|---|---|
| Readings loaded | 926 rows, 14 stations |
| Date range | 2026-06-29 08:15 -> 2026-06-30 06:30 UTC |
| Null audit | No nulls found |
| Highest mean AQI | Jaipur: 131.6 (range 106-158) |
| Lowest mean AQI | Pune: 48.2 (range 28-78) |
| Hottest city (mean) | Delhi: 36.9°C, max 41.6°C |
| Coolest city (mean) | Bengaluru: 22.6°C |

### 12.5 CLI Usage
```bash
python ingestion/explore_data.py                         # top 3 stations on plot
python ingestion/explore_data.py --top-n 5              # top 5 on plot
python ingestion/explore_data.py --output reports/aqi.png
```

---

## 13. Feature Engineering — `model/features.py`

> **Timestamp:** 2026-06-30 08:55 UTC

### 13.1 Purpose
Transforms raw `readings` + `weather` DataFrames into an ML-ready feature matrix. Importable (`from model.features import build_features`) or runnable as a standalone sanity-check script.

### 13.2 Feature Set

| Column | Source | Description |
|---|---|---|
| `temperature` | Weather join | Nearest-hour temperature (°C) |
| `wind_speed` | Weather join | Nearest-hour wind speed (m/s) |
| `humidity` | Weather join | Nearest-hour relative humidity (%) |
| `aqi_lag_1h` | Lag | AQI ~1 h before the reading timestamp |
| `aqi_lag_6h` | Lag | AQI ~6 h before |
| `aqi_lag_24h` | Lag | AQI ~24 h before |
| `aqi_roll24h` | Rolling | Rolling 24 h mean AQI per station |
| `hour_of_day` | Calendar | UTC hour (0-23) |
| `day_of_week` | Calendar | 0=Monday ... 6=Sunday |

**Output: 926 rows x 15 columns**

### 13.3 Why Lags Are Time-Based, Not Row-Based

Live SQL showed readings arrive at irregular intervals:

| Station group | Avg gap |
|---|---|
| Kanpur / Chennai / Indore | ~15.5 min |
| Bengaluru / Delhi | ~16-17 min |
| Patna | ~26 min |
| Nagpur / Guwahati | ~70-78 min |

`shift(4)` on Kanpur = ~1 hour ✅ but `shift(4)` on Nagpur = ~4.7 hours ❌. Row-based shifts are station-dependent and wrong.

Instead each lag uses **`pd.merge_asof` with `direction='backward'`** per station, with calibrated tolerances:

| Lag | Tolerance |
|---|---|
| 1 h | ±45 min |
| 6 h | ±45 min |
| 24 h | ±90 min (wider for sparse stations) |

If no observation falls within the tolerance the lag is `NaN` — the correct ML signal for a data gap, not a fabricated value.

### 13.4 Live Fill-Rate (2026-06-30 08:57 UTC)

```
aqi_lag_1h   : 851/926 filled (91.9%)
aqi_lag_6h   : 589/926 filled (63.6%)
aqi_lag_24h  :   0/926 filled  (0.0%)  <- dataset only 22 h deep; self-corrects after 24 h of cron
temperature  : 926/926 filled (100.0%)
wind_speed   : 926/926 filled (100.0%)
humidity     : 926/926 filled (100.0%)
```

### 13.5 CLI Usage
```bash
python model/features.py                    # auto-selects station with best lag coverage
python model/features.py --station Delhi    # show Delhi rows
python model/features.py --rows 20
```

---

## 14. Temporal Train / Test Split — `model/split.py`

> **Timestamp:** 2026-06-30 12:00 UTC

### 14.1 Why Random Split Is Invalid

The feature matrix contains time-lagged features. With a random shuffle:

- A **test** row at `Jun 29 21:00` has `aqi_lag_1h` = AQI at `Jun 29 20:00`.
- A **train** row at `Jun 29 22:00` has `aqi_lag_1h` = AQI at `Jun 29 21:00` — which IS the test row's target.

This is **temporal data leakage**: the model trains on features derived from test-set timestamps, seeing future information. Evaluation becomes meaningless.

### 14.2 Split Logic

```
T_cutoff = max_timestamp - test_days

Train : timestamp <  T_cutoff
Test  : timestamp >= T_cutoff
```

**Invariant asserted in code:**
```python
assert train_df["timestamp"].max() < test_df["timestamp"].min()
# "SPLIT INVARIANT VIOLATED: temporal data leakage"
```

### 14.3 Short-Dataset Fallback

With only ~22 h of data, a 2-day test window would leave 0% in train. `time_split()` detects this via `min_train_frac=0.30` and falls back to a **temporal 70/30 fraction split** — still chronologically ordered, still no leakage — emitting a `UserWarning`. Switches automatically to true date cutoff once >2 days of history exist.

### 14.4 Live Split Results (2026-06-30 12:10 UTC)

```
Strategy : fraction_fallback  (data span = 22.25 h < requested 2 days)
Cutoff   : 2026-06-30 00:00:00 UTC

TRAIN  648 rows (70%)   2026-06-29 08:15 -> 2026-06-29 23:45 UTC
TEST   278 rows (30%)   2026-06-30 00:00 -> 2026-06-30 06:30 UTC
```

Split boundary fell cleanly at midnight UTC — train = all of Jun 29, test = early hours of Jun 30. All 14 stations appear in both sets.

### 14.5 Public API
```python
from model.split import time_split, print_split_report

train_df, test_df, meta = time_split(df, test_days=2)
print_split_report(train_df, test_df, meta)

# meta keys:
#   strategy, cutoff, data_span_h,
#   train_rows, test_rows, train_pct, test_pct,
#   train_start, train_end, test_start, test_end
```

### 14.6 CLI Usage
```bash
python model/split.py                          # default 2-day test window
python model/split.py --test-days 1           # 1-day test window
python model/split.py --min-train-frac 0.5    # require >=50% in train before fallback
```

---

## 15. Project File Structure (as of 2026-06-30 12:13 UTC)

```
ET-Hackathon/
├── schema.sql                        # Supabase Postgres schema (5 tables)
├── report.md                         # This document
├── .github/
│   └── workflows/
│       └── ingest.yml                # GitHub Actions cron every 5 h + manual dispatch
├── ingestion/
│   ├── .env                          # SUPABASE_DB_URL, OPENAQ_API_KEY (gitignored)
│   ├── requirements.txt              # pinned deps incl. matplotlib 3.11
│   ├── config.py                     # 20 tracked Indian cities with lat/lng
│   ├── db.py                         # SQLAlchemy singleton engine
│   ├── setup_stations.py             # OpenAQ -> stations (ON CONFLICT DO UPDATE)
│   ├── ingest_readings.py            # OpenAQ sensors -> readings (ON CONFLICT DO NOTHING)
│   ├── ingest_weather.py             # Open-Meteo -> weather (ON CONFLICT DO NOTHING)
│   ├── run_ingestion.py              # master orchestrator, fault-isolated, exact counts
│   ├── explore_data.py               # EDA: console report + AQI PNG plot
│   └── aqi_over_time.png             # saved plot output
└── model/
    ├── features.py                   # build_features(readings, weather) -> DataFrame
    └── split.py                      # time_split(df, test_days=2) -> train, test, meta
```

---

## 16. Next Steps

| Priority | Task | Target file |
|---|---|---|
| 1 | Train baseline model (XGBoost / LightGBM) on `train_df` | `model/train.py` |
| 2 | Evaluate on `test_df`, compute RMSE/MAE per station | `model/evaluate.py` |
| 3 | Write predictions to `forecasts` table | `model/predict.py` |
| 4 | Add RLS policies for client-side Supabase access | SQL migration |
| 5 | Build Next.js frontend with live AQI map + `getOrCreateProfile` | `frontend/` |
| 6 | `aqi_lag_24h` will auto-populate once cron has run >24 h | (automatic) |

---

*Report last updated: 2026-06-30 12:14 UTC*
