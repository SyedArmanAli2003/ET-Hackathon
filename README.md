# SaanSLive — AI Air Quality Forecasting for India

[![GitHub Actions](https://github.com/SyedArmanAli2003/ET-Hackathon/actions/workflows/ingest.yml/badge.svg)](https://github.com/SyedArmanAli2003/ET-Hackathon/actions/workflows/ingest.yml)

**SaanSLive** is a real-time air quality monitoring and 6-hour AQI forecasting system for 20 major Indian cities. It ingests live PM2.5 readings from [OpenAQ](https://openaq.org), enriches them with weather data from [Open-Meteo](https://open-meteo.com), trains per-city XGBoost models, and serves predictions on a Next.js dashboard.

---

## Live Dashboard

The dashboard is served at `http://localhost:3000` (dev) and shows:
- **Interactive map** — 29+ station markers colored by real-time AQI band (EPA scale)
- **City selector** — 20 cities, all backed by live Supabase data
- **24h forecast chart** — model prediction line vs. persistence baseline (dashed)
- **Advisory panel** — plain-language health guidance based on forecast peak AQI

---

## Architecture Overview

```
OpenAQ API  ──┐
              ├──► ingestion/run_ingestion.py ──► Supabase Postgres
Open-Meteo ──┘          (GitHub Actions, every 5h)        │
                                                           │
model/train.py ──► model/artifacts/*.pkl                  │
model/predict.py ◄─────────────────────────────────────────┘
      │
      └──► forecasts table ──► frontend/saanslive (Next.js 16)
```

### Pipeline Steps (run_ingestion.py)

| Step | Script | Table | Description |
|------|--------|-------|-------------|
| 1 | `setup_stations.py` | `stations` | Sync 20 cities from OpenAQ, idempotent upsert |
| 2 | `ingest_readings.py` | `readings` | Fetch last 24h PM2.5 → AQI (US EPA formula) |
| 3 | `ingest_weather.py` | `weather` | Fetch last 24h hourly weather from Open-Meteo |
| 4 | `predict.py` | `forecasts` | Load XGBoost artifacts, write 6h AQI forecasts |

Each step is fault-isolated — a failure in one step never aborts the others.

---

## Repository Structure

```
ET-Hackathon/
├── schema.sql                        # Supabase Postgres schema (5 tables + RLS)
├── report.md                         # Full technical report & QA log
├── README.md                         # This file
├── start.bat                         # Windows one-click dev launcher
│
├── .github/workflows/
│   └── ingest.yml                    # Cron every 5h + manual dispatch
│
├── ingestion/
│   ├── config.py                     # 20 tracked Indian cities with lat/lng
│   ├── db.py                         # SQLAlchemy singleton engine
│   ├── setup_stations.py             # OpenAQ → stations (ON CONFLICT DO UPDATE)
│   ├── ingest_readings.py            # OpenAQ sensors → readings (ON CONFLICT DO NOTHING)
│   ├── ingest_weather.py             # Open-Meteo → weather (ON CONFLICT DO NOTHING)
│   ├── run_ingestion.py              # Master orchestrator, fault-isolated, exact counts
│   ├── explore_data.py               # EDA: console report + AQI PNG plot
│   └── requirements.txt             # Locked Python deps
│
├── model/
│   ├── features.py                   # build_features(readings, weather) → DataFrame
│   ├── split.py                      # time_split(df, test_days=2) → train/test/meta
│   ├── train.py                      # Per-city XGBoost/LightGBM training + evaluation
│   ├── predict.py                    # Load artifacts, run inference, write to forecasts
│   └── artifacts/                    # Trained .pkl files (one per city × model type)
│
└── frontend/saanslive/
    ├── .env.local                    # NEXT_PUBLIC_SUPABASE_URL + ANON_KEY (gitignored)
    ├── lib/
    │   ├── data.ts                   # Data layer — real Supabase queries for all 3 tables
    │   └── aqi.ts                    # AQI band mapping — single source of truth
    ├── components/
    │   ├── HeroSection.tsx           # Landing hero (no Leaflet)
    │   ├── StationMap.tsx            # Leaflet map with live AQI markers
    │   ├── ForecastChart.tsx         # Recharts 24h forecast + baseline
    │   └── AdvisoryPanel.tsx         # Health advisory with graceful empty state
    └── app/
        ├── page.tsx                  # Homepage — hero only
        └── dashboard/page.tsx        # Full dashboard with live data
```

---

## Getting Started

### Prerequisites

- Node.js 20+
- Python 3.11+
- A Supabase project (see Environment Variables)

### 1. Frontend (Next.js dashboard)

```bash
cd frontend/saanslive
npm install
# Create .env.local with:
# NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
# NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...
npm run dev
# Open http://localhost:3000
```

### 2. Ingestion Pipeline (Python)

```bash
cd ingestion
python -m venv venv
venv\Scripts\activate          # Windows
pip install -r requirements.txt

# Create .env with:
# SUPABASE_DB_URL=postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres
# OPENAQ_API_KEY=<your-key>

python run_ingestion.py                    # Full run, last 24h
python run_ingestion.py --hours 48         # Backfill 48h
python run_ingestion.py --skip-stations    # Skip station sync
python run_ingestion.py --dry-run          # Preview, no writes
```

### 3. ML Model

```bash
cd model
python train.py --model xgb --horizon 6   # Train XGBoost, 6h forecast
python predict.py --horizon 6             # Run inference on latest data
```

---

## GitHub Actions CI/CD

The pipeline runs automatically every 5 hours via cron (`17 */5 * * *`) and can be triggered manually from the Actions tab.

### Required Secrets

Go to **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|--------|-------|
| `SUPABASE_DB_URL` | `postgresql://postgres.<ref>:<password>@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres` |
| `OPENAQ_API_KEY` | Your OpenAQ v3 API key |

> ⚠️ **Region matters:** The pooler hostname must match your project region. This project uses `ap-southeast-1` (Singapore) → `aws-1-ap-southeast-1.pooler.supabase.com`. Using the wrong region causes every run to fail with `ENOTFOUND`.

---

## Database Schema

| Table | Rows (2026-07-08) | Description |
|-------|-------------------|-------------|
| `stations` | 29 | Monitoring stations (OpenAQ locations) |
| `readings` | 3,860 | PM2.5 / AQI readings |
| `weather` | 1,853 | Hourly temperature, wind, humidity |
| `forecasts` | 19 | XGBoost 6h AQI predictions |
| `user_profiles` | 0 | Session-based user preferences (reserved) |

All tables have RLS enabled. Sensor tables (`stations`, `readings`, `weather`, `forecasts`) are publicly readable via the anon key. Write access is restricted to `service_role` (ingestion pipeline only).

---

## AQI Color Scale

| AQI Range | Category | Color |
|-----------|----------|-------|
| 0 – 50 | Good | 🟢 Green |
| 51 – 100 | Moderate | 🟡 Yellow |
| 101 – 150 | Unhealthy for Sensitive Groups | 🟠 Orange |
| 151 – 200 | Unhealthy | 🔴 Red |
| 201 – 300 | Very Unhealthy | 🟣 Purple |
| 301+ | Hazardous | 🟤 Maroon |

All three UI components (map markers, forecast chart, advisory panel) use `lib/aqi.ts` as the single source of truth for this mapping.

---

## Model Performance (XGBoost, 6h horizon)

Trained on 22h of data (Jun 29–30, 2026). Median improvement over persistence baseline:

| Metric | Model | Persistence Baseline |
|--------|-------|----------------------|
| Median RMSE | 6.86 | 10.18 |
| Improvement | **+57.4%** | — |

6 out of 9 cities beat the persistence baseline. Performance improves significantly with more data — expected R² of 0.5–0.75 with 7 days of history.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, React 19, TypeScript |
| Mapping | Leaflet + react-leaflet |
| Charts | Recharts |
| Database | Supabase (PostgreSQL) |
| Data Client | @supabase/supabase-js |
| ML Models | XGBoost, LightGBM, scikit-learn |
| Ingestion | Python, SQLAlchemy, pandas, psycopg2 |
| CI/CD | GitHub Actions |

---

## Full Technical Report

See [`report.md`](./report.md) for the complete development log including:
- Schema design decisions and RLS policies
- Idempotency proofs for all ingestion steps
- Feature engineering rationale (time-based lags vs row-based)
- Model training results with honest assessment of negative R²
- CI/CD pipeline fix history (39 failed runs → fixed)
- Live data verification spot-checks

---

*Last updated: 2026-07-08*
