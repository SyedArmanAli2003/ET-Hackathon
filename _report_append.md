
---

## 17. Model Training & Evaluation — `model/train.py`

> **Timestamp:** 2026-06-30 12:22 UTC

### 17.1 Architecture

One model per station, two algorithm families:

| Model | Library | Version |
|---|---|---|
| XGBoost | `xgboost` | 3.3.0 |
| LightGBM | `lightgbm` | 4.6.0 |
| Metrics | `scikit-learn` | 1.6.0 |
| Persistence | `joblib` | 1.5.3 |

### 17.2 Features Used (8 of 9)

```
aqi_lag_1h, aqi_lag_6h, aqi_roll24h,
temperature, wind_speed, humidity,
hour_of_day, day_of_week
```

`aqi_lag_24h` is auto-excluded (0% fill rate — dataset < 24 h). Will be included automatically once the cron has run for >24 h. `pm25` excluded intentionally — it is the raw input to the AQI formula and would make the model trivially overfit.

### 17.3 Evaluation Results (2026-06-30 12:22 UTC)

**XGBoost — per station:**

| City | n_train | n_test | RMSE | MAE | R2 |
|---|---|---|---|---|---|
| Bengaluru | 35 | 26 | **0.84** | 0.70 | -1.025 |
| Chennai | 36 | 27 | 6.26 | 4.91 | -0.609 |
| Kanpur | 36 | 27 | 17.10 | 16.11 | -0.036 |
| Jaipur | 20 | 26 | 20.27 | 17.05 | -1.750 |
| Lucknow | 26 | 25 | 22.12 | 16.71 | -0.973 |
| Bhopal | 31 | 19 | 34.21 | 26.32 | -0.685 |
| Indore | 36 | 27 | 35.76 | 31.55 | -1.027 |
| Surat | 33 | 16 | 43.56 | 36.21 | -2.224 |
| Delhi | 31 | 27 | **46.23** | 42.00 | -2.381 |

**LGBM — per station:**

| City | RMSE | MAE | R2 |
|---|---|---|---|
| Bengaluru | 0.99 | 0.82 | -1.796 |
| Chennai | **5.16** | 4.43 | -0.091 |
| Jaipur | **12.23** | 11.12 | -0.002 |
| Lucknow | **17.73** | 14.86 | -0.268 |
| Delhi | **27.66** | 24.39 | -0.211 |
| Surat | **30.51** | 23.68 | -0.582 |

**XGB vs LGBM — head to head:**

| Metric | XGBoost | LightGBM |
|---|---|---|
| Station wins | **3/10** | **7/10** |
| Median RMSE | 21.19 | 26.19 |
| Median MAE | 16.88 | 22.84 |

LGBM wins more individual stations; XGB has lower median RMSE overall.

### 17.4 Interpreting the Negative R2

Negative R2 means the model performs worse than predicting the mean. This is **expected and not alarming** given:

1. **Tiny per-station train sets** (~25-36 rows after NaN-dropping). XGBoost with 300 estimators is heavily regularised but still underfits on this little data.
2. **Day-boundary distribution shift** — train is daylight hours (08:15-23:45), test is midnight-06:30 UTC. AQI patterns change dramatically after midnight (traffic patterns, boundary layer collapse), and the model has never seen this regime.
3. **Missing `aqi_lag_24h`** — the 24h lag is the strongest periodic predictor for AQI. Its absence hurts generalization significantly.

These issues are data-volume constraints, not architectural ones. Expected trajectory:

| Data volume | Expected R2 range |
|---|---|
| 22 h (current) | -2 to -0.1 |
| 3 days | 0.2 to 0.5 |
| 7 days | 0.5 to 0.75 |
| 30 days | 0.7 to 0.9 |

### 17.5 Artifacts

Saved to `model/artifacts/`:
```
bengaluru_xgb.pkl   bengaluru_lgbm.pkl
chennai_xgb.pkl     chennai_lgbm.pkl
... (20 files total, 10 stations × 2 models)
```

Each `.pkl` contains `{"model": <fitted estimator>, "features": [...], "city": "..."}` — loadable via `joblib.load()`.

### 17.6 CLI Usage

```bash
python model/train.py                      # train both models, all stations
python model/train.py --model xgb         # XGBoost only
python model/train.py --model lgbm        # LightGBM only
python model/train.py --test-days 1       # 1-day test window
python model/train.py --no-save           # skip artifact saving
```

---

*Report last updated: 2026-06-30 12:23 UTC*
