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

import { createClient } from "@supabase/supabase-js";

// =============================================================================
// Supabase client — uses publishable key (safe to expose in browser)
// =============================================================================

const supabaseUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey  = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Singleton — Next.js module cache keeps this alive across renders
const supabase = createClient(supabaseUrl, supabaseKey);

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
 */
export async function getStations(): Promise<Station[]> {
  const { data, error } = await supabase
    .from("stations")
    .select("id, external_id, city, name, latitude, longitude")
    .order("city", { ascending: true });

  if (error) {
    console.error("[getStations] Supabase error:", error.message);
    return [];
  }

  // Cast latitude/longitude from string (Supabase numeric) to number
  return (data ?? []).map((row) => ({
    ...row,
    latitude:  Number(row.latitude),
    longitude: Number(row.longitude),
  }));
}

/**
 * Return the most recent forecast rows for a station, horizon_hours=6.
 * Returns up to 24 rows, sorted ascending by forecast_at (earliest first).
 *
 * If no forecasts exist for the station yet (model artifacts not trained),
 * returns an empty array — components handle this gracefully.
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
    return [];
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
 * Returns null if no readings exist for the station.
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
    // PGRST116 = no rows found — expected for stations with no readings yet
    if (error.code !== "PGRST116") {
      console.error("[getCurrentReading] Supabase error:", error.message);
    }
    return null;
  }

  return {
    ...data,
    aqi:  Number(data.aqi),
    pm25: Number(data.pm25),
  };
}
