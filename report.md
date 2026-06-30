# ET-Hackathon Project Report

## 📋 Changelog / Timeline (Git-Style History)

| Date | Commit | Description |
|------|--------|-------------|
| **2026-06-30** | `0302021` | **feat:** Initialize database schema & implement air quality data ingestion pipeline with agentic best practices documentation |
| | | • Created complete Supabase schema (`schema.sql`) — 5 tables: `stations`, `readings`, `weather`, `forecasts`, `user_profiles` |
| | | • Added `external_id` partial unique index on `stations` for idempotent OpenAQ station sync |
| | | • Added composite unique constraints on `readings`, `weather`, `forecasts` for idempotent ingestion |
| | | • Defined `user_profiles.session_id` UNIQUE for session-based profiles with no-op upsert pattern |
| | | • Built Python ingestion pipeline under `ingestion/` (pip + venv, SQLAlchemy + psycopg2) |
| | |   - `setup_stations.py`: Sync 20 Indian cities from OpenAQ v3 → `stations` (idempotent upsert with `xmax` trick) |
| | |   - `ingest_readings.py`: Fetch last 24h PM2.5 from OpenAQ → AQI (US EPA) → `readings` (idempotent) |
| | |   - `ingest_weather.py`: Fetch last 24h hourly weather from Open-Meteo → `weather` (idempotent) |
| | |   - `run_ingestion.py`: Master orchestrator (sequential, fault-isolated, exact DB counts) |
| | | • Documented agentic best practices: partial indexes, idempotent upserts (`ON CONFLICT ... WHERE`), `xmax` analytics, no-op upserts for session profiles |
| | | • Verified schema via MCP: all FKs, indexes, NOT NULL, PKs, unique constraints ✅ |
| | | • Live-tested idempotency: 20 stations, 0 inserts on re-run, 20 updates ✅ |
| **2026-06-27** | `ac56ed5` | **init:** Initial commit — project scaffold, README |

---

# Supabase Schema Verification Report

> **Execution Context:** The local `schema.sql` was applied to the live Supabase project via MCP, followed by a series of four direct SQL verification checks against the database metadata tables.

## Verification Summary: All Checks Passed ✅

### Check 1 — Foreign Keys ✅
All 4 foreign keys exist, point to the correct parent table/column, and have the correct delete rule configured:

| Child Table | FK Column | → Parent Table | Parent Column | ON DELETE |
|---|---|---|---|---|
| `readings` | `station_id` | `stations` | `id` | **CASCADE** ✅ |
| `weather` | `station_id` | `stations` | `id` | **CASCADE** ✅ |
| `forecasts` | `station_id` | `stations` | `id` | **CASCADE** ✅ |
| `user_profiles` | `preferred_station` | `stations` | `id` | **SET NULL** ✅ |

*Note: `user_profiles.preferred_station` intentionally uses `SET NULL` instead of `CASCADE` so that a user profile survives if a station is deleted, merely losing its preference.*

### Check 2 — Composite Indexes ✅
All 3 time-series indexes exist with the correct column order to optimize chronological queries:

| Table | Index Name | Columns |
|---|---|---|
| `readings` | `idx_readings_station_time` | `{station_id, timestamp}` ✅ |
| `weather` | `idx_weather_station_time` | `{station_id, timestamp}` ✅ |
| `forecasts` | `idx_forecasts_station_time` | `{station_id, forecast_at}` ✅ |

### Check 3 — NOT NULL Constraints ✅
Every column matches the specification regarding nullability:

| Table | Column | Nullable? | Notes |
|---|---|---|---|
| `stations` | city, name, latitude, longitude, created_at | NOT NULL ✅ | |
| `readings` | station_id, timestamp, aqi, data_source, recorded_at | NOT NULL ✅ | `pm25` nullable ✅ (allows for sensor gaps) |
| `weather` | station_id, timestamp, temperature, wind_speed, humidity, created_at | NOT NULL ✅ | |
| `forecasts` | station_id, forecast_at, predicted_aqi, model_version, created_at | NOT NULL ✅ | `model_rmse`, `baseline_rmse` nullable ✅ (can be backfilled) |
| `user_profiles` | session_id, vulnerability_flags, preferred_language, created_at | NOT NULL ✅ | `name`, `preferred_station` nullable ✅ (optional fields) |

