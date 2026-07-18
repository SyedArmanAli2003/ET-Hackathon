/**
 * lib/chatTools.ts — Tool definitions + implementations for the AI chatbot.
 *
 * These are the ONLY way the chatbot touches real data: every tool queries
 * the live stations/readings/forecasts tables directly (server-side,
 * publishable-key scoped, same tables the rest of the app reads). The model
 * never gets to invent numbers -- it can only report what these functions
 * actually return, and the tool result is fed back to it verbatim.
 */

import { createClient } from "@supabase/supabase-js";
import { getAqiBand } from "./aqi";

// Server-side Supabase client. Uses the same public anon/publishable key as
// the browser client (these tables are public-read by RLS) -- no secret
// key needed here, this is not privileged access.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

// =============================================================================
// Tool schemas (OpenAI-compatible function-calling format, works with NVIDIA NIM)
// =============================================================================

export const CHAT_TOOLS = [
    {
        type: "function" as const,
        function: {
            name: "list_stations",
            description:
                "List all monitored air quality stations, optionally filtered by city name. Use this to find a station's exact name/city before calling other tools, or to answer 'what cities/stations do you track' questions.",
            parameters: {
                type: "object",
                properties: {
                    city: {
                        type: "string",
                        description: "Optional city name to filter by (case-insensitive, partial match allowed).",
                    },
                },
            },
        },
    },
    {
        type: "function" as const,
        function: {
            name: "get_current_aqi",
            description:
                "Get the most recent real AQI/PM2.5 reading for a city or station name. Use this for 'what is the AQI right now in X' questions.",
            parameters: {
                type: "object",
                properties: {
                    city_or_station: {
                        type: "string",
                        description: "City name or station name to look up.",
                    },
                },
                required: ["city_or_station"],
            },
        },
    },
    {
        type: "function" as const,
        function: {
            name: "get_forecast",
            description:
                "Get the model's AQI forecast (next-6h horizon) for a city or station name. Returns each predicted future reading. Use this for 'what will the AQI be' / 'is it safe later today' questions.",
            parameters: {
                type: "object",
                properties: {
                    city_or_station: {
                        type: "string",
                        description: "City name or station name to look up.",
                    },
                },
                required: ["city_or_station"],
            },
        },
    },
    {
        type: "function" as const,
        function: {
            name: "compare_cities_aqi",
            description:
                "Get the current AQI for multiple cities at once, to compare air quality across cities. Use this for 'which city has the worst air quality' or 'compare Delhi and Mumbai' type questions.",
            parameters: {
                type: "object",
                properties: {
                    cities: {
                        type: "array",
                        items: { type: "string" },
                        description: "List of city names to compare.",
                    },
                },
                required: ["cities"],
            },
        },
    },
];

export type ChatToolName =
    | "list_stations"
    | "get_current_aqi"
    | "get_forecast"
    | "compare_cities_aqi";

// =============================================================================
// Tool implementations — every one hits the real Supabase tables
// =============================================================================

async function findStationsMatching(query: string) {
    const { data, error } = await supabase
        .from("stations")
        .select("id, city, name, latitude, longitude")
        .or(`city.ilike.%${query}%,name.ilike.%${query}%`)
        .limit(10);

    if (error) throw new Error(`Supabase query failed: ${error.message}`);
    return data ?? [];
}

async function listStations(args: { city?: string }) {
    let q = supabase.from("stations").select("id, city, name").order("city");
    if (args.city) {
        q = q.ilike("city", `%${args.city}%`);
    }
    const { data, error } = await q.limit(50);
    if (error) return { error: error.message };
    return {
        count: data?.length ?? 0,
        stations: (data ?? []).map((s) => ({ city: s.city, name: s.name })),
    };
}

async function getCurrentAqi(args: { city_or_station: string }) {
    const stations = await findStationsMatching(args.city_or_station);
    if (stations.length === 0) {
        return { error: `No station found matching "${args.city_or_station}".` };
    }

    const results = await Promise.all(
        stations.slice(0, 5).map(async (st) => {
            const { data, error } = await supabase
                .from("readings")
                .select("timestamp, aqi, pm25")
                .eq("station_id", st.id)
                .order("timestamp", { ascending: false })
                .limit(1)
                .maybeSingle();

            if (error || !data) {
                return { city: st.city, station: st.name, reading: null };
            }

            const aqi = Number(data.aqi);
            const band = getAqiBand(aqi);
            return {
                city: st.city,
                station: st.name,
                aqi,
                pm25: Number(data.pm25),
                category: band.label,
                observed_at: data.timestamp,
            };
        })
    );

    return { results };
}

async function getForecast(args: { city_or_station: string }) {
    const stations = await findStationsMatching(args.city_or_station);
    if (stations.length === 0) {
        return { error: `No station found matching "${args.city_or_station}".` };
    }

    const results = await Promise.all(
        stations.slice(0, 3).map(async (st) => {
            const { data, error } = await supabase
                .from("forecasts")
                .select("forecast_at, predicted_aqi, horizon_hours")
                .eq("station_id", st.id)
                .eq("horizon_hours", 6)
                .order("forecast_at", { ascending: true })
                .limit(10);

            if (error) return { city: st.city, station: st.name, forecasts: [], error: error.message };
            if (!data || data.length === 0) {
                return { city: st.city, station: st.name, forecasts: [], note: "No forecast available for this station yet." };
            }

            return {
                city: st.city,
                station: st.name,
                forecasts: data.map((f) => {
                    const aqi = Number(f.predicted_aqi);
                    return {
                        forecast_at: f.forecast_at,
                        predicted_aqi: aqi,
                        category: getAqiBand(aqi).label,
                    };
                }),
            };
        })
    );

    return { results };
}

async function compareCitiesAqi(args: { cities: string[] }) {
    const results = await Promise.all(
        args.cities.slice(0, 10).map(async (city) => {
            const result = await getCurrentAqi({ city_or_station: city });
            if ("error" in result) return { city, error: result.error };
            const best = result.results?.[0];
            return best ?? { city, error: "No data" };
        })
    );
    return { comparison: results };
}

/** Dispatch a tool call by name. Never throws -- returns { error } on failure. */
export async function runChatTool(
    name: string,
    args: Record<string, unknown>
): Promise<unknown> {
    try {
        switch (name as ChatToolName) {
            case "list_stations":
                return await listStations(args as { city?: string });
            case "get_current_aqi":
                return await getCurrentAqi(args as { city_or_station: string });
            case "get_forecast":
                return await getForecast(args as { city_or_station: string });
            case "compare_cities_aqi":
                return await compareCitiesAqi(args as { cities: string[] });
            default:
                return { error: `Unknown tool: ${name}` };
        }
    } catch (err) {
        return { error: err instanceof Error ? err.message : "Tool execution failed." };
    }
}
