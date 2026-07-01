-- =============================================================================
-- Air Quality Forecasting App — Supabase Postgres Schema
-- Ready to paste directly into the Supabase SQL Editor
-- =============================================================================

-- Enable pgcrypto extension if not already active (needed for gen_random_uuid)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- =============================================================================
-- APPLICATION DATABASE USER (least privilege)
-- Never connect as the postgres superuser from application code.
-- This role has only the bare minimum privileges for the ingestion pipeline.
-- ─────────────────────────────────────────────────────────────────────────────
-- To set a password, run:
--   ALTER ROLE app_ingestion WITH PASSWORD '<secure-password>';
-- Then set SUPABASE_DB_URL to:
--   postgresql://app_ingestion:<password>@db.<project-ref>.supabase.co:5432/postgres?sslmode=require
-- =============================================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_ingestion') THEN
        CREATE ROLE app_ingestion WITH LOGIN PASSWORD NULL
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_ingestion;

GRANT SELECT, INSERT, UPDATE ON TABLE public.stations TO app_ingestion;
GRANT SELECT, INSERT ON TABLE public.readings TO app_ingestion;
GRANT SELECT, INSERT ON TABLE public.weather TO app_ingestion;
GRANT SELECT, INSERT ON TABLE public.forecasts TO app_ingestion;
GRANT SELECT, INSERT, UPDATE ON TABLE public.user_profiles TO app_ingestion;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_ingestion;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE ON TABLES TO app_ingestion;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE ON SEQUENCES TO app_ingestion;


-- =============================================================================
-- 1. STATIONS
--    Master table of monitoring station locations.
--    All other tables reference this one.
-- =============================================================================
CREATE TABLE stations (
    id          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id TEXT,                        -- OpenAQ / provider station ID; nullable so manual stations are allowed
    city        TEXT            NOT NULL,
    name        TEXT            NOT NULL,
    latitude    NUMERIC(9, 6)   NOT NULL,
    longitude   NUMERIC(9, 6)   NOT NULL,
    created_at  TIMESTAMPTZ     NOT NULL DEFAULT now()
);

-- Partial unique index on external_id (only where set) — prevents duplicate station rows on re-run
-- while allowing rows with no external_id to coexist freely.
CREATE UNIQUE INDEX idx_stations_external_id
    ON stations (external_id)
    WHERE external_id IS NOT NULL;


-- =============================================================================
-- 2. READINGS
--    Historical and live AQI readings, one row per station per observation.
-- =============================================================================
CREATE TABLE readings (
    id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id    UUID          NOT NULL
                                REFERENCES stations(id) ON DELETE CASCADE,
    timestamp     TIMESTAMPTZ   NOT NULL,
    aqi           NUMERIC(6, 2) NOT NULL,
    pm25          NUMERIC(6, 2),                       -- µg/m³; nullable if sensor gap
    data_source   TEXT          NOT NULL,              -- e.g. 'EPA', 'OpenAQ', 'IoT-sensor'
    recorded_at   TIMESTAMPTZ   NOT NULL DEFAULT now() -- wall-clock time row was ingested
);

-- UNIQUE constraint: prevents duplicate readings for the same station at the same moment;
-- also serves as the conflict target for INSERT ... ON CONFLICT (station_id, timestamp) DO NOTHING.
ALTER TABLE readings
    ADD CONSTRAINT uq_readings_station_timestamp UNIQUE (station_id, timestamp);

-- Composite index: satisfies "last 24 h of readings for station X" queries efficiently.
-- station_id narrows to a single station; timestamp DESC lets Postgres stop early.
CREATE INDEX idx_readings_station_time
    ON readings (station_id, timestamp DESC);

-- Idempotent ingestion pattern (use in your ingest scripts):
-- INSERT INTO readings (station_id, timestamp, aqi, pm25, data_source)
-- VALUES (...)
-- ON CONFLICT (station_id, timestamp) DO NOTHING;