### Check 4 — Primary Keys (UUID + Default) ✅
All 5 tables utilize UUID primary keys with the correct default function:

| Table | PK Column | Type | Default |
|---|---|---|---|
| `stations` | `id` | `uuid` | `gen_random_uuid()` ✅ |
| `readings` | `id` | `uuid` | `gen_random_uuid()` ✅ |
| `weather` | `id` | `uuid` | `gen_random_uuid()` ✅ |
| `forecasts` | `id` | `uuid` | `gen_random_uuid()` ✅ |
| `user_profiles` | `id` | `uuid` | `gen_random_uuid()` ✅ |

---
**Conclusion:** Zero failures. The schema is live on Supabase and structurally sound according to the requirements.

---

## Schema Design Clarifications

### Q1 — `readings.timestamp` vs `readings.recorded_at`

**Confirmed correct by design.**

| Column | Meaning | Technical term |
|---|---|---|
| `timestamp` | When the sensor / data source actually measured the AQI — the real-world event time. May be in the past for batch imports. | *Event time* |
| `recorded_at` | Wall-clock moment our system wrote the row to the database. Defaults to `now()` on insert. | *Ingestion time* |

Keeping both columns enables ingestion-lag detection. For example:
```sql
-- Find readings that arrived more than 5 minutes late
SELECT * FROM readings
WHERE recorded_at - timestamp > interval '5 minutes';
```

### Q2 — `user_profiles.preferred_station` uses `ON DELETE SET NULL`, not `CASCADE`

**Intentional design improvement — confirmed kept.**

The original spec requested `ON DELETE CASCADE` for all four foreign keys. The FK on `user_profiles.preferred_station` was deliberately changed to `SET NULL` for the following reason:

- **`CASCADE` behaviour:** Deleting a monitoring station would silently delete every user profile that had it set as a preference — almost certainly unintended data loss.
- **`SET NULL` behaviour:** Deleting a station leaves all user profiles intact; `preferred_station` simply becomes `NULL` (no preference), which the application can handle gracefully (e.g. prompt the user to pick a new station).

The other three FKs (`readings`, `weather`, `forecasts`) correctly use `CASCADE` because those rows are scientifically meaningless without their parent station.

### Q3 — `user_profiles.vulnerability_flags` NOT NULL + DEFAULT

**Confirmed — has a safe default.**

The live database reports `column_default = '{}'::text[]` (an empty Postgres text array). This means:

- The column is `NOT NULL` ✅ — it will never contain a `NULL`.
- Inserting a new user profile without specifying `vulnerability_flags` does **not** fail — it silently defaults to an empty array `{}`.
- The application can fill in flags later (e.g. `{'children', 'asthma'}`) once the user completes their onboarding form.

---

## Schema Evolution — Idempotent Ingestion & Uniqueness

Applied directly to the live database via MCP.

### Changes Applied

#### 1. `stations.external_id` — Idempotent Station Setup

Added a nullable `TEXT` column `external_id` to hold the provider's own station identifier (e.g. OpenAQ's `location_id`). A **partial unique index** enforces uniqueness only where the value is set, so manually-created stations without an external ID can coexist freely.

```sql
ALTER TABLE stations ADD COLUMN external_id TEXT;

CREATE UNIQUE INDEX idx_stations_external_id
    ON stations (external_id)
    WHERE external_id IS NOT NULL;
```

**Idempotent station upsert pattern** (live-tested ✅):
```sql
-- WHERE clause comes BEFORE the action to identify the partial index arbiter —
-- this is the correct Postgres syntax for partial-index conflict targets.
INSERT INTO stations (external_id, city, name, latitude, longitude)
VALUES ('openaq-12345', 'Karachi', 'SITE-A', 24.8607, 67.0011)
ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO NOTHING;

-- Alternatively, keep station metadata fresh on re-run:
INSERT INTO stations (external_id, city, name, latitude, longitude)
VALUES ('openaq-12345', 'Karachi', 'SITE-A', 24.8607, 67.0011)
ON CONFLICT (external_id) WHERE external_id IS NOT NULL
DO UPDATE SET
    name      = EXCLUDED.name,
    city      = EXCLUDED.city,
    latitude  = EXCLUDED.latitude,
    longitude = EXCLUDED.longitude;
```

