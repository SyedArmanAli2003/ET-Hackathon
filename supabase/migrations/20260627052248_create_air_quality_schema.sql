
-- Enable pgcrypto extension if not already active (needed for gen_random_uuid)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- =============================================================================
-- 1. STATIONS
-- =============================================================================
CREATE TABLE stations (
    id          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    city        TEXT            NOT NULL,
    name        TEXT            NOT NULL,
    latitude    NUMERIC(9, 6)   NOT NULL,
    longitude   NUMERIC(9, 6)   NOT NULL,
    created_at  TIMESTAMPTZ     NOT NULL DEFAULT now()
);


-- =============================================================================
-- 2. READINGS
-- =============================================================================
CREATE TABLE readings (
    id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id    UUID          NOT NULL
                                REFERENCES stations(id) ON DELETE CASCADE,
    timestamp     TIMESTAMPTZ   NOT NULL,
    aqi           NUMERIC(6, 2) NOT NULL,
    pm25          NUMERIC(6, 2),
    data_source   TEXT          NOT NULL,
    recorded_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Composite index: satisfies "last 24 h of readings for station X" queries efficiently.
CREATE INDEX idx_readings_station_time
    ON readings (station_id, timestamp DESC);


-- =============================================================================
-- 3. WEATHER
-- =============================================================================
CREATE TABLE weather (
    id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id    UUID          NOT NULL
                                REFERENCES stations(id) ON DELETE CASCADE,
    timestamp     TIMESTAMPTZ   NOT NULL,
    temperature   NUMERIC(5, 2) NOT NULL,
    wind_speed    NUMERIC(5, 2) NOT NULL,
    humidity      NUMERIC(5, 2) NOT NULL,
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Composite index: mirrors the readings pattern so weather joins in time-range queries can use the same access path.
CREATE INDEX idx_weather_station_time
    ON weather (station_id, timestamp DESC);


-- =============================================================================
-- 4. FORECASTS
-- =============================================================================
CREATE TABLE forecasts (
    id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id       UUID          NOT NULL
                                   REFERENCES stations(id) ON DELETE CASCADE,
    forecast_at      TIMESTAMPTZ   NOT NULL,
    predicted_aqi    NUMERIC(6, 2) NOT NULL,
    model_version    TEXT          NOT NULL,
    model_rmse       NUMERIC(8, 4),
    baseline_rmse    NUMERIC(8, 4),
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Composite index: enables fast retrieval of future forecasts for a specific station ordered chronologically.
CREATE INDEX idx_forecasts_station_time
    ON forecasts (station_id, forecast_at ASC);


-- =============================================================================
-- 5. USER_PROFILES
-- =============================================================================
CREATE TABLE user_profiles (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id          TEXT        NOT NULL UNIQUE,
    name                TEXT,
    vulnerability_flags TEXT[]      NOT NULL DEFAULT '{}',
    preferred_station   UUID
                        REFERENCES stations(id) ON DELETE SET NULL,
    preferred_language  TEXT        NOT NULL DEFAULT 'en',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Single-column index: every profile lookup starts from a session token.
CREATE INDEX idx_user_profiles_session
    ON user_profiles (session_id);
;
