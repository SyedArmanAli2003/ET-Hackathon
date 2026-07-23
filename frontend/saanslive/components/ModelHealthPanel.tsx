"use client";

/**
 * ModelHealthPanel.tsx — read-only summary of real forecast accuracy,
 * per city, vs. the persistence ("assume no change") baseline.
 *
 * Data comes from public.model_evals, populated by model/eval_agent.py
 * (run in CI after each ingestion cycle — see .github/workflows/ingest.yml).
 * This turns the honesty-first "we report our model's real performance"
 * ethos already in train.py's per-city console table into an always-visible,
 * ongoing surface, not just a one-off training-run log.
 *
 * Same RLS posture as the other public sensor tables: public-read via the
 * anon key, writes restricted to service_role.
 */

import { useEffect, useState } from "react";
import { getModelHealthSummary, type ModelHealthSummary } from "../lib/data";
import { CardSkeleton } from "./Skeleton";

export default function ModelHealthPanel() {
    const [summaries, setSummaries] = useState<ModelHealthSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            setLoading(true);
            setError(null);
            try {
                const data = await getModelHealthSummary();
                if (!cancelled) setSummaries(data);
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load model health.");
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        load();
        return () => {
            cancelled = true;
        };
    }, []);

    if (loading) {
        return (
            <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                <div className="text-white/60 text-xs uppercase tracking-wide mb-3">Model health</div>
                <CardSkeleton lines={4} />
            </div>
        );
    }

    if (error) {
        return (
            <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                <div className="text-white/60 text-xs uppercase tracking-wide mb-2">Model health</div>
                <div className="text-white/50 text-sm">{error}</div>
            </div>
        );
    }

    if (summaries.length === 0) {
        return (
            <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                <div className="text-white/60 text-xs uppercase tracking-wide mb-2">Model health</div>
                <div className="text-white/50 text-sm">
                    No forecasts have been evaluated against real outcomes yet.
                </div>
            </div>
        );
    }

    return (
        <div className="bg-white/5 border border-white/10 rounded-xl p-4">
            <div className="text-white/60 text-xs uppercase tracking-wide mb-1">Model health</div>
            <p className="text-white/40 text-xs mb-3 leading-relaxed">
                Real forecast error vs. a &quot;no change&quot; persistence baseline, evaluated once each
                forecast&apos;s target time has passed. Not every city beats the baseline yet — shown
                honestly either way.
            </p>
            <div className="overflow-x-auto">
                <table className="w-full text-xs">
                    <thead>
                        <tr className="text-white/40 uppercase tracking-wide text-[10px] border-b border-white/10">
                            <th className="text-left py-1.5 pr-3">City</th>
                            <th className="text-right py-1.5 pr-3">Evals</th>
                            <th className="text-right py-1.5 pr-3">Model err.</th>
                            <th className="text-right py-1.5 pr-3">Baseline err.</th>
                            <th className="text-right py-1.5">Win rate</th>
                        </tr>
                    </thead>
                    <tbody>
                        {summaries.map((s) => (
                            <tr key={s.city} className="border-b border-white/5 last:border-0">
                                <td className="py-1.5 pr-3 text-white/90">{s.city}</td>
                                <td className="py-1.5 pr-3 text-right text-white/60">{s.evalCount}</td>
                                <td className="py-1.5 pr-3 text-right text-white/60">{s.medianModelError}</td>
                                <td className="py-1.5 pr-3 text-right text-white/60">{s.medianBaselineError}</td>
                                <td
                                    className="py-1.5 text-right font-medium"
                                    style={{ color: s.modelWinRatePct >= 50 ? "#2e7d32" : "#eb5757" }}
                                >
                                    {s.modelWinRatePct}%
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
