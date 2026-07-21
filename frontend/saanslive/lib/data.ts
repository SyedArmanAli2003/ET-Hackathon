/**
 * lib/data.ts — Central data-fetching layer for SaanSLive.
 *
 * THIS IS THE ONLY FILE THAT SHOULD CHANGE when switching data sources.
 * No component imports Supabase directly.
 *
 * Interfaces match the production Supabase schema exactly:
 *   - Station     ↔  public.stations
 *   - Forecast    ↔  public.forecasts
 *   - Reading     ↔  public.readings
 */

import { supabase } from "./supabaseClient";

// =============================================================================
// TypeScript interfaces — mirror the Supabase table schemas exactly
// =============================================================================

/** public.stations */
export interface Station {
  id: string;           // UUID
  external_id: string;  // OpenAQ location ID
  city: string;
  name: string;         // station display name
  latitude: number;
  longitude: number;
}

/** public.forecasts */
export interface Forecast {
  id: string;           // UUID
  station_id: string;   // FK → stations.id
  forecast_at: string;  // ISO 8601 UTC — the future moment being predicted
  predicted_aqi: number;
  model_version: string; // e.g. "xgb-v1.0"
  horizon_hours: number; // 1, 6, 24
  model_rmse: number | null;
  baseline_rmse: number | null;
  created_at: string;   // ISO 8601 UTC — when this forecast was generated
}

/** public.readings */
export interface Reading {
  station_id: string;   // FK → stations.id
  timestamp: string;    // ISO 8601 UTC
  aqi: number;
  pm25: number;
}

/**
 * One ranked row for the Hotspot Prioritization panel.
 *
 * Every field here is derived directly from `readings` — nothing is
 * invented. `trendDirection`/`trendChangePct` compare this week's average
 * AQI against last week's average AQI for the same station.
 */
export interface HotspotRankingEntry {
  station: Station;
  /** Most recent AQI reading for this station. Null if the station has no readings at all. */
  currentAqi: number | null;
  /** ISO timestamp of the current reading, or null if none exists. */
  currentReadingAt: string | null;
  /** Average AQI over the last 7 days. Null if there are no readings in that window. */
  avgAqiThisWeek: number | null;
  /** Average AQI over the 7 days before that. Null if there are no readings in that window. */
  avgAqiLastWeek: number | null;
  /** % change of this week's average vs last week's (positive = worsening). Null if last week has no data to compare against. */
  trendChangePct: number | null;
  trendDirection: "worsening" | "improving" | "stable" | "unknown";
  /** current_aqi component of the score, normalized to 0-1 against a 500 AQI ceiling. */
  aqiComponent: number;
  /** trend component of the score, normalized to 0-1 (clamped ±100% change). */
  trendComponent: number;
  /** priorityScore = aqiComponent * 0.6 + trendComponent * 0.4, on a 0-100 scale. Higher = more urgent. */
  priorityScore: number;
}

// =============================================================================
// Public API — three async functions, one per Supabase table
// =============================================================================

/**
 * Return all monitored stations.
 *
 * Throws on a genuine query failure (network/RLS/etc.) so callers can show
 * a distinct error state. An empty result with no error (zero stations) is
 * NOT an error — it's returned as an empty array for callers to handle as
 * a legitimate "no data" case.
 */
export async function getStations(): Promise<Station[]> {
  const { data, error } = await supabase
    .from("stations")
    .select("id, external_id, city, name, latitude, longitude")
    .order("city", { ascending: true });

  if (error) {
    console.error("[getStations] Supabase error:", error.message);
    throw new Error("Failed to load stations. Please try again.");
  }

  // Cast latitude/longitude from string (Supabase numeric) to number
  return (data ?? []).map((row) => ({
    ...row,
    latitude:  Number(row.latitude),
    longitude: Number(row.longitude),
  }));
}

/**
 * Return the set of station IDs that have at least one forecast row.
 *
 * Used by the dashboard to pick a sensible default station on load --
 * without this, the default is just "alphabetically first city, first
 * station within it", which can easily land on a station with zero
 * readings/forecasts (e.g. a sensor that was never active) while other
 * stations in the same city have real data. This never throws; on a
 * genuine query failure it returns an empty set, and the caller falls
 * back to its existing default-selection behavior.
 */