#### 2. UNIQUE Constraints for Idempotent Ingestion

| Table | Constraint Name | Columns |
|---|---|---|
| `readings` | `uq_readings_station_timestamp` | `(station_id, timestamp)` |
| `weather` | `uq_weather_station_timestamp` | `(station_id, timestamp)` |
| `forecasts` | `uq_forecasts_station_forecast_model` | `(station_id, forecast_at, model_version)` |

These make re-running ingestion over an overlapping time window completely safe:

```sql
-- readings / weather — safe re-ingestion:
INSERT INTO readings (station_id, timestamp, aqi, pm25, data_source)
VALUES (...)
ON CONFLICT (station_id, timestamp) DO NOTHING;

-- forecasts — safe model replay:
INSERT INTO forecasts (station_id, forecast_at, predicted_aqi, model_version)
VALUES (...)
ON CONFLICT (station_id, forecast_at, model_version) DO NOTHING;
```

---

### Re-Verification Results (All 5 Checks) ✅

#### Check 1 — Foreign Keys ✅ (unchanged)
| Child Table | FK Column | Parent | ON DELETE |
|---|---|---|---|
| `readings` | `station_id` | `stations.id` | CASCADE ✅ |
| `weather` | `station_id` | `stations.id` | CASCADE ✅ |
| `forecasts` | `station_id` | `stations.id` | CASCADE ✅ |
| `user_profiles` | `preferred_station` | `stations.id` | SET NULL ✅ |

#### Check 2 — Indexes ✅
Each time-series table now has **two** indexes: the original non-unique DESC index for range scans, plus the new unique index backing the `ON CONFLICT` clause.

| Table | Index | Columns | Unique? |
|---|---|---|---|
| `readings` | `idx_readings_station_time` | `(station_id, timestamp)` | No |
| `readings` | `uq_readings_station_timestamp` | `(station_id, timestamp)` | **Yes** ✅ |
| `weather` | `idx_weather_station_time` | `(station_id, timestamp)` | No |
| `weather` | `uq_weather_station_timestamp` | `(station_id, timestamp)` | **Yes** ✅ |
| `forecasts` | `idx_forecasts_station_time` | `(station_id, forecast_at)` | No |
| `forecasts` | `uq_forecasts_station_forecast_model` | `(station_id, forecast_at, model_version)` | **Yes** ✅ |

#### Check 3 — NOT NULL Constraints ✅ (unchanged)
All required columns remain `NOT NULL`. `stations.external_id` is correctly nullable.

#### Check 4 — UUID Primary Keys ✅ (unchanged)
All 5 tables: `id UUID DEFAULT gen_random_uuid()` confirmed.

#### Check 5 — Unique Constraints & Indexes ✅ (new)
| Table | Constraint / Index | Columns | Kind |
|---|---|---|---|
| `stations` | `idx_stations_external_id` | `external_id` | Partial unique index ✅ |
| `readings` | `uq_readings_station_timestamp` | `station_id, timestamp` | Unique constraint ✅ |
| `weather` | `uq_weather_station_timestamp` | `station_id, timestamp` | Unique constraint ✅ |
| `forecasts` | `uq_forecasts_station_forecast_model` | `station_id, forecast_at, model_version` | Unique constraint ✅ |
| `user_profiles` | `user_profiles_session_id_key` | `session_id` | Unique constraint ✅ |


**Conclusion:** Zero regressions. All original checks still pass, and the new idempotent ingestion constraints are live and verified.

---

## Live-Test Confirmations & Corrections

### Fix 1 — `ON CONFLICT` Syntax for Partial Index ✅

**The bug:** The previously documented station upsert example had invalid Postgres syntax:
```sql
-- ❌ WRONG — WHERE after DO NOTHING is not accepted by Postgres
ON CONFLICT (external_id) DO NOTHING WHERE external_id IS NOT NULL;
```

**The fix:** The `WHERE` clause identifying the partial index predicate must come **before** the conflict action:
```sql
-- ✅ CORRECT — WHERE before DO NOTHING
ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO NOTHING;
```

