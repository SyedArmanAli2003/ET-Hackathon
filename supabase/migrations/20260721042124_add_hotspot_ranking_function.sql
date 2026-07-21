CREATE OR REPLACE FUNCTION public.get_hotspot_ranking_stats()
RETURNS TABLE (
    station_id uuid,
    current_aqi numeric,
    current_reading_at timestamptz,
    avg_aqi_this_week numeric,
    readings_this_week bigint,
    avg_aqi_last_week numeric,
    readings_last_week bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    WITH latest AS (
        SELECT DISTINCT ON (r.station_id)
            r.station_id,
            r.aqi AS current_aqi,
            r.timestamp AS current_reading_at
        FROM readings r
        ORDER BY r.station_id, r.timestamp DESC
    ),
    this_week AS (
        SELECT r.station_id, AVG(r.aqi) AS avg_aqi, COUNT(*) AS c
        FROM readings r
        WHERE r.timestamp >= now() - interval '7 days'
        GROUP BY r.station_id
    ),
    last_week AS (
        SELECT r.station_id, AVG(r.aqi) AS avg_aqi, COUNT(*) AS c
        FROM readings r
        WHERE r.timestamp >= now() - interval '14 days'
          AND r.timestamp <  now() - interval '7 days'
        GROUP BY r.station_id
    )
    SELECT
        l.station_id,
        l.current_aqi,
        l.current_reading_at,
        tw.avg_aqi        AS avg_aqi_this_week,
        COALESCE(tw.c, 0) AS readings_this_week,
        lw.avg_aqi        AS avg_aqi_last_week,
        COALESCE(lw.c, 0) AS readings_last_week
    FROM latest l
    LEFT JOIN this_week tw ON tw.station_id = l.station_id
    LEFT JOIN last_week lw ON lw.station_id = l.station_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_hotspot_ranking_stats() TO anon, authenticated;
;
