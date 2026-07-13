"use client";

import React, { useMemo } from "react";
import type { Forecast, Reading, Station } from "../lib/data";
import { getAqiBand } from "../lib/aqi";
import { CardSkeleton } from "./Skeleton";

export type AdvisoryPanelProps = {
    station: Station;
    forecasts: Forecast[];
    currentReading: Reading | null;
    /** Vulnerability flags from the user's profile, e.g. ["children", "elderly"]. */
    vulnerabilityFlags?: string[];
    loading?: boolean;
    error?: string | null;
};

const FLAG_LABELS: Record<string, string> = {
    children: "children",
    elderly: "elderly residents",
    asthma: "people with asthma or respiratory conditions",
};

/**
 * Build the closing guidance clause based on the user's actual flags.
 * Falls back to generic guidance when no flags are set, rather than
 * assuming "children and elderly" applies to everyone.
 */
function buildGuidanceClause(flags: string[] | undefined): string {
    const known = (flags ?? []).filter((f) => FLAG_LABELS[f]);

    if (known.length === 0) {
        return "consider limiting prolonged outdoor exertion";
    }

    const labels = known.map((f) => FLAG_LABELS[f]);
    const joined =
        labels.length === 1
            ? labels[0]
            : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;

    return `limit outdoor activity for ${joined}`;
}

function formatTime(iso: string) {
    const d = new Date(iso);
    const hours = d.getHours();
    const minutes = d.getMinutes();
    const ampm = hours >= 12 ? "pm" : "am";
    const h12 = hours % 12 === 0 ? 12 : hours % 12;

    // forecasts are hourly in mock; keep it clean for 00 minutes
    const mm = minutes.toString().padStart(2, "0");
    return minutes === 0 ? `${h12}${ampm}` : `${h12}:${mm}${ampm}`;
}

export default function AdvisoryPanel({
    station,
    forecasts,
    vulnerabilityFlags,
    loading = false,
    error = null,
}: AdvisoryPanelProps) {
    const advisory = useMemo(() => {
        if (!forecasts || forecasts.length === 0) return null;

        // Peak predicted AQI in next 24h
        const peak = forecasts.reduce((acc, f) =>
            f.predicted_aqi > acc.predicted_aqi ? f : acc
        );

        const band = getAqiBand(peak.predicted_aqi);

        return {
            band,
            value: Math.round(peak.predicted_aqi),
            time: formatTime(peak.forecast_at),
        };
    }, [forecasts]);

    if (loading) {
        return (
            <div className="bg-black/60 border border-white/10 rounded-2xl p-4">
                <div className="text-white/80 text-xs tracking-wide mb-2">
                    Air Quality Advisory
                </div>
                <CardSkeleton lines={2} />
            </div>
        );
    }

    if (error) {
        return (
            <div className="bg-black/60 border border-white/10 rounded-2xl p-4">
                <div className="text-white/80 text-xs tracking-wide mb-2">
                    Air Quality Advisory
                </div>
                <div className="text-sm">
                    <div className="text-white/80 font-medium mb-1">
                        Couldn&apos;t load the advisory
                    </div>
                    <div className="text-white/50 text-xs">{error}</div>
                </div>
            </div>
        );
    }

    return (
        <div className="bg-black/60 border border-white/10 rounded-2xl p-4">
            <div className="text-white/80 text-xs tracking-wide mb-2">
                Air Quality Advisory
            </div>

            {advisory ? (
                <div className="text-white text-sm leading-relaxed">
                    AQI is expected to reach{" "}
                    <span style={{ color: advisory.band.color, fontWeight: 700 }}>
                        '{advisory.band.label}' ({advisory.value})
                    </span>{" "}
                    near <span style={{ fontWeight: 700 }}>{station.name}</span> by{" "}
                    <span style={{ fontWeight: 700 }}>{advisory.time}</span> —{" "}
                    {buildGuidanceClause(vulnerabilityFlags)}.
                </div>
            ) : (
                <div className="text-white/60 text-sm leading-relaxed">
                    No forecast available yet for <span style={{ fontWeight: 700 }}>{station.name}</span>.
                    Model will generate predictions on the next pipeline run.
                </div>
            )}
        </div>
    );
}
