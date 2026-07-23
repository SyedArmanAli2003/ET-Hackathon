-- database: :memory:
-- =============================================================================
-- Civic AQI Alert Agent run log
--
-- Public users may read the agent's reasoning trace and alerts, but only the
-- server-side service_role may create or update runs. Explicit GRANTs are
-- included because new Supabase projects may not expose new public tables to
-- the Data API automatically.
-- =============================================================================

CREATE TABLE public.agent_runs (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    trigger          TEXT        NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
    reasoning_steps  JSONB       NOT NULL DEFAULT '[]'::jsonb,
    flagged_stations JSONB       NOT NULL DEFAULT '[]'::jsonb,
    advisories       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    self_review      JSONB
);
CREATE INDEX idx_agent_runs_created_at
    ON public.agent_runs (created_at DESC);
ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;
-- Data API grants are separate from RLS. Keep the public surface read-only.
GRANT SELECT ON TABLE public.agent_runs TO anon, authenticated;
GRANT ALL ON TABLE public.agent_runs TO service_role;
CREATE POLICY "agent_runs_public_read"
    ON public.agent_runs
    FOR SELECT
    TO anon, authenticated
    USING (true);
CREATE POLICY "agent_runs_service_write"
    ON public.agent_runs
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
