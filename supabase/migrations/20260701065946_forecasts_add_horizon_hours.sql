
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: forecasts — add horizon_hours column
--
-- Rationale:
--   model_version identifies the model build (e.g. 'xgb-v1.0').
--   horizon_hours identifies the PREDICTION WINDOW (1, 6, 24 h).
--   These are orthogonal dimensions. Encoding both in model_version
--   would force every frontend query to use string pattern matching.
--   A typed INTEGER column allows:
--     .eq('horizon_hours', 6)     -- exact filter in supabase-js
--     ORDER BY horizon_hours      -- meaningful sort
--     CHECK (horizon_hours > 0)   -- enforced at DB level
--
-- Steps:
--   1. Add horizon_hours column with DEFAULT 6 (safe backfill for existing rows)
--   2. Drop the old 3-column unique constraint
--   3. Add new 4-column unique constraint including horizon_hours
--   4. Add a CHECK constraint to prevent nonsensical values
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add column — DEFAULT 6 means any existing rows get horizon_hours=6
--    (safe; table is currently empty so this is a no-op backfill)
ALTER TABLE forecasts
  ADD COLUMN horizon_hours INTEGER NOT NULL DEFAULT 6;

-- 2. Enforce valid range (negative or zero hours makes no sense)
ALTER TABLE forecasts
  ADD CONSTRAINT chk_forecasts_horizon_hours
    CHECK (horizon_hours > 0);

-- 3. Drop old unique constraint (only covered station_id, forecast_at, model_version)
ALTER TABLE forecasts
  DROP CONSTRAINT uq_forecasts_station_forecast_model;

-- 4. New unique constraint includes horizon_hours:
--    Semantic: "one predicted AQI per station × target timestamp × model × horizon"
--    This allows the same station+forecast_at pair to have both a 6h and 24h
--    prediction row from the same model_version without conflict.
ALTER TABLE forecasts
  ADD CONSTRAINT uq_forecasts_station_forecast_model_horizon
    UNIQUE (station_id, forecast_at, model_version, horizon_hours);
;
