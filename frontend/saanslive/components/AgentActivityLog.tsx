"use client";

import { useCallback, useEffect, useState } from "react";
import { getRecentAgentRuns } from "../lib/data";
import type { AgentRun } from "../lib/agent/types";
import { getAgentAdvisoryText } from "../lib/agent/advisoryText";
import { usePreferences } from "../lib/localPreferences";

function formatDate(iso: string) {
    return new Intl.DateTimeFormat("en-IN", {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
    }).format(new Date(iso));
}

function alertStyle(level: string) {
    if (level === "critical") return "border-red-400/30 bg-red-400/10 text-red-100";
    if (level === "high") return "border-orange-300/30 bg-orange-300/10 text-orange-100";
    return "border-amber-300/30 bg-amber-300/10 text-amber-100";
}

function compactData(data: Record<string, unknown>) {
    return Object.entries(data)
        .filter(([, value]) => typeof value !== "object" || value === null)
        .slice(0, 6)
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join(" · ");
}

export default function AgentActivityLog() {
    const [runs, setRuns] = useState<AgentRun[]>([]);
    const [loading, setLoading] = useState(true);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The agent is deliberately deterministic/LLM-free (see aqiAlertAgent.ts),
    // so advisories are stored in English. This displays the SAME alert
    // level in the viewer's own preferred language via a static translation
    // table -- see lib/agent/advisoryText.ts for why it's not a live
    // translation call.
    const { preferences } = usePreferences();

    const loadRuns = useCallback(async () => {
        setLoading(true);
        try {
            const latest = await getRecentAgentRuns(10);
            setRuns(latest);
            setError(null);
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "Could not load the agent log.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadRuns();
    }, [loadRuns]);

    async function runAgent() {
        setRunning(true);
        setError(null);
        try {
            const response = await fetch("/api/agent/run", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ trigger: "manual" }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || !payload.run) {
                throw new Error(payload.error || "The agent did not return a run record.");
            }
            setRuns((previous) => [payload.run as AgentRun, ...previous.filter((run) => run.id !== payload.run.id)].slice(0, 10));
        } catch (runError) {
            setError(runError instanceof Error ? runError.message : "Could not run the agent.");
        } finally {
            setRunning(false);
        }
    }

    return (
        <section className="bg-black/60 border border-white/10 rounded-2xl p-5">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                <div>
                    <p className="text-[11px] uppercase tracking-[0.16em] text-violet-200/90 font-semibold">
                        Civic AQI Alert Agent
                    </p>
                    <h2 className="mt-1 text-white text-xl font-semibold">Plan → decide → alert → self-review</h2>
                    <p className="mt-1 max-w-2xl text-white/55 text-sm leading-relaxed">
                        The agent inspects real station readings and forecasts, applies published thresholds, records every decision, then checks its previous alert against the next observed AQI.
                    </p>
                </div>
                <div className="flex gap-2 shrink-0">
                    <button
                        type="button"
                        onClick={() => void loadRuns()}
                        disabled={loading || running}
                        className="rounded-lg border border-white/15 px-3 py-2 text-xs text-white/70 hover:bg-white/10 disabled:opacity-40"
                    >
                        Refresh
                    </button>
                    <button
                        type="button"
                        onClick={() => void runAgent()}
                        disabled={running}
                        className="rounded-lg bg-[#e8702a] px-3 py-2 text-xs font-semibold text-white hover:bg-[#d2611f] disabled:cursor-wait disabled:opacity-60"
                    >
                        {running ? "Running agent…" : "Run Agent Now"}
                    </button>
                </div>
            </div>

            <div className="mt-4 rounded-xl border border-violet-300/15 bg-violet-300/[0.04] px-3 py-2 text-xs text-violet-100/75">
                Alert rule: fresh current AQI ≥ 101, or a fresh 6h forecast ≥ 151 that is at least 20 AQI points worse. No LLM chooses the threshold or invents data.
            </div>

            {error ? (
                <div className="mt-4 rounded-xl border border-red-400/25 bg-red-400/10 px-3 py-2 text-sm text-red-100">{error}</div>
            ) : null}

            {loading ? (
                <div className="mt-5 space-y-3 animate-pulse">
                    <div className="h-20 rounded-xl bg-white/5" />
                    <div className="h-20 rounded-xl bg-white/5" />
                </div>
            ) : runs.length === 0 ? (
                <div className="mt-5 rounded-xl border border-dashed border-white/15 px-5 py-10 text-center">
                    <p className="text-white/75 text-sm font-medium">No agent runs yet</p>
                    <p className="mt-1 text-white/45 text-xs">Use “Run Agent Now” to create the first auditable alert log.</p>
                </div>
            ) : (
                <div className="mt-5 space-y-3">
                    {runs.map((run) => (
                        <details key={run.id} className="group rounded-xl border border-white/10 bg-white/[0.025] overflow-hidden">
                            <summary className="cursor-pointer list-none px-4 py-3 hover:bg-white/[0.035]">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div>
                                        <p className="text-white text-sm font-medium">
                                            {run.flaggedStations.length > 0
                                                ? `${run.flaggedStations.length} station${run.flaggedStations.length === 1 ? "" : "s"} flagged`
                                                : "No stations met the alert threshold"}
                                        </p>
                                        <p className="mt-0.5 text-white/45 text-xs">
                                            {formatDate(run.createdAt)} · {run.trigger === "scheduled" ? "scheduled" : "manual"} run
                                        </p>
                                    </div>
                                    <span className="text-xs text-violet-200/80 group-open:hidden">View reasoning</span>
                                    <span className="hidden text-xs text-violet-200/80 group-open:inline">Hide reasoning</span>
                                </div>
                            </summary>

                            <div className="border-t border-white/10 px-4 py-4 space-y-4">
                                <div>
                                    <h3 className="text-[11px] uppercase tracking-[0.14em] text-white/45">Reasoning trace</h3>
                                    <ol className="mt-2 space-y-2 border-l border-violet-300/20 pl-3">
                                        {run.reasoningSteps.map((step, index) => (
                                            <li key={`${run.id}-${step.step}-${index}`} className="relative">
                                                <span className="absolute -left-[17px] top-1.5 h-2 w-2 rounded-full bg-violet-300" />
                                                <p className="text-white/80 text-sm"><span className="font-medium capitalize">{step.step.replace("_", " ")}:</span> {step.description}</p>
                                                {compactData(step.data) ? <p className="mt-0.5 text-white/40 text-xs">{compactData(step.data)}</p> : null}
                                            </li>
                                        ))}
                                    </ol>
                                </div>

                                <div>
                                    <h3 className="text-[11px] uppercase tracking-[0.14em] text-white/45">Flagged stations</h3>
                                    {run.flaggedStations.length === 0 ? (
                                        <p className="mt-2 text-sm text-white/50">No active alert for this run.</p>
                                    ) : (
                                        <div className="mt-2 grid grid-cols-1 lg:grid-cols-2 gap-2">
                                            {run.flaggedStations.map((flag) => (
                                                <div key={flag.stationId} className={`rounded-lg border px-3 py-3 ${alertStyle(flag.alertLevel)}`}>
                                                    <div className="flex items-start justify-between gap-2">
                                                        <p className="text-sm font-medium">{flag.city} · {flag.stationName}</p>
                                                        <span className="text-[10px] uppercase tracking-wider">{flag.alertLevel}</span>
                                                    </div>
                                                    <p className="mt-1 text-xs opacity-85">Current: {flag.currentAqi ?? "—"} · 6h forecast: {flag.forecastAqi ?? "—"}</p>
                                                    <p className="mt-2 text-xs leading-relaxed opacity-80">{flag.reason}</p>
                                                    {run.advisories[flag.stationId] ? (
                                                        <p className="mt-2 text-xs font-medium">
                                                            {getAgentAdvisoryText(flag.alertLevel, preferences.preferred_language)}
                                                        </p>
                                                    ) : null}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                {run.selfReview ? (
                                    <div className="rounded-lg border border-emerald-300/20 bg-emerald-300/[0.05] px-3 py-3">
                                        <h3 className="text-[11px] uppercase tracking-[0.14em] text-emerald-200/80">Previous-run self-review</h3>
                                        <p className="mt-1 text-sm text-white/80">
                                            Confirmed: {run.selfReview.summary.confirmed} · False alarms: {run.selfReview.summary.falseAlarms} · Missing data: {run.selfReview.summary.unavailable}
                                        </p>
                                    </div>
                                ) : null}
                            </div>
                        </details>
                    ))}
                </div>
            )}
        </section>
    );
}
