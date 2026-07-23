"use client";

import { useMemo, useState } from "react";
import type { Forecast, Reading, Station } from "../lib/data";
import {
    buildAirPlan,
    PLAN_ACTIVITIES,
    type PlanActivity,
} from "../lib/airPlan";
import { getAqiBand } from "../lib/aqi";

type AirPlanPanelProps = {
    station: Station | null;
    currentReading: Reading | null;
    forecasts: Forecast[];
    vulnerabilityFlags?: string[];
    loading?: boolean;
};

const RISK_STYLES = {
    lower: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
    elevated: "border-amber-300/30 bg-amber-300/10 text-amber-100",
    high: "border-orange-400/30 bg-orange-400/10 text-orange-100",
    very_high: "border-red-400/30 bg-red-400/10 text-red-100",
} as const;

function formatTime(iso: string) {
    const date = new Date(iso);
    return new Intl.DateTimeFormat("en-IN", {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
    }).format(date);
}

function riskLabel(risk: keyof typeof RISK_STYLES) {
    return risk === "very_high" ? "Very high" : `${risk[0].toUpperCase()}${risk.slice(1)}`;
}

export default function AirPlanPanel({
    station,
    currentReading,
    forecasts,
    vulnerabilityFlags = [],
    loading = false,
}: AirPlanPanelProps) {
    const [activity, setActivity] = useState<PlanActivity>("commute");
    const [copied, setCopied] = useState(false);

    const plan = useMemo(
        () => buildAirPlan({ activity, currentReading, forecasts, vulnerabilityFlags }),
        [activity, currentReading, forecasts, vulnerabilityFlags]
    );

    async function copyPlan() {
        if (!station || typeof navigator === "undefined" || !navigator.clipboard) return;

        const bestWindow = plan.bestWindow
            ? `${formatTime(plan.bestWindow.forecastAt)} (AQI ${plan.bestWindow.aqi})`
            : "not available";
        const text = [
            `SaanSLive air action plan for ${station.name}, ${station.city}`,
            `${plan.activityLabel}: ${plan.recommendation}`,
            `Best available window: ${bestWindow}.`,
            plan.practicalStep,
            "Based on the latest available station reading and model forecast; not medical advice.",
        ].join("\n");

        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1800);
        } catch {
            setCopied(false);
        }
    }

    if (loading) {
        return (
            <section className="bg-black/60 border border-white/10 rounded-2xl p-5 animate-pulse">
                <div className="h-5 w-44 rounded bg-white/10" />
                <div className="mt-4 h-10 rounded-xl bg-white/5" />
                <div className="mt-4 h-24 rounded-xl bg-white/5" />
            </section>
        );
    }

    return (
        <section className="bg-black/60 border border-white/10 rounded-2xl p-5">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <p className="text-[11px] uppercase tracking-[0.16em] text-[#f39a62] font-semibold">
                        Personal air action plan
                    </p>
                    <h2 className="mt-1 text-white font-semibold text-lg">Plan your next 6 hours</h2>
                    <p className="mt-1 text-white/50 text-xs">
                        {station ? `Using ${station.name}, ${station.city}` : "Choose a station to personalize this plan."}
                    </p>
                </div>
                <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${RISK_STYLES[plan.risk]}`}>
                    {riskLabel(plan.risk)} exposure risk
                </span>
            </div>

            <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2" aria-label="Choose an activity">
                {PLAN_ACTIVITIES.map((item) => {
                    const selected = item.id === activity;
                    return (
                        <button
                            key={item.id}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => setActivity(item.id)}
                            className={[
                                "rounded-xl border px-2 py-2 text-xs transition-colors",
                                selected
                                    ? "border-[#e8702a]/70 bg-[#e8702a]/15 text-white"
                                    : "border-white/10 bg-white/[0.03] text-white/60 hover:bg-white/[0.08] hover:text-white",
                            ].join(" ")}
                        >
                            {item.shortLabel}
                        </button>
                    );
                })}
            </div>

            {station && (currentReading || forecasts.length > 0) ? (
                <>
                    <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.035] p-4">
                        <p className="text-white text-sm leading-relaxed">{plan.recommendation}</p>

                        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="rounded-lg bg-black/30 px-3 py-2.5">
                                <p className="text-[10px] uppercase tracking-widest text-white/40">Best available window</p>
                                {plan.bestWindow ? (
                                    <>
                                        <p className="mt-1 text-white text-sm font-medium">{formatTime(plan.bestWindow.forecastAt)}</p>
                                        <p className="mt-0.5 text-xs" style={{ color: getAqiBand(plan.bestWindow.aqi).color }}>
                                            AQI {plan.bestWindow.aqi} · {getAqiBand(plan.bestWindow.aqi).label}
                                        </p>
                                    </>
                                ) : (
                                    <p className="mt-1 text-white/50 text-sm">Use the latest station reading</p>
                                )}
                            </div>
                            <div className="rounded-lg bg-black/30 px-3 py-2.5">
                                <p className="text-[10px] uppercase tracking-widest text-white/40">Practical step</p>
                                <p className="mt-1 text-white/70 text-xs leading-relaxed">{plan.practicalStep}</p>
                            </div>
                        </div>
                    </div>

                    <div className="mt-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs">
                        <p className="text-white/40 leading-relaxed">
                            {plan.explanation} This is a planning aid, not medical advice.
                        </p>
                        <button
                            type="button"
                            onClick={copyPlan}
                            className="shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-white/70 hover:bg-white/10 hover:text-white transition-colors"
                        >
                            {copied ? "Copied plan" : "Copy plan"}
                        </button>
                    </div>
                </>
            ) : (
                <div className="mt-4 rounded-xl border border-dashed border-white/15 px-4 py-7 text-center text-sm text-white/50">
                    The action plan needs a current station reading or a generated forecast.
                </div>
            )}
        </section>
    );
}
