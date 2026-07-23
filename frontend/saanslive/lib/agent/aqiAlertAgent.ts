import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getAqiBand } from "../aqi";
import type {
    AgentRun,
    AgentSelfReview,
    AgentTrigger,
    AlertLevel,
    AgentReasoningStep,
    FlaggedStation,
} from "./types";

const MAX_STATIONS_TO_REVIEW = 8;
const DATA_FRESHNESS_HOURS = 12;
const ELEVATED_AQI = 101;
const HIGH_AQI = 151;
const CRITICAL_AQI = 201;
const FORECAST_WORSENING_DELTA = 20;

type StationRow = { id: string; city: string; name: string };
type HotspotStatsRow = {
    station_id: string;
    current_aqi: string | number | null;
    current_reading_at: string | null;
};
type ForecastRow = {
    station_id: string;
    forecast_at: string;
    predicted_aqi: string | number;
    created_at: string;
};
type AgentRunRow = {
    id: string;
    created_at: string;
    trigger: AgentTrigger;
    reasoning_steps: unknown;
    flagged_stations: unknown;
    advisories: unknown;
    self_review: unknown;
};

export class AgentConfigurationError extends Error {}

function serverClient(): SupabaseClient {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceRoleKey) {
        throw new AgentConfigurationError(
            "The alert agent needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server."
        );
    }

    return createClient(url, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
}

function asNumber(value: string | number | null | undefined): number | null {
    if (value == null) return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function isFresh(iso: string | null, now: Date) {
    if (!iso) return false;
    const timestamp = new Date(iso).getTime();
    return Number.isFinite(timestamp) && timestamp >= now.getTime() - DATA_FRESHNESS_HOURS * 60 * 60 * 1000;
}

function alertLevelFor(aqi: number): AlertLevel {
    if (aqi >= CRITICAL_AQI) return "critical";
    if (aqi >= HIGH_AQI) return "high";
    return "elevated";
}

function advisoryFor(level: AlertLevel): string {
    if (level === "critical") {
        return "Avoid prolonged outdoor activity where possible and follow local public-health guidance for sensitive groups.";
    }
    if (level === "high") {
        return "Reduce prolonged outdoor exertion, especially for children, older adults, and people with respiratory conditions.";
    }
    return "Sensitive groups should limit prolonged outdoor exertion and check conditions again before heading out.";
}

function toAgentRun(row: AgentRunRow): AgentRun {
    return {
        id: row.id,
        createdAt: row.created_at,
        trigger: row.trigger === "scheduled" ? "scheduled" : "manual",
        reasoningSteps: Array.isArray(row.reasoning_steps) ? row.reasoning_steps as AgentReasoningStep[] : [],
        flaggedStations: Array.isArray(row.flagged_stations) ? row.flagged_stations as FlaggedStation[] : [],
        advisories:
            row.advisories && typeof row.advisories === "object" && !Array.isArray(row.advisories)
                ? row.advisories as Record<string, string>
                : {},
        selfReview:
            row.self_review && typeof row.self_review === "object" && !Array.isArray(row.self_review)
                ? row.self_review as AgentSelfReview
                : null,
    };
}

async function reviewPreviousRun(
    client: SupabaseClient,
    currentByStationId: Map<string, { aqi: number | null; observedAt: string | null }>,
    now: Date
): Promise<AgentSelfReview | null> {
    const { data, error } = await client
        .from("agent_runs")
        .select("id, flagged_stations, self_review")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) throw new Error(`Could not load the prior agent run: ${error.message}`);
    if (!data || data.self_review != null) return null;

    const previousFlags = Array.isArray(data.flagged_stations)
        ? data.flagged_stations as FlaggedStation[]
        : [];
    const outcomes = previousFlags.map((flag) => {
        const current = currentByStationId.get(flag.stationId);
        const observedAqi = current?.aqi ?? null;
        const verdict = observedAqi == null
            ? "no_data" as const
            : observedAqi >= ELEVATED_AQI
                ? "confirmed" as const
                : "false_alarm" as const;
        return {
            stationId: flag.stationId,
            city: flag.city,
            verdict,
            observedAqi,
            observedAt: current?.observedAt ?? null,
        };
    });

    const review: AgentSelfReview = {
        reviewedRunId: data.id,
        evaluatedAt: now.toISOString(),
        summary: {
            flagged: outcomes.length,
            confirmed: outcomes.filter((outcome) => outcome.verdict === "confirmed").length,
            falseAlarms: outcomes.filter((outcome) => outcome.verdict === "false_alarm").length,
            unavailable: outcomes.filter((outcome) => outcome.verdict === "no_data").length,
        },
        outcomes,
    };

    const { error: updateError } = await client
        .from("agent_runs")
        .update({ self_review: review })
        .eq("id", data.id);

    if (updateError) throw new Error(`Could not save the prior-run review: ${updateError.message}`);
    return review;
}