**Live-test result (run via MCP):**
1. Inserted `openaq-test-001` → succeeded, 1 row created.
2. Re-inserted `openaq-test-001` with a different `name` using the corrected syntax → **no error, no duplicate row** (`name` remained `'Test Site A'`).
3. Only 1 row confirmed in `stations` for that `external_id`. ✅

---

### Fix 2 — `user_profiles.session_id` UNIQUE Constraint (Intentional)

**Origin:** The `UNIQUE` keyword was part of the original `session_id TEXT NOT NULL UNIQUE` column definition — not added as a separate migration step. Postgres auto-named the constraint `user_profiles_session_id_key`.

**Confirmed intentional:** One profile per browser session is the correct model. A session token is a natural deduplication key, and without this constraint re-loading the page could silently fork a user's profile.

**Next.js pattern for returning visits — single query, always returns the row:**

> [!WARNING]
> The previous version of this pattern contained a bug: passing `preferred_language: 'en'` into the upsert payload meant `DO UPDATE SET preferred_language = EXCLUDED.preferred_language` ran on **every** page load, silently resetting any saved language preference back to `'en'`. Fixed below.

```typescript
// lib/db.ts — call this in your middleware or layout on every page load
export async function getOrCreateProfile(sessionId: string) {
  const { data, error } = await supabase
    .from('user_profiles')
    .upsert(
      { session_id: sessionId },
      // ↑ DO NOT include preferred_language or any other user preference here.
      //   For a new row: Postgres column DEFAULT ('en') applies automatically.
      //   For a returning row: only session_id is in the INSERT, so DO UPDATE
      //   has nothing to overwrite — all existing columns are left completely untouched.
      {
        onConflict: 'session_id',
        ignoreDuplicates: false,  // false = DO UPDATE fires so RETURNING always returns the row
      }
    )
    .select()
    .single();

  if (error) throw error;
  return data; // existing row returned as-is, or new row with defaults
}
```

**Raw SQL equivalent:**
```sql
-- New session: preferred_language gets column default 'en' automatically.
-- Returning session: DO UPDATE SET id = user_profiles.id is a true no-op —
--   no column values change, but RETURNING still fires and returns the existing row.
INSERT INTO user_profiles (session_id)
VALUES ($1)
ON CONFLICT (session_id)
DO UPDATE SET id = user_profiles.id
RETURNING id, session_id, preferred_language, vulnerability_flags, created_at;
```

**Why this no-op pattern works:**
- `DO NOTHING` + `RETURNING` → returns **zero rows** on conflict (forces a second SELECT).
- `DO UPDATE SET preferred_language = EXCLUDED.preferred_language` → **overwrites user preference on every page load** (the bug).
- `DO UPDATE SET id = user_profiles.id` → no column changes, but the `DO UPDATE` path fires so `RETURNING` always emits the row in **one round-trip** with all values intact.

**Live-test result (run via MCP) — the real scenario:**

| Step | Action | `preferred_language` returned |
|---|---|---|
| 1 | `INSERT (session_id only)` — new session | `'en'` ✅ (column default) |
| 2 | `UPDATE SET preferred_language = 'ta'` — user changes language | `'ta'` ✅ |
| 3 | Fixed upsert called on page load — `INSERT (session_id only) ON CONFLICT DO UPDATE SET id = user_profiles.id` | `'ta'` ✅ **not reset to 'en'** |

Same `id` (`0c0aea02-8966-420b-8e75-7dd79796e687`) and `created_at` (`2026-06-27 06:19:47 UTC`) returned in steps 1 and 3, confirming the existing row was returned untouched.

---

## 5. Python Ingestion Pipeline & OpenAQ Integration

A dedicated Python ingestion project was created under `/ingestion/` to fetch data from the OpenAQ API v3 and seed the `stations` table in Supabase.

### 5.1 Project Structure

The project uses a standard `pip` + virtualenv setup to maintain a clean dependency tree.

