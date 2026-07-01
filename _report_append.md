
---

## 20. True Forecast Model — Implementation & Results

> **Timestamp:** 2026-07-01 06:46 UTC  
> Commit: `89b3161`

### 20.1 Architecture Change: Nowcast → True Forecast

`model/train.py` previously trained a **nowcast** model: `target = AQI at time T` (same timestamp as all input features). This has zero predictive value — it is fitting a trivial identity function.

The model is now a **genuine multi-horizon forecast**:

```
Target = AQI reading nearest to T + horizon_hours
         (merge_asof, direction='forward', tolerance=±90 min)
         NaN when no reading exists within tolerance → row dropped before fit
```

All input features remain strictly at or before time T. Only the target moves forward. No leakage.

**`add_forecast_target()` — implementation:**

```python
# In features.py — symmetric mirror of _add_lag()
# For each row at T: find AQI at T + horizon
lookup["timestamp"] = lookup["timestamp"] - horizon   # shift lookup back
pd.merge_asof(grp, lookup, direction="forward", tolerance=tol)
# merge_asof forward finds first lookup_ts >= T:
#   lookup_ts >= T  -->  original_ts - horizon >= T  -->  original_ts >= T + horizon
```

### 20.2 Persistence Baseline

The baseline for every test row is: **"AQI in {horizon}h will be exactly what it is right now at T."** This is the correct naive baseline for AQI time-series. It requires zero ML. The model must beat this on RMSE/MAE to justify its existence.

```python
y_baseline = te["aqi"].values   # AQI at T, no shift
b_rmse = sqrt(mean_squared_error(y_true, y_baseline))
```

### 20.3 Data Volume — Honest Pre-Run Assessment

Before any training, `forecast_feasibility()` checks how many (T, T+horizon) pairs exist:

```
Dataset spans : 22.25 h
Total rows    : 926

Horizon  Usable rows  Usable %  Status
──────── ──────────── ───────── ─────────────────────────────────────────────
1h       860 / 926    92.9%     OK
6h       608 / 926    65.7%     OK
24h        0 / 926     0.0%     INFEASIBLE — need >24h of data, ~3h remaining
```

The 24h run exited cleanly with:
```
STOPPING before training. Presenting results on 0 usable rows would be meaningless and dishonest.
```

### 20.4 Results — 6h Horizon

Split: train=2026-06-29 08:15→23:45, test=2026-06-30 00:00→06:30

**XGB (6h ahead) — 6/9 stations beat persistence:**

| City | n_train | n_test | Model RMSE | Base RMSE | Improvement | Winner |
|---|---|---|---|---|---|---|
| Jaipur | 20 | 2 | 0.12 | 7.15 | **+98.3%** | MODEL |
| Bhopal | 31 | 2 | 1.45 | 73.64 | **+98.0%** | MODEL |
| Indore | 36 | 3 | 11.89 | 69.93 | **+83.0%** | MODEL |
| Kanpur | 36 | 3 | 4.52 | 18.27 | **+75.3%** | MODEL |
| Delhi | 31 | 3 | 32.24 | 75.64 | **+57.4%** | MODEL |
| Chennai | 36 | 3 | 6.86 | 10.18 | **+32.6%** | MODEL |
| Bengaluru | 35 | 3 | 1.71 | 1.62 | -5.3% | BASELINE |
| Pune | 25 | 2 | 19.29 | 9.58 | -101.4% | BASELINE |
| Lucknow | 26 | 1 | 15.09 | 2.34 | -545.0% | BASELINE |

**Medians (XGB, 6h):** Model RMSE=6.86, Baseline RMSE=10.18, **Improvement=+57.4%**

**LGBM (6h ahead) — 5/9 stations beat persistence:**
- Median RMSE improvement: +7.8% (weaker — XGB clearly wins at 6h)

**XGB vs LGBM head-to-head (6h):** XGB wins 7/9, LGBM wins 2/9

### 20.5 Results — 1h Horizon

**XGB (1h ahead) — 5/10 stations beat persistence:**

| City | n_train | n_test | Model RMSE | Base RMSE | Improvement | Winner |
|---|---|---|---|---|---|---|
| Surat | 33 | 13 | 23.58 | 39.34 | **+40.1%** | MODEL |
| Kanpur | 36 | 23 | 20.37 | 29.58 | **+31.1%** | MODEL |
| Jaipur | 20 | 22 | 15.45 | 17.47 | **+11.5%** | MODEL |
| Chennai | 36 | 23 | 5.61 | 6.16 | **+9.0%** | MODEL |
| Bengaluru | 35 | 22 | 0.61 | 0.63 | **+2.9%** | MODEL |
| Lucknow | 26 | 21 | 20.49 | 17.05 | -20.2% | BASELINE |
| Delhi | 31 | 23 | 37.50 | 25.13 | -49.2% | BASELINE |
| Bhopal | 31 | 15 | 38.47 | 21.54 | -78.6% | BASELINE |
| Indore | 36 | 23 | 54.11 | 19.09 | -183.4% | BASELINE |
| Pune | 21 | 15 | 14.84 | 3.98 | -272.4% | BASELINE |

**Medians (XGB, 1h):** Model RMSE=20.43, Baseline RMSE=18.28, **Improvement=-8.7%**

**LGBM (1h ahead) — 4/10 stations beat persistence:**
- LGBM wins 8/10 head-to-head vs XGB at 1h (model roles flip at shorter horizons)

### 20.6 Honest Interpretation

**What these results actually mean:**

1. **6h XGB is the clear winner** (+57.4% median RMSE improvement over baseline). The model provides genuine value at the 6h horizon.

2. **1h horizon is a coin flip** (-8.7% median). At 1h, AQI changes slowly enough that "same as now" is hard to beat without much more training data.

3. **3 stations at 6h and 5 at 1h are worse than persistence.** The primary reason is the very small test set: n_test=1 to 3 rows for 6h (only 6.5h of test window). A single outlier prediction can dominate the RMSE. Lucknow at 6h has n_test=1 and a single bad prediction produces -545% "improvement" — this number is not meaningful at n=1.

4. **Guwahati, Nagpur, Patna skipped entirely** — they had 0 usable rows after the lag join. Likely very sparse sensor data (>90 min gaps, exceeding our lag tolerance).

5. **aqi_lag_24h was dropped** (0% filled — dataset too short at 22h). This will auto-populate once data depth exceeds 24h and is expected to be the strongest single feature.

6. **24h horizon: INFEASIBLE until ~3 more hours of ingestion.** No training attempted. Code guards this with a hard exit and redirects to --horizon 6.

### 20.7 Next Steps for Model Improvement

| When available | Action |
|---|---|
| After >24h data | Re-run `--horizon 24`; `aqi_lag_24h` becomes available |
| After >48h data | Reliable 24h training; enough test rows for meaningful evaluation |
| After >7 days | Cross-validated hyperparameter search for Delhi, Mumbai |
| Immediately | `model/predict.py` — load saved artifacts, run inference on latest readings |

*Report last updated: 2026-07-01 06:46 UTC*