/**
 * Run the Civic AQI Alert Agent. Its decision path is deliberately
 * deterministic and fully logged: it uses live data, applies published
 * thresholds, writes an actionable advisory, and reviews the previous run.
 */
export async function runCivicAqiAlertAgent({
    trigger,
    now = new Date(),
}: {
    trigger: AgentTrigger;
    now?: Date;
}): Promise<AgentRun> {
    const client = serverClient();
    const [stationsResult, statsResult] = await Promise.all([
        client.from("stations").select("id, city, name"),
        client.rpc("get_hotspot_ranking_stats"),
    ]);

    if (stationsResult.error) throw new Error(`Could not load stations: ${stationsResult.error.message}`);
    if (statsResult.error) throw new Error(`Could not load hotspot statistics: ${statsResult.error.message}`);

    const stationsById = new Map<string, StationRow>(
        ((stationsResult.data ?? []) as StationRow[]).map((station) => [station.id, station])
    );
    const allStats = (statsResult.data ?? []) as HotspotStatsRow[];
    const currentByStationId = new Map<string, { aqi: number | null; observedAt: string | null }>();
    for (const stat of allStats) {
        currentByStationId.set(stat.station_id, {
            aqi: asNumber(stat.current_aqi),
            observedAt: stat.current_reading_at,
        });
    }

    const candidates = allStats
        .map((stat) => ({
            station: stationsById.get(stat.station_id),
            currentAqi: asNumber(stat.current_aqi),
            currentReadingAt: stat.current_reading_at,
        }))
        .filter((candidate): candidate is {
            station: StationRow;
            currentAqi: number | null;
            currentReadingAt: string | null;
        } => Boolean(candidate.station) && candidate.currentAqi != null)
        .sort((a, b) => (b.currentAqi ?? -1) - (a.currentAqi ?? -1))
        .slice(0, MAX_STATIONS_TO_REVIEW);

    const stationIds = candidates.map((candidate) => candidate.station.id);
    const { data: forecastData, error: forecastError } = stationIds.length === 0
        ? { data: [] as ForecastRow[], error: null }
        : await client
            .from("forecasts")
            .select("station_id, forecast_at, predicted_aqi, created_at")
            .in("station_id", stationIds)
            .eq("horizon_hours", 6)
            .order("created_at", { ascending: false })
            .limit(MAX_STATIONS_TO_REVIEW * 4);

    if (forecastError) throw new Error(`Could not load model forecasts: ${forecastError.message}`);

    const newestForecastByStation = new Map<string, ForecastRow>();
    for (const forecast of (forecastData ?? []) as ForecastRow[]) {
        if (!newestForecastByStation.has(forecast.station_id)) {
            newestForecastByStation.set(forecast.station_id, forecast);
        }
    }

    const reasoningSteps: AgentReasoningStep[] = [
        {
            step: "plan",
            description: "Loaded the latest station observations and the most recent six-hour forecasts for the highest-AQI stations.",
            data: {
                stationsLoaded: stationsById.size,
                stationsWithCurrentReadings: currentByStationId.size,
                candidatesReviewed: candidates.length,
                forecastRowsLoaded: forecastData?.length ?? 0,
                freshnessWindowHours: DATA_FRESHNESS_HOURS,
            },
        },
    ];

    const flags: FlaggedStation[] = [];
    const advisories: Record<string, string> = {};

    for (const candidate of candidates) {
        const forecast = newestForecastByStation.get(candidate.station.id);
        const forecastAqi = asNumber(forecast?.predicted_aqi);
        const currentFresh = isFresh(candidate.currentReadingAt, now);
        const forecastFresh = Boolean(forecast && isFresh(forecast.created_at, now));
        const currentAlert = currentFresh && (candidate.currentAqi ?? 0) >= ELEVATED_AQI;
        const worseningForecast = forecastFresh && forecastAqi != null && forecastAqi >= HIGH_AQI &&
            (candidate.currentAqi == null || forecastAqi - candidate.currentAqi >= FORECAST_WORSENING_DELTA);

        if (!currentAlert && !worseningForecast) continue;

        const alertAqi = Math.max(candidate.currentAqi ?? 0, forecastAqi ?? 0);
        const level = alertLevelFor(alertAqi);
        const currentPart = candidate.currentAqi != null
            ? `Observed AQI is ${Math.round(candidate.currentAqi)} (${getAqiBand(candidate.currentAqi).label})${currentFresh ? "" : "; the reading is older than the agent freshness window"}.`
            : "No current AQI reading is available.";
        const forecastPart = forecastAqi != null
            ? `The six-hour model forecast is ${Math.round(forecastAqi)} (${getAqiBand(forecastAqi).label}) for ${forecast?.forecast_at ?? "the next model window"}${forecastFresh ? "" : "; the model run is older than the agent freshness window"}.`
            : "No six-hour model forecast is available.";
        const decisionPart = worseningForecast
            ? `The forecast is at least ${FORECAST_WORSENING_DELTA} AQI points worse than the current reading.`
            : "The current observation meets the published alert threshold.";
        const reason = `${currentPart} ${forecastPart} ${decisionPart}`;

        const flag: FlaggedStation = {
            stationId: candidate.station.id,
            city: candidate.station.city,
            stationName: candidate.station.name,
            currentAqi: candidate.currentAqi == null ? null : Math.round(candidate.currentAqi),
            currentReadingAt: candidate.currentReadingAt,
            forecastAqi: forecastAqi == null ? null : Math.round(forecastAqi),
            forecastAt: forecast?.forecast_at ?? null,
            alertLevel: level,
            reason,
        };
        flags.push(flag);
        advisories[candidate.station.id] = advisoryFor(level);
    }

    reasoningSteps.push({
        step: "decide",
        description: "Applied the public alert rule: a fresh current AQI of 101+ or a fresh severe forecast that worsens by at least 20 AQI points.",
        data: {
            currentAlertThreshold: ELEVATED_AQI,
            forecastAlertThreshold: HIGH_AQI,
            worseningDelta: FORECAST_WORSENING_DELTA,
            flaggedStations: flags.length,
            flags: flags.map((flag) => ({
                city: flag.city,
                stationName: flag.stationName,
                currentAqi: flag.currentAqi,
                forecastAqi: flag.forecastAqi,
                alertLevel: flag.alertLevel,
            })),
        },
    });
    reasoningSteps.push({
        step: "act",
        description: "Generated a deterministic, level-appropriate public-health advisory for every flagged station.",
        data: { advisoriesGenerated: Object.keys(advisories).length },
    });

    const selfReview = await reviewPreviousRun(client, currentByStationId, now);
    reasoningSteps.push({
        step: "self_review",
        description: selfReview
            ? "Reviewed the prior run against the newest observed AQI and wrote the verdict back to that run."
            : "No unreviewed prior run was available yet.",
        data: selfReview
            ? { reviewedRunId: selfReview.reviewedRunId, ...selfReview.summary }
            : { reviewedRunId: null },
    });
    reasoningSteps.push({
        step: "log",
        description: "Persisted this run's query inputs, decisions, advisories, and self-review status for public inspection.",
        data: { trigger, createdAt: now.toISOString() },
    });

    const { data: inserted, error: insertError } = await client
        .from("agent_runs")
        .insert({
            trigger,
            reasoning_steps: reasoningSteps,
            flagged_stations: flags,
            advisories,
        })
        .select("id, created_at, trigger, reasoning_steps, flagged_stations, advisories, self_review")
        .single();

    if (insertError || !inserted) {
        throw new Error(`Could not save this agent run: ${insertError?.message ?? "no row returned"}`);
    }

    return toAgentRun(inserted as AgentRunRow);
}