export async function getStationIdsWithForecasts(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("forecasts")
    .select("station_id")
    .eq("horizon_hours", 6); // Only count horizon=6 since that's what the chart shows

  if (error) {
    console.error("[getStationIdsWithForecasts] Supabase error:", error.message);
    return new Set();
  }

  return new Set((data ?? []).map((row) => row.station_id as string));
}

/**
 * Return the set of station IDs that have at least one reading row.
 *
 * Used together with getStationIdsWithForecasts to pick a default station
 * on load that has BOTH readings and forecasts, giving a fully-populated
 * dashboard on first view rather than landing on an offline sensor.
 * Never throws; returns an empty set on failure.
 */
export async function getStationIdsWithReadings(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("readings")
    .select("station_id");

  if (error) {
    console.error("[getStationIdsWithReadings] Supabase error:", error.message);
    return new Set();
  }

  return new Set((data ?? []).map((row) => row.station_id as string));
}

/**
 * Return the most recent forecast rows for a station, horizon_hours=6.
 * Returns up to 24 rows, sorted ascending by forecast_at (earliest first).
 *
 * If no forecasts exist for the station yet (model artifacts not trained),
 * returns an empty array — this is a legitimate "no data" case, not an
 * error, and components render a dedicated empty state for it.
 *
 * Throws on a genuine query failure so callers can show a distinct error
 * state instead of silently treating it the same as "no forecasts yet".
 */
export async function getLatestForecasts(stationId: string): Promise<Forecast[]> {
  const { data, error } = await supabase
    .from("forecasts")
    .select(
      "id, station_id, forecast_at, predicted_aqi, model_version, horizon_hours, model_rmse, baseline_rmse, created_at"
    )
    .eq("station_id", stationId)
    .eq("horizon_hours", 6)
    .order("forecast_at", { ascending: true })
    .limit(24);

  if (error) {
    console.error("[getLatestForecasts] Supabase error:", error.message);
    throw new Error("Failed to load the forecast. Please try again.");
  }

  return (data ?? []).map((row) => ({
    ...row,
    predicted_aqi: Number(row.predicted_aqi),
    model_rmse:    row.model_rmse    != null ? Number(row.model_rmse)    : null,
    baseline_rmse: row.baseline_rmse != null ? Number(row.baseline_rmse) : null,
  }));
}

/**
 * Return the most recent AQI reading for a given station.
 * Returns null if no readings exist for the station (legitimate "no data",
 * PGRST116 = no rows found — expected for stations with no readings yet).
 *
 * Throws on any other query failure so callers can distinguish "no reading
 * yet" from "the request actually failed".
 */
export async function getCurrentReading(stationId: string): Promise<Reading | null> {
  const { data, error } = await supabase
    .from("readings")
    .select("station_id, timestamp, aqi, pm25")
    .eq("station_id", stationId)
    .order("timestamp", { ascending: false })
    .limit(1)
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      // No rows found — legitimate empty state, not an error.
      return null;
    }
    console.error("[getCurrentReading] Supabase error:", error.message);
    throw new Error("Failed to load the current reading. Please try again.");
  }

  return {
    ...data,
    aqi:  Number(data.aqi),
    pm25: Number(data.pm25),
  };
}

// =============================================================================
// Hotspot Prioritization
// =============================================================================

/** Raw row shape returned by the `get_hotspot_ranking_stats` Postgres function. */
interface HotspotStatsRow {
  station_id: string;
  current_aqi: string | number | null;
  current_reading_at: string | null;
  avg_aqi_this_week: string | number | null;
  readings_this_week: string | number;
  avg_aqi_last_week: string | number | null;
  readings_last_week: string | number;
}

// AQI ceiling used to normalize the "current severity" component to 0-1.
// 500 is the top of the US EPA AQI scale (see lib/aqi.ts bands, which cap at
// "Hazardous" for 301+); values above it are clamped rather than exceeding 1.
const AQI_NORMALIZATION_CEILING = 500;