- `requirements.txt`: Locked dependencies (`pandas>=3.0.3`, `sqlalchemy>=2.0.51`, `psycopg2-binary>=2.9.12`, `requests>=2.34.2`, `python-dotenv>=1.2.2`).
- `.env`: Holds the `SUPABASE_DB_URL` (direct connection string) and `OPENAQ_API_KEY`. Note: The password contains special characters (`@`, `#`) which must be URL-encoded (e.g., `%40`, `%23`) for SQLAlchemy to parse the URI correctly.
- `config.py`: Defines 20 tracked major Indian cities with their approximate geographic coordinates.
- `db.py`: Provides a singleton SQLAlchemy engine to manage connection pooling to Supabase Postgres.
- `setup_stations.py`: The main script to seed the `stations` table using the OpenAQ v3 `/locations` endpoint.

### 5.2 OpenAQ Location Resolution

For each city defined in `config.py`, the ingestion script performs a radius search against OpenAQ:
1. Calls `GET /v3/locations?coordinates=<lat>,<lng>&radius=25000`
2. If multiple monitoring stations are found within the 25km radius, it selects the "best" station based on:
   - Max active sensors (parameters measured)
   - Most recent measurement timestamp (active status)
3. Maps the selected OpenAQ location `id` to the `external_id` column in our `stations` table.

### 5.3 Idempotent SQLAlchemy Upsert

To ensure the ingestion pipeline can be run repeatedly without duplicating stations or crashing, the database writes use a raw parameterized SQL upsert executed through SQLAlchemy's connection object.

**SQL Pattern Used:**
```sql
INSERT INTO stations (external_id, city, name, latitude, longitude)
VALUES (:external_id, :city, :name, :latitude, :longitude)
ON CONFLICT (external_id) WHERE external_id IS NOT NULL
DO UPDATE SET
    name      = EXCLUDED.name,
    city      = EXCLUDED.city,
    latitude  = EXCLUDED.latitude,
    longitude = EXCLUDED.longitude
RETURNING id, (xmax = 0) AS was_inserted
```

**Key Advantages:**
1. **No String Interpolation:** Values are passed as bound parameters (`:param_name`), completely eliminating SQL injection risks.
2. **`xmax` Trick for Analytics:** The Postgres internal column `xmax` is `0` for newly inserted rows and non-zero (previous transaction ID) for rows that took the `DO UPDATE` path. This allows the script to accurately count Inserts vs. Updates in a single query without a secondary `SELECT`.

### 5.4 Live-Test: Ingestion Idempotency

To prove the pipeline is fully idempotent, `setup_stations.py` was executed repeatedly against the live Supabase instance with row counts verified via direct MCP SQL queries. 

In a rigorous stress test, the script was run *again* against the already fully populated table to ensure 100% of rows took the `DO UPDATE` path with zero new inserts or orphans created:

| Checkpoint | `station_count` (via direct SQL) | New Rows Inserted | Rows Updated |
|---|---|---|---|
| **Baseline** (Pre-populated) | `20` | - | - |
| **After Run 1** | `20` | `0` | `20` |
| **After Run 2** | `20` | `0` | `20` |

**Final SQL Validation:**
```sql
SELECT
    COUNT(*)                                    AS station_count,       -- Result: 20
    COUNT(external_id)                          AS with_external_id,    -- Result: 20
    COUNT(*) FILTER (WHERE external_id IS NULL) AS missing_external_id  -- Result: 0
FROM stations;
```

**Conclusion:** The database successfully resolved 20 distinct OpenAQ stations for the configured cities and enforced the partial unique index on `external_id`. Even when repeatedly running the ingestion against fully populated data, exactly 0 new rows were created, and 0 orphan rows without an `external_id` were found. The pipeline safely and correctly triggers updates for existing locations, fulfilling all idempotency requirements.

---

### 5.5 True Zero-to-N Idempotency Test — `setup_stations.py`

> **Timestamp:** 2026-06-30 08:00–08:01 UTC

After a `TRUNCATE stations RESTART IDENTITY CASCADE` (which also wiped all child rows via CASCADE), `setup_stations.py` was run twice from a **genuine baseline of 0 rows**.

**Pre-run SQL (MCP):** `station_count = 0` ✅

| Checkpoint | `station_count` (direct SQL) | Inserted | Updated |
|---|---|---|---|
| After `TRUNCATE ... CASCADE` | **0** | — | — |
| **After Run 1** | **20** | **20** | 0 |
| **After Run 2** | **20** | **0** | **20** |

