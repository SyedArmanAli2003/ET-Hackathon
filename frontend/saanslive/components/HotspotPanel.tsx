"use client";

/**
 * HotspotPanel.tsx — "Hotspot Prioritization" dashboard section.
 *
 * Ranks every station across every city by how urgently it warrants
 * attention, using ONLY real numbers already in the readings table:
 *   1. Current AQI severity (higher = more urgent)
 *   2. 7-day trend: this week's average AQI vs last week's average
 *
 * Both components are shown separately alongside the combined priority
 * score so the ranking is auditable, not a mystery number. See
 * lib/data.ts → getHotspotRanking() for the scoring logic itself.
 *
 * This panel intentionally does NOT claim anything about registered
 * pollution sources / emitters — that data doesn't exist in this schema.
 * The disclaimer below is load-bearing, not decorative.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, TrendingDown, TrendingUp } from "lucide-react";

import type { HotspotRankingEntry } from "../lib/data";
import { getHotspotRanking } from "../lib/data";
import { getAqiBand } from "../lib/aqi";
import { CardSkeleton } from "./Skeleton";

function formatPct(pct: number | null): string {
  if (pct == null) return "—";
  const rounded = Math.round(Math.abs(pct) * 10) / 10;
  return `${pct >= 0 ? "+" : "-"}${rounded}%`;
}

function TrendBadge({ entry }: { entry: HotspotRankingEntry }) {
  if (entry.trendDirection === "unknown") {
    return <span className="text-white/40 text-xs">— no prior week data</span>;
  }

  if (entry.trendDirection === "worsening") {
    return (
      <span className="inline-flex items-center gap-1 text-red-400 text-xs font-medium">
        <TrendingUp size={14} /> {formatPct(entry.trendChangePct)}
      </span>
    );
  }

  if (entry.trendDirection === "improving") {
    return (
      <span className="inline-flex items-center gap-1 text-green-400 text-xs font-medium">
        <TrendingDown size={14} /> {formatPct(entry.trendChangePct)}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 text-white/50 text-xs font-medium">
      → {formatPct(entry.trendChangePct)}
    </span>
  );
}

export default function HotspotPanel() {
  const [entries, setEntries] = useState<HotspotRankingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const ranked = await getHotspotRanking();
        if (cancelled) return;
        setEntries(ranked);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load the hotspot ranking.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  const disclaimer = (
    <div className="flex items-start gap-2 text-amber-300/90 text-xs bg-amber-500/10 border border-amber-500/25 rounded-xl px-3 py-2 mb-4">
      <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
      <span>
        Ranked by observed AQI severity and trend — not by registered pollution source
        data, which is not yet available.
      </span>
    </div>
  );

  if (loading) {
    return (
      <div className="bg-black/60 border border-white/10 rounded-2xl p-4">
        <h2 className="text-white font-semibold mb-3">Hotspot Prioritization</h2>
        {disclaimer}
        <CardSkeleton lines={6} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-black/60 border border-white/10 rounded-2xl p-4">
        <h2 className="text-white font-semibold mb-3">Hotspot Prioritization</h2>
        {disclaimer}
        <div className="text-sm">
          <div className="text-white/80 font-medium mb-1">Couldn&apos;t load the ranking</div>
          <div className="text-white/50 text-xs">{error}</div>
        </div>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="bg-black/60 border border-white/10 rounded-2xl p-4">
        <h2 className="text-white font-semibold mb-3">Hotspot Prioritization</h2>
        {disclaimer}
        <div className="text-white/60 text-sm">No stations available yet.</div>
      </div>
    );
  }

  return (
    <div className="bg-black/60 border border-white/10 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-white font-semibold">Hotspot Prioritization</h2>
        <div className="text-white/40 text-xs">{entries.length} stations ranked</div>
      </div>

      {disclaimer}

      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-white/50 text-xs uppercase tracking-wide border-b border-white/10">
              <th className="text-left py-2 pr-3 font-medium">#</th>
              <th className="text-left py-2 pr-3 font-medium">Station</th>
              <th className="text-left py-2 pr-3 font-medium">City</th>
              <th className="text-right py-2 pr-3 font-medium">Current AQI</th>
              <th className="text-right py-2 pr-3 font-medium">7-day trend</th>
              <th className="text-right py-2 pr-3 font-medium">AQI score</th>
              <th className="text-right py-2 pr-3 font-medium">Trend score</th>
              <th className="text-right py-2 pl-3 font-medium">Priority</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, idx) => {
              const band = entry.currentAqi != null ? getAqiBand(entry.currentAqi) : null;
              const isTopFive = idx < 5 && entry.currentAqi != null;

              return (
                <tr
                  key={entry.station.id}
                  className={[
                    "border-b border-white/5 hover:bg-white/5 transition-colors",
                    isTopFive ? "bg-red-500/5" : "",
                  ].join(" ")}
                >
                  <td className="py-2 pr-3 text-white/60 font-mono">{idx + 1}</td>
                  <td className="py-2 pr-3 text-white font-medium whitespace-nowrap">
                    {entry.station.name}
                  </td>
                  <td className="py-2 pr-3 text-white/70 whitespace-nowrap">{entry.station.city}</td>
                  <td className="py-2 pr-3 text-right">
                    {entry.currentAqi != null ? (
                      <span
                        className="font-semibold"
                        style={{ color: band?.color ?? "#fff" }}
                      >
                        {Math.round(entry.currentAqi)}
                      </span>
                    ) : (
                      <span className="text-white/30">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <TrendBadge entry={entry} />
                  </td>
                  <td className="py-2 pr-3 text-right text-white/60 font-mono text-xs">
                    {(entry.aqiComponent * 100).toFixed(0)}
                  </td>
                  <td className="py-2 pr-3 text-right text-white/60 font-mono text-xs">
                    {(entry.trendComponent * 100).toFixed(0)}
                  </td>
                  <td className="py-2 pl-3 text-right">
                    <span className="text-white font-bold">
                      {entry.priorityScore.toFixed(1)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 text-white/30 text-[10px]">
        Priority score = (current AQI ÷ 500) × 0.6 + (7-day % change, clamped ±100%) × 0.4, on a 0–100 scale.
        Top of the list = highest priority for intervention.
      </div>
    </div>
  );
}
