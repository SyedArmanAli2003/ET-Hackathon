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