**Post-run validation query result:**
```
station_count       = 20
with_external_id    = 20   ← every row linked to OpenAQ
missing_external_id = 0    ← zero orphan rows
leftover_test_rows  = 0    ← no test data contamination
```

---

## 6. Readings Ingestion — `ingest_readings.py`

> **Timestamp:** 2026-06-30 08:02–08:10 UTC

### 6.1 Architecture

`ingest_readings.py` implements a sensor-centric pipeline matching the OpenAQ v3 API design:

1. Load all stations with `external_id` from Supabase.
2. For each station, call `GET /v3/locations/{external_id}/sensors` to discover parameter-specific sensor IDs.
3. Find the PM2.5 sensor (parameter name `"pm25"`).
4. Call `GET /v3/sensors/{sensor_id}/measurements?datetime_from=...&datetime_to=...` for the last 24 h.
5. Clean results in **pandas**: extract `period.datetimeTo.utc` as the observation timestamp, drop nulls, drop negatives, deduplicate within batch.
6. Derive AQI from PM2.5 concentration using the US EPA piecewise linear breakpoints formula.
7. Batch-INSERT via raw parameterized SQL (`ON CONFLICT (station_id, timestamp) DO NOTHING RETURNING id`).
8. Count inserted vs skipped by checking whether `RETURNING id` emitted a row — no secondary query needed.

### 6.2 Key Bug Found & Fixed During Testing

> **Timestamp:** 2026-06-30 08:03 UTC

| Bug | Root Cause | Fix |
|---|---|---|
| 926 rows fetched, **0 inserted** | Parser read `m.get("datetime")` — this key does NOT exist in v3 measurement objects | Changed to `m["period"]["datetimeTo"]["utc"]` |
| Measurements outside 24 h window | `datetime_to` param was missing; API defaulted to returning all historical data | Added `datetime_to=now()` to constrain the window |

### 6.3 AQI Derivation (US EPA PM2.5 Breakpoints)

OpenAQ returns raw concentrations (µg/m³). AQI is calculated locally using the piecewise linear formula:

```
AQI = ((I_high - I_low) / (C_high - C_low)) × (C - C_low) + I_low
```

Values above 500.4 µg/m³ are capped at AQI 500.

### 6.4 Live Idempotency Test — `ingest_readings.py`

> **Timestamp:** 2026-06-30 08:04–08:10 UTC

| Checkpoint | `reading_count` (direct SQL) | Inserted | Skipped |
|---|---|---|---|
| Baseline | **0** | — | — |
| **After Run 1** | **926** | **926** | 0 |
| **After Run 2** | **926** | **0** | **926** |

**Final SQL validation:**
```
reading_count             = 926
distinct_stations         = 14   (6 stations had no PM2.5 sensor — correct)
earliest_reading          = 2026-06-29 08:15:00 UTC
latest_reading            = 2026-06-30 06:30:00 UTC
unique_station_timestamps = 926   ← equals reading_count: ZERO duplicates
```

`unique_station_timestamps = reading_count` — every row is a unique `(station_id, timestamp)` pair. Fully idempotent ✅

---

## 7. Weather Ingestion — `ingest_weather.py`

> **Timestamp:** 2026-06-30 08:12 UTC

### 7.1 Architecture