-- =============================================================================
-- 3. WEATHER
--    Weather snapshots matched to a station at a point in time.
-- =============================================================================
CREATE TABLE weather (
    id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id    UUID          NOT NULL
                                REFERENCES stations(id) ON DELETE CASCADE,
    timestamp     TIMESTAMPTZ   NOT NULL,
    temperature   NUMERIC(5, 2) NOT NULL,  -- °C
    wind_speed    NUMERIC(5, 2) NOT NULL,  -- m/s
    humidity      NUMERIC(5, 2) NOT NULL,  -- percentage 0–100
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- UNIQUE constraint: prevents duplicate weather snapshots for the same station at the same moment;
-- also serves as the conflict target for INSERT ... ON CONFLICT (station_id, timestamp) DO NOTHING.
ALTER TABLE weather
    ADD CONSTRAINT uq_weather_station_timestamp UNIQUE (station_id, timestamp);

-- Composite index: mirrors the readings pattern so weather joins in time-range
-- queries can use the same access path (station_id + ordered timestamp).
CREATE INDEX idx_weather_station_time
    ON weather (station_id, timestamp DESC);

-- Idempotent ingestion pattern (use in your ingest scripts):
-- INSERT INTO weather (station_id, timestamp, temperature, wind_speed, humidity)
-- VALUES (...)
-- ON CONFLICT (station_id, timestamp) DO NOTHING;


-- =============================================================================
-- 4. FORECASTS
--    Model-generated AQI predictions, one row per station × future timestamp
--    × model run.
-- =============================================================================
CREATE TABLE forecasts (
    id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id       UUID          NOT NULL
                                   REFERENCES stations(id) ON DELETE CASCADE,
    forecast_at      TIMESTAMPTZ   NOT NULL,  -- the future moment being predicted
    predicted_aqi    NUMERIC(6, 2) NOT NULL,
    model_version    TEXT          NOT NULL,  -- e.g. 'xgb-v2.1', 'lstm-v3.0'
    model_rmse       NUMERIC(8, 4),           -- model RMSE for this run
    baseline_rmse    NUMERIC(8, 4),           -- naïve baseline RMSE for comparison
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- UNIQUE constraint: one predicted value per station + future timestamp + model version;
-- prevents duplicate forecast rows when a model run is replayed.
ALTER TABLE forecasts
    ADD CONSTRAINT uq_forecasts_station_forecast_model UNIQUE (station_id, forecast_at, model_version);

-- Composite index: enables fast retrieval of future forecasts for a specific
-- station ordered chronologically (e.g. "next 48 h outlook for station X").
CREATE INDEX idx_forecasts_station_time
    ON forecasts (station_id, forecast_at ASC);


-- =============================================================================
-- 5. USER_PROFILES
--    Per-browser-session personalization data.
-- =============================================================================
CREATE TABLE user_profiles (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id          TEXT        NOT NULL UNIQUE,        -- browser session token
    name                TEXT,                               -- optional display name
    vulnerability_flags TEXT[]      NOT NULL DEFAULT '{}',  -- e.g. {'children','asthma'}
    preferred_station   UUID
                        REFERENCES stations(id) ON DELETE SET NULL,
    preferred_language  TEXT        NOT NULL DEFAULT 'en',  -- BCP-47 language tag
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Single-column index: every profile lookup starts from a session token,
-- so this avoids full-table scans on every personalisation request.
CREATE INDEX idx_user_profiles_session
    ON user_profiles (session_id);

-- Index on the FK to stations: avoids sequential scans when joining
-- user_profiles to stations for the preferred_station relationship.
CREATE INDEX idx_user_profiles_preferred_station
    ON user_profiles (preferred_station);


-- =============================================================================
-- 6. ROW-LEVEL SECURITY  (defense-in-depth for the Supabase Data API)
--    All tables are exposed to the Supabase REST/GraphQL API, so RLS prevents
--    unauthorised access if the anon key is compromised.
--    The backend ingestion pipeline bypasses RLS because it connects with
--    full database credentials via a dedicated SQLAlchemy connection.
-- =============================================================================

-- ── Enable RLS on every table ─────────────────────────────────────────────────
ALTER TABLE stations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE readings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE weather        ENABLE ROW LEVEL SECURITY;
ALTER TABLE forecasts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles  ENABLE ROW LEVEL SECURITY;

-- ── Stations: public reference data — anyone can read; only service_role writes
CREATE POLICY "stations_select_anon" ON stations
    FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "stations_insert_service" ON stations
    FOR INSERT TO service_role WITH CHECK (true);

CREATE POLICY "stations_update_service" ON stations
    FOR UPDATE TO service_role USING (true) WITH CHECK (true);

-- ── Readings: public air quality data — anyone can read; only service_role writes
CREATE POLICY "readings_select_anon" ON readings
    FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "readings_insert_service" ON readings
    FOR INSERT TO service_role WITH CHECK (true);

-- ── Weather: public weather data — anyone can read; only service_role writes
CREATE POLICY "weather_select_anon" ON weather
    FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "weather_insert_service" ON weather
    FOR INSERT TO service_role WITH CHECK (true);

-- ── Forecasts: public prediction data — anyone can read; only service_role writes
CREATE POLICY "forecasts_select_anon" ON forecasts
    FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "forecasts_insert_service" ON forecasts
    FOR INSERT TO service_role WITH CHECK (true);

-- ── User profiles: session_id is PII — only the owning session can access
-- NOTE: current_setting() is wrapped in (SELECT ...) to avoid per-row
-- re-evaluation (Supabase performance best practice for RLS init plans).
CREATE POLICY "user_profiles_select_own" ON user_profiles
    FOR SELECT TO anon, authenticated
    USING (
        session_id = (SELECT current_setting('request.jwt.claims', true)::json->>'session_id')
        OR current_user = 'service_role'
    );

CREATE POLICY "user_profiles_insert_own" ON user_profiles
    FOR INSERT TO anon, authenticated
    WITH CHECK (
        session_id = (SELECT current_setting('request.jwt.claims', true)::json->>'session_id')
        OR current_user = 'service_role'
    );

CREATE POLICY "user_profiles_update_own" ON user_profiles
    FOR UPDATE TO anon, authenticated
    USING (
        session_id = (SELECT current_setting('request.jwt.claims', true)::json->>'session_id')
        OR current_user = 'service_role'
    )
    WITH CHECK (
        session_id = (SELECT current_setting('request.jwt.claims', true)::json->>'session_id')
        OR current_user = 'service_role'
    );

CREATE POLICY "user_profiles_delete_service" ON user_profiles
    FOR DELETE TO service_role USING (true);
