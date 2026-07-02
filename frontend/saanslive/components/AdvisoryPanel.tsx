"use client";

import React, { useMemo } from "react";
import type { Forecast, Reading, Station } from "../lib/data";
import { getAqiBand } from "../lib/aqi";

export type AdvisoryPanelProps = {
    station: Station;
    forecasts: Forecast[];
    currentReading: Reading | null;
};

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
}: AdvisoryPanelProps) {
    const advisory = useMemo(() => {
        if (!forecasts || forecasts.length === 0) {
            return {
                category: "Unknown",
                value: 0,
                time: "—",
            };
        }

        // Peak predicted AQI in next 24h
        const peak = forecasts.reduce((acc, f) =>
            f.predicted_aqi > acc.predicted_aqi ? f : acc
        );

        const band = getAqiBand(peak.predicted_aqi);

        return {
            category: band.label,
            value: Math.round(peak.predicted_aqi),
            time: formatTime(peak.forecast_at),
        };
    }, [forecasts]);

    return (
        <div className="bg-black/60 border border-white/10 rounded-2xl p-4">
            <div className="text-white/80 text-xs tracking-wide mb-2">
                Air Quality Advisory
            </div>

            <div className="text-white text-sm leading-relaxed">
                AQI is expected to reach{" "}
                <span style={{ color: "#e8702a", fontWeight: 700 }}>
                    '{advisory.category}' ({advisory.value})
                </span>{" "}
                near <span style={{ fontWeight: 700 }}>{station.name}</span> by{" "}
                <span style={{ fontWeight: 700 }}>{advisory.time}</span> — limit outdoor
                activity for children and elderly residents.
            </div>
        </div>
    );
}
