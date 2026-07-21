# SaanSLive — AI Air Quality Forecasting for India

[![GitHub Actions](https://github.com/SyedArmanAli2003/ET-Hackathon/actions/workflows/ingest.yml/badge.svg)](https://github.com/SyedArmanAli2003/ET-Hackathon/actions/workflows/ingest.yml)

**SaanSLive** is a real-time air quality monitoring and 6-hour AQI forecasting system for 20 major Indian cities (53 monitoring stations). It ingests live PM2.5 readings from [OpenAQ](https://openaq.org), enriches them with weather data from [Open-Meteo](https://open-meteo.com), trains per-city XGBoost/LightGBM models, and serves forecasts, city-level comparisons, and a transparent hotspot-prioritization ranking on a Next.js dashboard — plus an AI chatbot and AI-polished health advisories, all grounded in real Supabase queries.

---

## Live Dashboard

Served at `/dashboard` (three tabs, one route — no fragmented pages):

- **Overview** — interactive Leaflet map with 53 station markers colored by real-time AQI band, city selector, 24h forecast chart (model prediction vs. persistence baseline, dashed), and an AI-polished health advisory panel.
- **Hotspot Prioritization** — ranks every station across every city by urgency, using only real numbers from `readings`: current AQI severity (60% weight) + 7-day trend vs the prior week (40% weight). Both components are shown separately, not just a combined score, so the ranking is auditable. Carries an explicit disclaimer that it is *not* based on registered pollution-source data — that data doesn't exist in this schema.
- **Compare Cities** — current AQI vs next-24h forecast, averaged across all of a city's stations, side-by-side as a sortable table or a Recharts bar chart. Cities where no station has a trained model yet show "Forecast pending" — never a fabricated number.

A floating AI chatbot (bottom-right, every page) answers AQI/forecast questions by calling real Supabase-backed tools — it cannot invent numbers, only report what a tool actually returned.

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
                                      │
                                      ├─► lib/data.ts ──► dashboard tabs
                                      │      (Overview / Hotspot / Compare)
                                      │
                                      └─► lib/chatTools.ts ──► AI chatbot
                                             + app/api/advisory ──► AI advisory
```

### Pipeline Steps (run_ingestion.py)

| Step | Script | Table | Description |
|------|--------|-------|-------------|
| 1 | `setup_stations.py` | `stations` | Sync 20 cities from OpenAQ, idempotent upsert |
| 2 | `ingest_readings.py` | `readings` | Fetch last 24h PM2.5 → AQI (US EPA formula) |
| 3 | `ingest_weather.py` | `weather` | Fetch last 24h hourly weather from Open-Meteo |
| 4 | `predict.py` | `forecasts` | Load XGBoost artifacts, write 6h AQI forecasts |

Each step is fault-isolated — a failure in one step never aborts the others. Model *training* (`train.py`) is run manually/on-demand, not on every ingestion cycle; `predict.py` runs every cycle against whatever artifacts currently exist in `model/artifacts/`.

---

## Repository Structure

```
ET-Hackathon/
├── schema.sql                        # Supabase Postgres schema (5 tables + RLS)
├── report.md                         # Full technical report & QA log
├── kiro.md                           # Session-by-session build log (Kiro agent)
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
│   └── requirements.txt              # Locked Python deps
│
├── model/
│   ├── features.py                   # build_features / add_forecast_target / forecast_feasibility
│   ├── split.py                      # time_split(df, test_days=2) → train/test/meta (no leakage)
│   ├── train.py                      # Per-city XGBoost/LightGBM training + persistence-baseline eval
│   ├── predict.py                    # Load artifacts, run inference, write to forecasts
│   └── artifacts/                    # Trained .pkl files — one per city × model type × horizon
│
├── supabase/
│   ├── config.toml                   # Supabase CLI project config
│   └── migrations/                   # Schema + Postgres function migrations (source of truth)
│
└── frontend/saanslive/
    ├── .env.local                    # NEXT_PUBLIC_SUPABASE_URL + ANON_KEY (gitignored)
    ├── lib/
    │   ├── data.ts                   # Data layer — the ONLY file that queries Supabase directly
    │   │                             #   getStations, getCurrentReading, getLatestForecasts,
    │   │                             #   getHotspotRanking, getCityComparison
    │   ├── aqi.ts                    # AQI band mapping — single source of truth for all UI
    │   ├── chatTools.ts               # Real Supabase-backed tool implementations for the chatbot
    │   ├── generateAdvisory.ts       # Client-side template + calls /api/advisory to polish it
    │   ├── nimModels.ts               # NVIDIA NIM model registry, default selection, settings
    │   ├── geolocation.ts             # Browser geolocation → nearest-station lookup
    │   ├── localPreferences.ts        # Per-device onboarding preferences (localStorage)
    │   └── supabaseClient.ts          # Single shared Supabase client instance
    ├── components/
    │   ├── HeroSection.tsx           # Landing hero (canvas-free cursor-reveal effect)
    │   ├── StationMap.tsx            # Leaflet map with live AQI markers
    │   ├── ForecastChart.tsx         # Recharts 24h forecast + persistence baseline
    │   ├── AdvisoryPanel.tsx         # AI-polished health advisory with template fallback
    │   ├── HotspotPanel.tsx          # "Hotspot Prioritization" ranked table + disclaimer
    │   ├── CityComparisonView.tsx    # "Compare Cities" sortable table / bar chart toggle
    │   ├── AqiChatbot.tsx            # Floating tool-calling AI chatbot
    │   ├── OnboardingModal.tsx       # First-visit personalization modal
    │   └── Skeleton.tsx              # Shared loading placeholders
    └── app/
        ├── page.tsx                  # Homepage — hero only
        ├── about/page.tsx            # About page
        ├── dashboard/page.tsx        # Dashboard: Overview / Hotspot Prioritization / Compare Cities tabs
        └── api/
            ├── advisory/route.ts     # Server-side LLM cascade for advisory rephrasing
            └── chat/route.ts         # Server-side tool-calling loop for the AI chatbot
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
# NVIDIA_NIM_API_KEY=...          (server-only — powers chatbot + advisory rephrasing)
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
python train.py --model both --horizon 6   # Train XGBoost + LightGBM, 6h forecast, all feasible cities
python predict.py --horizon 6 --model xgb   # Run inference on latest data, write to forecasts table
```

`train.py` automatically skips any city with fewer than 5 usable rows after the NaN drop and prints exactly why (e.g. a station with zero readings, or too little history for a 24h lag feature) — it never silently produces nothing for a city it can't train.

---

## GitHub Actions CI/CD

The ingestion pipeline runs automatically every 5 hours via cron (`17 */5 * * *`) and can be triggered manually from the Actions tab. Model **training** is a separate, manual step (`model/train.py`) — retrain whenever the station list or data volume changes meaningfully; `predict.py` alone runs on the automated schedule.

### Required Secrets

Go to **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|--------|-------|
| `SUPABASE_DB_URL` | `postgresql://postgres.<ref>:<password>@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres` |
| `OPENAQ_API_KEY` | Your OpenAQ v3 API key |

> ⚠️ **Region matters:** The pooler hostname must match your project region. This project uses `ap-southeast-1` (Singapore) → `aws-1-ap-southeast-1.pooler.supabase.com`. Using the wrong region causes every run to fail with `ENOTFOUND`.

---

## Database Schema

| Table | Rows (2026-07-21) | Description |
|-------|-------------------|--------------|
| `stations` | 53 | Monitoring stations across 20 Indian cities |
| `readings` | 47,310 | PM2.5 / AQI readings |
| `weather` | 17,099 | Hourly temperature, wind, humidity |
| `forecasts` | 145 | XGBoost 6h AQI predictions |
| `user_profiles` | 0 | Per-Supabase-Auth-user onboarding preferences (reserved) |

All tables have RLS enabled. Sensor tables (`stations`, `readings`, `weather`, `forecasts`) are publicly readable via the anon key. Write access is restricted to `service_role` (ingestion pipeline only). A dedicated Postgres function, `get_hotspot_ranking_stats()` (`SECURITY INVOKER`, `search_path` locked), computes current/weekly AQI aggregates server-side for the Hotspot Prioritization tab and is `GRANT EXECUTE`'d to `anon`/`authenticated`.

Of the 20 tracked cities, **18 currently have live readings/forecasts**; **Kochi** and **Visakhapatnam** have zero ingested readings so far (a data-availability gap, not a modeling one) — both are excluded from `train.py` before training even starts, and the dashboard shows "Forecast pending" for them honestly rather than fabricating a value.

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

All dashboard components (map markers, forecast chart, advisory panel, Hotspot Prioritization, Compare Cities) use `lib/aqi.ts` as the single source of truth for this mapping.

---

## Model Performance (XGBoost, 6h horizon)

Retrained on the full current dataset — 47,310 readings, 522h span, all 20 cities queried (18 trainable). Time-based train/test split (last 2 days held out), persistence baseline = "AQI won't change in the next 6h."

| Metric | XGBoost | Persistence Baseline |
|--------|---------|-----------------------|
| Median RMSE | 26.27 | 30.14 |
| Median improvement | **+12.3%** | — |
| Stations beating baseline | 13/18 | 5/18 |

Best improvements: Surat (+36.5%), Guwahati (+31.7%), Bhopal (+30.9%), Mumbai (+28.1%). Four cities (Hyderabad, Indore, Lucknow, Nagpur ≈ tie, Patna) currently underperform the naive baseline — reported honestly rather than hidden, and expected to improve as more history accumulates for those specific stations. **Kochi** and **Visakhapatnam** are skipped entirely (zero ingested readings); **Bidhannagar, Kolkata** and **Powai, Mumbai** are skipped at the individual-station level (zero readings / too little history for a 24h lag feature, respectively) — both logged explicitly by `predict.py`, never silently dropped.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, React 19, TypeScript |
| Mapping | Leaflet + react-leaflet |
| Charts | Recharts |
| Database | Supabase (PostgreSQL, RLS, Postgres functions) |
| Data Client | @supabase/supabase-js |
| AI (chatbot + advisory) | NVIDIA NIM (MiniMax M3 default, GPT-OSS 120B / DeepSeek V4 Flash / Llama 3.3 70B cascade & picker) |
| ML Models | XGBoost, LightGBM, scikit-learn |
| Ingestion | Python, SQLAlchemy, pandas, psycopg2 |
| CI/CD | GitHub Actions |
| Deployment | Vercel |

---

## Full Technical Report & Build Log

- [`report.md`](./report.md) — schema design decisions, RLS policies, idempotency proofs, feature engineering rationale, CI/CD fix history, live data spot-checks.
- [`kiro.md`](./kiro.md) — chronological session log of every feature built, verified, and deployed by the Kiro agent, including the Hotspot Prioritization / Compare Cities builds and the full 18-city model retrain with before/after evidence.

---

*Last updated: 2026-07-21*
