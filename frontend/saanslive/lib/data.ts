/**
 * lib/data.ts — Central data-fetching layer for SaanSLive.
 *
 * THIS IS THE ONLY FILE THAT SHOULD CHANGE when we switch from mock data
 * to live Supabase queries. No component imports Supabase directly.
 *
 * Interfaces match the production Supabase schema exactly:
 *   - Station     ↔  public.stations
 *   - Forecast    ↔  public.forecasts
 *   - Reading     ↔  public.readings
 *
 * To swap in real data:
 *   1. Add: import { createClient } from '@supabase/supabase-js'
 *   2. Replace each function body with a supabase.from(...).select(...) call.
 *   3. Keep every function signature and return type unchanged.
 */

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
// Mock station seed data — 5 cities with real approximate coordinates
// station UUIDs are stable fakes so foreign-key joins work in mock mode
// =============================================================================

const MOCK_STATIONS: Station[] = [
  {
    id: "11111111-0000-0000-0000-000000000001",
    external_id: "OPENAQ-DEL-001",
    city: "Delhi",
    name: "ITO Monitoring Station",
    latitude: 28.6315,
    longitude: 77.2430,
  },
  {
    id: "11111111-0000-0000-0000-000000000002",
    external_id: "OPENAQ-MUM-001",
    city: "Mumbai",
    name: "Bandra Kurla Complex",
    latitude: 19.0596,
    longitude: 72.8656,
  },
  {
    id: "11111111-0000-0000-0000-000000000003",
    external_id: "OPENAQ-BLR-001",
    city: "Bengaluru",
    name: "Silk Board Junction",
    latitude: 12.9172,
    longitude: 77.6229,
  },
  {
    id: "11111111-0000-0000-0000-000000000004",
    external_id: "OPENAQ-KOL-001",
    city: "Kolkata",
    name: "Rabindra Sarani",
    latitude: 22.5726,
    longitude: 88.3639,
  },
  {
    id: "11111111-0000-0000-0000-000000000005",
    external_id: "OPENAQ-CHE-001",
    city: "Chennai",
    name: "Anna Salai",
    latitude: 13.0569,
    longitude: 80.2425,
  },
];

// =============================================================================
// Baseline AQI levels per city — gives each city a realistic "character"
// so the dashboard doesn't show identical data for every station
// =============================================================================

const CITY_BASE_AQI: Record<string, number> = {
  Delhi: 155,
  Mumbai: 95,
  Bengaluru: 72,
  Kolkata: 118,
  Chennai: 88,
};

const CITY_BASE_PM25: Record<string, number> = {
  Delhi: 85,
  Mumbai: 42,
  Bengaluru: 28,
  Kolkata: 61,
  Chennai: 35,
};

// =============================================================================
// Deterministic variation — smooth sine wave so forecast looks like a real
// diurnal AQI cycle (worse in morning rush + evening, better in afternoon)
// =============================================================================

function diurnalOffset(hourOffset: number, amplitude: number): number {
  // Peak at hour 8 (morning rush) and hour 20 (evening traffic)
  const baseHour = (new Date().getUTCHours() + hourOffset) % 24;
  const morningPeak = Math.exp(-0.5 * Math.pow((baseHour - 8) / 3, 2));
  const eveningPeak = Math.exp(-0.5 * Math.pow((baseHour - 20) / 3, 2));
  return amplitude * (morningPeak + eveningPeak * 0.8 - 0.3);
}

// =============================================================================
// Public API — three async functions, one per Supabase table
// =============================================================================

/**
 * Return all monitored stations.
 * Supabase equivalent: supabase.from('stations').select('*')
 */
export async function getStations(): Promise<Station[]> {
  // ── MOCK ── replace body with Supabase query when ready
  return MOCK_STATIONS;
}

/**
 * Return forecast rows for a given station, horizon_hours=6, next 24 h.
 * Rows are sorted ascending by forecast_at (earliest first).
 *
 * Supabase equivalent:
 *   supabase.from('forecasts')
 *     .select('*')
 *     .eq('station_id', stationId)
 *     .eq('horizon_hours', 6)
 *     .gte('forecast_at', new Date().toISOString())
 *     .order('forecast_at', { ascending: true })
 *     .limit(24)
 */
export async function getLatestForecasts(stationId: string): Promise<Forecast[]> {
  // ── MOCK ── replace body with Supabase query when ready
  const station = MOCK_STATIONS.find((s) => s.id === stationId);
  if (!station) return [];

  const baseAqi = CITY_BASE_AQI[station.city] ?? 100;
  const now = new Date();
  // Round down to the nearest hour for stable mock data across renders
  now.setMinutes(0, 0, 0);

  const forecasts: Forecast[] = [];

  for (let h = 1; h <= 24; h++) {
    const forecastAt = new Date(now.getTime() + h * 60 * 60 * 1000);
    // Smooth diurnal variation ± 25 AQI around the base
    const variation = diurnalOffset(h, 25);
    // Slight upward trend to simulate accumulation, small bounded noise
    const trend = h * 0.4;
    const predictedAqi = Math.max(
      10,
      Math.min(400, baseAqi + variation + trend - 8)
    );

    forecasts.push({
      id: `mock-forecast-${stationId.slice(-1)}-h${h}`,
      station_id: stationId,
      forecast_at: forecastAt.toISOString(),
      predicted_aqi: Math.round(predictedAqi * 10) / 10,
      model_version: "xgb-v1.0",
      horizon_hours: 6,
      model_rmse: 14.2,
      baseline_rmse: 28.7,
      created_at: new Date().toISOString(),
    });
  }

  return forecasts;
}

/**
 * Return the most recent AQI reading for a given station.
 * Supabase equivalent:
 *   supabase.from('readings')
 *     .select('station_id, timestamp, aqi, pm25')
 *     .eq('station_id', stationId)
 *     .order('timestamp', { ascending: false })
 *     .limit(1)
 *     .single()
 */
export async function getCurrentReading(stationId: string): Promise<Reading | null> {
  // ── MOCK ── replace body with Supabase query when ready
  const station = MOCK_STATIONS.find((s) => s.id === stationId);
  if (!station) return null;

  const baseAqi  = CITY_BASE_AQI[station.city]  ?? 100;
  const basePm25 = CITY_BASE_PM25[station.city] ?? 45;
  // Current reading = base + small diurnal nudge
  const currentOffset = diurnalOffset(0, 20);

  return {
    station_id: stationId,
    timestamp: new Date().toISOString(),
    aqi:  Math.round((baseAqi  + currentOffset) * 10) / 10,
    pm25: Math.round((basePm25 + currentOffset * 0.45) * 10) / 10,
  };
}
