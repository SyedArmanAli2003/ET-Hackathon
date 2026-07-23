import { getAqiBand } from "./aqi";
import type { Forecast, Reading } from "./data";

export type PlanActivity = "commute" | "exercise" | "school_run" | "delivery";

export type AirPlan = {
    activity: PlanActivity;
    activityLabel: string;
    risk: "lower" | "elevated" | "high" | "very_high";
    riskScore: number;
    bestWindow: { aqi: number; forecastAt: string } | null;
    worstWindow: { aqi: number; forecastAt: string } | null;
    recommendation: string;
    practicalStep: string;
    explanation: string;
    hasFutureForecast: boolean;
};

export const PLAN_ACTIVITIES: Array<{
    id: PlanActivity;
    label: string;
    shortLabel: string;
    threshold: number;
    practicalStep: string;
}> = [
    {
        id: "commute",
        label: "Commute",
        shortLabel: "Commute",
        threshold: 150,
        practicalStep: "Prefer the lowest-traffic route where possible and keep vehicle windows closed in heavier traffic.",
    },
    {
        id: "exercise",
        label: "Outdoor workout",
        shortLabel: "Workout",
        threshold: 100,
        practicalStep: "Choose a gentler session or move it indoors if the air remains elevated.",
    },
    {
        id: "school_run",
        label: "School run",
        shortLabel: "School run",
        threshold: 100,
        practicalStep: "Keep the outdoor wait short and avoid busy roadside stretches where possible.",
    },
    {
        id: "delivery",
        label: "Delivery shift",
        shortLabel: "Delivery",
        threshold: 150,
        practicalStep: "Group nearby stops and take short indoor breaks when conditions are poor.",
    },
];

function getActivity(activity: PlanActivity) {
    return PLAN_ACTIVITIES.find((item) => item.id === activity) ?? PLAN_ACTIVITIES[0];
}

function clamp(value: number, lower: number, upper: number) {
    return Math.min(upper, Math.max(lower, value));
}

/**
 * Turn the app's station forecast into a transparent activity recommendation.
 *
 * This deliberately does not use an LLM or invent a health score. The score
 * is a simple presentation of AQI severity, activity sensitivity, and the
 * user's selected vulnerability flags so the UI can explain every input.
 */
export function buildAirPlan({
    activity,
    currentReading,
    forecasts,
    vulnerabilityFlags = [],
    now = new Date(),
}: {
    activity: PlanActivity;
    currentReading: Reading | null;
    forecasts: Forecast[];
    vulnerabilityFlags?: string[];
    now?: Date;
}): AirPlan {
    const activityConfig = getActivity(activity);
    const sortedForecasts = [...forecasts].sort(
        (a, b) => new Date(a.forecast_at).getTime() - new Date(b.forecast_at).getTime()
    );
    const futureForecasts = sortedForecasts.filter(
        (forecast) => new Date(forecast.forecast_at).getTime() >= now.getTime() - 60 * 60 * 1000
    );
    const usableForecasts = futureForecasts.length > 0 ? futureForecasts : sortedForecasts;

    const bestForecast = usableForecasts.reduce<Forecast | null>(
        (best, forecast) => !best || forecast.predicted_aqi < best.predicted_aqi ? forecast : best,
        null
    );
    const worstForecast = usableForecasts.reduce<Forecast | null>(
        (worst, forecast) => !worst || forecast.predicted_aqi > worst.predicted_aqi ? forecast : worst,
        null
    );

    // Use the more cautious of the current observation and the forecast peak.
    // It prevents a reassuring plan when pollution is already worse than the
    // model's next available prediction.
    const referenceAqi = Math.max(
        currentReading?.aqi ?? 0,
        worstForecast?.predicted_aqi ?? 0
    );
    const vulnerabilityAdjustment = vulnerabilityFlags.length > 0 ? 12 : 0;
    const activityAdjustment = activity === "exercise" || activity === "school_run" ? 10 : 0;
    const riskScore = clamp(
        Math.round((referenceAqi / 300) * 100 + vulnerabilityAdjustment + activityAdjustment),
        0,
        100
    );

    const risk: AirPlan["risk"] =
        riskScore < 25 ? "lower" :
        riskScore < 50 ? "elevated" :
        riskScore < 75 ? "high" : "very_high";

    const conservativeThreshold = Math.max(
        50,
        activityConfig.threshold - (vulnerabilityFlags.length > 0 ? 25 : 0)
    );
    const bestAqi = bestForecast?.predicted_aqi ?? currentReading?.aqi ?? null;
    const bestBand = bestAqi != null ? getAqiBand(bestAqi) : null;

    let recommendation: string;
    if (bestAqi == null) {
        recommendation = "A plan will appear when this station has a current AQI reading or model forecast.";
    } else if (bestAqi <= conservativeThreshold) {
        recommendation = `The best available window is suitable for a ${activityConfig.label.toLowerCase()} with normal precautions.`;
    } else if (bestAqi <= conservativeThreshold + 50) {
        recommendation = `Consider shortening or rescheduling this ${activityConfig.label.toLowerCase()}; conditions are ${bestBand?.label.toLowerCase() ?? "elevated"}.`;
    } else {
        recommendation = `Delay or move this ${activityConfig.label.toLowerCase()} indoors if you can; the best available conditions are still ${bestBand?.label.toLowerCase() ?? "poor"}.`;
    }

    const explanationParts = [
        `AQI is compared with a ${conservativeThreshold} planning threshold for ${activityConfig.label.toLowerCase()}.`,
    ];
    if (vulnerabilityFlags.length > 0) {
        explanationParts.push("Your selected household sensitivities lower that threshold by 25 AQI points.");
    }
    if (!futureForecasts.length && sortedForecasts.length > 0) {
        explanationParts.push("The available forecast timestamp has passed, so treat this as a recent model snapshot rather than a future window.");
    }

    return {
        activity,
        activityLabel: activityConfig.label,
        risk,
        riskScore,
        bestWindow: bestForecast
            ? { aqi: Math.round(bestForecast.predicted_aqi), forecastAt: bestForecast.forecast_at }
            : null,
        worstWindow: worstForecast
            ? { aqi: Math.round(worstForecast.predicted_aqi), forecastAt: worstForecast.forecast_at }
            : null,
        recommendation,
        practicalStep: activityConfig.practicalStep,
        explanation: explanationParts.join(" "),
        hasFutureForecast: futureForecasts.length > 0,
    };
}
