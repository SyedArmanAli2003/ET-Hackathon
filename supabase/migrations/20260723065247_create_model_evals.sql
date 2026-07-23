-- =============================================================================
-- Model evaluation log (Phase 2, saanslive-hackathon-upgrade-plan.md)
--
-- For every forecast whose forecast_at has passed, model/eval_agent.py
-- compares the model's prediction against the actual observed AQI and
-- against a persistence baseline (the AQI at the time the forecast was
-- made, i.e. "assume no change"), and records both errors here. This turns
-- the honesty-first "we report our model's real performance" ethos already
-- in train.py's per-city reporting into an automated, ongoing process.
--
-- Public users may read this log (same public-sensor-data posture as
-- stations/readings/weather/forecasts); only the server-side service_role
-- (the eval script, run via SUPABASE_DB_URL with full credentials, same as
-- the rest of the ingestion pipeline) may write to it.
-- =============================================================================

CREATE TABLE public.model_evals (
    id                     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    station_id             UUID          NOT NULL REFERENCES public.stations(id) ON DELETE CASCADE,
    forecast_at            TIMESTAMPTZ   NOT NULL,
    model_version          TEXT          NOT NULL,
    horizon_hours          INTEGER       NOT NULL,
    predicted_aqi          NUMERIC(6, 2) NOT NULL,
    actual_aqi             NUMERIC(6, 2) NOT NULL,
    baseline_predicted_aqi NUMERIC(6, 2) NOT NULL,
    model_abs_error        NUMERIC(6, 2) NOT NULL,
    baseline_abs_error     NUMERIC(6, 2) NOT NULL,
    model_beat_baseline    BOOLEAN       NOT NULL,
    evaluated_at           TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- One evaluation per (station, forecast_at, model_version, horizon) --
-- mirrors the forecasts table's own unique constraint, and is the conflict
-- target for the idempotent ON CONFLICT DO NOTHING insert pattern used
-- throughout ingestion/ -- re-running eval_agent.py never double-counts.
ALTER TABLE public.model_evals
    ADD CONSTRAINT uq_model_evals_station_forecast_model_horizon
        UNIQUE (station_id, forecast_at, model_version, horizon_hours);

CREATE INDEX idx_model_evals_station_time
    ON public.model_evals (station_id, forecast_at DESC);

CREATE INDEX idx_model_evals_evaluated_at
    ON public.model_evals (evaluated_at DESC);

ALTER TABLE public.model_evals ENABLE ROW LEVEL SECURITY;

-- Data API grants are separate from RLS -- keep the public surface read-only,
-- same pattern as agent_runs.
GRANT SELECT ON TABLE public.model_evals TO anon, authenticated;
GRANT ALL ON TABLE public.model_evals TO service_role;

CREATE POLICY "model_evals_public_read"
    ON public.model_evals
    FOR SELECT
    TO anon, authenticated
    USING (true);

CREATE POLICY "model_evals_service_write"
    ON public.model_evals
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
;