// The trend component clamps % change to ±100 before normalizing to 0-1, so
// one extreme outlier station can't blow the trend axis out of proportion
// relative to every other station's trend.
const TREND_CLAMP_PCT = 100;

const PRIORITY_WEIGHT_AQI = 0.6;
const PRIORITY_WEIGHT_TREND = 0.4;

/**
 * Return every station ranked by how urgently it warrants attention, using
 * only real numbers already in `readings`:
 *
 *   1. current_aqi   — the station's most recent reading (higher = more urgent)
 *   2. trend_change_pct — % change of this week's average AQI vs last week's
 *      average AQI (worsening = more urgent)
 *
 * priorityScore = aqiComponent * 0.6 + trendComponent * 0.4 (0-100 scale).
 * Both components are returned alongside the combined score so the UI can
 * show the breakdown rather than a single opaque number.
 *
 * This does NOT rank by registered pollution source / emitter data — that
 * data does not exist in this schema. See the disclaimer surfaced in
 * HotspotPanel.tsx.
 *
 * Throws on a genuine query failure so the caller can show a distinct error
 * state. Stations with zero readings are included with null AQI/trend
 * fields and sort to the bottom, rather than being silently dropped.
 */
export async function getHotspotRanking(): Promise<HotspotRankingEntry[]> {
  const [stations, statsResult] = await Promise.all([
    getStations(),
    supabase.rpc("get_hotspot_ranking_stats"),
  ]);

  const { data, error } = statsResult;

  if (error) {
    console.error("[getHotspotRanking] Supabase error:", error.message);
    throw new Error("Failed to load the hotspot ranking. Please try again.");
  }

  const statsByStationId = new Map<string, HotspotStatsRow>(
    ((data ?? []) as HotspotStatsRow[]).map((row) => [row.station_id, row])
  );

  const entries: HotspotRankingEntry[] = stations.map((station) => {
    const stats = statsByStationId.get(station.id);

    const currentAqi = stats?.current_aqi != null ? Number(stats.current_aqi) : null;
    const avgAqiThisWeek = stats?.avg_aqi_this_week != null ? Number(stats.avg_aqi_this_week) : null;
    const avgAqiLastWeek = stats?.avg_aqi_last_week != null ? Number(stats.avg_aqi_last_week) : null;

    // Trend: % change of this week's average vs last week's. Requires both
    // weeks to have at least one reading — otherwise there's nothing real
    // to compare, so it's reported as "unknown" rather than guessed at.
    let trendChangePct: number | null = null;
    let trendDirection: HotspotRankingEntry["trendDirection"] = "unknown";

    if (avgAqiThisWeek != null && avgAqiLastWeek != null && avgAqiLastWeek > 0) {
      trendChangePct = ((avgAqiThisWeek - avgAqiLastWeek) / avgAqiLastWeek) * 100;
      if (trendChangePct > 1) trendDirection = "worsening";
      else if (trendChangePct < -1) trendDirection = "improving";
      else trendDirection = "stable";
    }

    const aqiComponent =
      currentAqi != null
        ? Math.min(1, Math.max(0, currentAqi / AQI_NORMALIZATION_CEILING))
        : 0;

    const trendComponent =
      trendChangePct != null
        ? Math.min(1, Math.max(0, trendChangePct / TREND_CLAMP_PCT)) // negative (improving) clamps to 0 urgency
        : 0;

    const priorityScore =
      (aqiComponent * PRIORITY_WEIGHT_AQI + trendComponent * PRIORITY_WEIGHT_TREND) * 100;

    return {
      station,
      currentAqi,
      currentReadingAt: stats?.current_reading_at ?? null,
      avgAqiThisWeek,
      avgAqiLastWeek,
      trendChangePct,
      trendDirection,
      aqiComponent,
      trendComponent,
      priorityScore,
    };
  });

  // Rank: stations with no current reading at all sort last (nothing to
  // prioritize), everyone else by priorityScore descending.
  entries.sort((a, b) => {
    if (a.currentAqi == null && b.currentAqi == null) return 0;
    if (a.currentAqi == null) return 1;
    if (b.currentAqi == null) return -1;
    return b.priorityScore - a.priorityScore;
  });

  return entries;
}