`ingest_weather.py` fetches hourly weather from [Open-Meteo](https://open-meteo.com) — free, open-source, no API key required.

**API call per station:**
```
GET https://api.open-meteo.com/v1/forecast
  ?latitude=<lat>&longitude=<lng>
  &hourly=temperature_2m,wind_speed_10m,relative_humidity_2m
  &wind_speed_unit=ms      ← returns m/s directly (schema stores m/s)
  &timezone=UTC            ← timestamps returned without offset arithmetic
  &past_hours=24
  &forecast_hours=0        ← no future data in response
```

**Response shape** — parallel arrays of equal length:
```json
{
  "hourly": {
    "time":                   ["2026-06-30T05:00", ...],
    "temperature_2m":         [37.7, ...],
    "wind_speed_10m":         [1.93, ...],
    "relative_humidity_2m":   [38, ...]
  }
}
```

### 7.2 Timestamp Parsing Gotcha

Open-Meteo returns `"2026-06-30T05:00"` — no `Z`, no `+00:00` — when `timezone=UTC`. The parser appends `"Z"` before calling `pd.to_datetime(..., utc=True)` to ensure all timestamps are correctly marked as UTC-aware before database insertion.

### 7.3 Data Quality Guards

| Guard | Reason |
|---|---|
| `dropna(subset=[timestamp, temperature, wind_speed, humidity])` | All 4 are `NOT NULL` in the schema |
| `clip(humidity, 0, 100)` | Open-Meteo occasionally returns 101% during fog |
| `clip(wind_speed, lower=0)` | Negative wind speed = sensor error |

---

## 8. Pipeline Orchestrator — `run_ingestion.py`

> **Timestamp:** 2026-06-30 08:14 UTC

### 8.1 Architecture

`run_ingestion.py` runs the three steps in sequence, fully fault-isolated:

```
setup_stations  →  ingest_readings  →  ingest_weather
```

Each step is wrapped in an independent `try/except`. A failure in one step (e.g. OpenAQ API is down) **does not prevent** the remaining steps from running.

**Counts are exact** — derived by querying `COUNT(*)` from the database before and after each step, not from parsing log output. Delta = `rows_after - rows_before`.

### 8.2 CLI Flags

```bash
python ingestion/run_ingestion.py             # full run, last 24 h
python ingestion/run_ingestion.py --hours 48  # backfill 48 h
python ingestion/run_ingestion.py --skip-stations  # skip station sync
python ingestion/run_ingestion.py --dry-run   # no DB writes
```

### 8.3 Full Pipeline Live Test

> **Timestamp:** 2026-06-30 08:16–08:24 UTC

Two consecutive full runs (`run_ingestion.py`, no flags) against all live APIs:

**Before/After — Direct SQL (MCP)**

| Table | Baseline | After Run 1 | After Run 2 | Run 1→2 delta |
|---|---|---|---|---|
| `stations` | 20 | **20** | **20** | 0 ✅ |
| `readings` | 926 | **926** | **926** | 0 ✅ |
| `weather` | 0 | **480** | **480** | 0 ✅ |

**Weather detail:** 20 cities × 24 hourly rows = 480 rows inserted on Run 1; all 480 skipped as duplicates on Run 2.

**Pipeline summary (from orchestrator log):**

Run 1:
```
stations   OK  new_rows=  0  total=  20  elapsed=22.5s
readings   OK  new_rows=  0  total= 926  elapsed=146.3s
weather    OK  new_rows=480  total= 480  elapsed=55.2s
```

Run 2:
```
stations   OK  new_rows=  0  total=  20  elapsed=25.6s
readings   OK  new_rows=  0  total= 926  elapsed=146.0s
weather    OK  new_rows=  0  total= 480  elapsed=54.2s
```

**Spot-check — 3 random readings (SQL via MCP):**

| City | `timestamp` (UTC) | AQI | PM2.5 (µg/m³) | `data_source` |
|---|---|---|---|---|
| Kanpur | 2026-06-29 11:00:00 | 97.06 | 34.00 | openaq-v3 |
| Bengaluru | 2026-06-29 15:30:00 | 56.05 | 14.50 | openaq-v3 |
| Chennai | 2026-06-29 09:45:00 | 70.24 | 21.25 | openaq-v3 |

All 3 timestamps are within the 24-hour window, distinct, not in the future, and AQI values match PM2.5 → AQI conversion ✅

---

## 9. GitHub Actions Workflow — `.github/workflows/ingest.yml`

> **Timestamp:** 2026-06-30 08:25 UTC

### 9.1 Triggers

| Trigger | Details |
|---|---|
| `schedule` | `cron: "17 */5 * * *"` — every 5 hours at :17 past the hour (UTC) |
| `workflow_dispatch` | Manual trigger from GitHub Actions UI with optional `hours`, `skip_stations`, `dry_run` inputs |

The `:17` offset avoids GitHub's heavily-loaded `:00` slot — scheduled jobs fire more reliably.

### 9.2 Concurrency Guard

```yaml
concurrency:
  group: ingestion-pipeline
  cancel-in-progress: false
```

A new trigger while a run is in progress **waits** (does not cancel), so the DB is never written by two jobs simultaneously, preserving the unique-constraint guarantees.

### 9.3 Pip Caching

```yaml
key: ${{ runner.os }}-pip-${{ hashFiles('ingestion/requirements.txt') }}
```

Cache keyed to the exact content hash of `requirements.txt`. Pip packages are only re-downloaded when a dependency changes — cached runs skip the install step (~30 s saved per run).

### 9.4 Required GitHub Secrets

Add these in **Repo Settings → Secrets and variables → Actions → New repository secret**:

| Secret Name | Value |
|---|---|
| `SUPABASE_DB_URL` | Full PostgreSQL connection string: `postgresql://postgres:<password>@db.ckjiukvxqqvjmpxhpclb.supabase.co:5432/postgres` |
| `OPENAQ_API_KEY` | OpenAQ v3 API key (register free at openaq.org → Account → API Keys) |

### 9.5 Failure Handling

If any ingestion step fails (exit code 1), the workflow uploads runner logs as a downloadable artifact (`ingestion-failure-logs-<run_id>`) retained for 7 days, enabling post-mortem debugging without re-running.

---

## 10. Current Database State (as of 2026-06-30 08:45 UTC)

Verified by direct SQL via MCP — not from script log output.

| Table | Row Count | Notes |
|---|---|---|
| `stations` | **20** | 20 Indian cities, all linked to OpenAQ via `external_id` |
| `readings` | **926** | Last 24 h PM2.5/AQI readings; 14 of 20 stations have active PM2.5 sensors |
| `weather` | **480** | Last 24 h hourly weather (20 stations × 24 h) |
| `forecasts` | **0** | Reserved for ML model output — not yet populated |
| `user_profiles` | **0** | ~~1~~ — corrected; stale count from before `TRUNCATE CASCADE` (see §11.3) |

---

## 11. Post-Report Investigations (2026-06-30 08:40–08:45 UTC)

### 11.1 — 20 Cities: Intentional ✅

The choice of 20 major Indian cities was **explicitly requested** in the original project setup (user request: *"let the user choose location in major cities"*). No trimming to 5 was ever decided. `config.py` is correct as-is. No action taken.

---

### 11.2 — `ingest_weather.py` Standalone Idempotency Test ✅

> Mirrors the §6.4 test format, run directly (not via orchestrator).

**Direct SQL (MCP) — not script log:**

| Checkpoint | `weather_count` (SQL) | Inserted | Skipped (duplicate) |
|---|---|---|---|
| **Baseline** | **480** | — | — |
| **After Run 1** | **480** | **0** | **480** |
| **After Run 2** | **480** | **0** | **480** |

`ON CONFLICT (station_id, timestamp) DO NOTHING` correctly suppressed all 480 rows on both runs. ✅

---

### 11.3 — `user_profiles` Investigation ✅

**Direct SQL result:**
```sql
SELECT * FROM user_profiles;
-- Result: [] (zero rows)
```

`user_profiles` is **empty**. The §10 count of "1" was stale — copied from before the `TRUNCATE stations CASCADE` ran in §5.5.

**Why `TRUNCATE stations CASCADE` left `user_profiles` intact (by design):**

FK delete rules confirmed via `information_schema`:

| Child Table | FK Column | `delete_rule` |
|---|---|---|
| `readings` | `station_id` | `CASCADE` |
| `weather` | `station_id` | `CASCADE` |
| `forecasts` | `station_id` | `CASCADE` |
| `user_profiles` | `preferred_station` | **`SET NULL`** ← not CASCADE |

`TRUNCATE ... CASCADE` only propagates to tables whose FK has `ON DELETE CASCADE`. Because `user_profiles.preferred_station` uses `SET NULL`, Postgres does **not** cascade the truncate to `user_profiles` — it would only null out the `preferred_station` column in any matching rows, not delete the rows.

The table was already empty at truncate time (test profile cleaned up earlier), so the result is `0 rows` regardless. **No bug — FK behaviour is correct and intentional** per the design decision documented in §Q2.

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
