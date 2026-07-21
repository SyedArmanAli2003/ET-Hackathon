"use client";

/**
 * CityComparisonView.tsx — "Compare Cities" dashboard section.
 *
 * Shows current AQI vs next-24h forecast AQI side-by-side for every city
 * with at least one monitored station, so a user can see the national
 * picture at a glance instead of one city at a time.
 *
 * Data comes entirely from lib/data.ts → getCityComparison(), which
 * aggregates real readings/forecasts — nothing here is fabricated. Cities
 * where no station has a trained model yet show "Forecast pending" rather
 * than a blank cell or a guessed number.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { CityComparisonEntry } from "../lib/data";
import { getCityComparison } from "../lib/data";
import { getAqiBand } from "../lib/aqi";
import { CardSkeleton } from "./Skeleton";

type SortKey = "city" | "currentAqi" | "forecastAqi" | "delta";
type SortDirection = "asc" | "desc";
type ViewMode = "table" | "chart";

function formatAqi(value: number | null): string {
  return value == null ? "—" : Math.round(value).toString();
}

function formatDelta(delta: number | null): string {
  if (delta == null) return "—";
  const rounded = Math.round(Math.abs(delta));
  if (rounded === 0) return "±0";
  return `${delta > 0 ? "+" : "-"}${rounded}`;
}

export default function CityComparisonView() {
  const [entries, setEntries] = useState<CityComparisonEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("currentAqi");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [viewMode, setViewMode] = useState<ViewMode>("table");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const comparison = await getCityComparison();
        if (cancelled) return;
        setEntries(comparison);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load the city comparison.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  const sortedEntries = useMemo(() => {
    const withRank = [...entries];
    withRank.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "city") {
        cmp = a.city.localeCompare(b.city);
      } else {
        // Nulls (no data) always sort to the bottom regardless of direction,
        // so "no forecast yet" doesn't get mixed in with real ordered values.
        const av = a[sortKey];
        const bv = b[sortKey];
        if (av == null && bv == null) cmp = 0;
        else if (av == null) return 1;
        else if (bv == null) return -1;
        else cmp = av - bv;
      }
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return withRank;
  }, [entries, sortKey, sortDirection]);

  const chartData = useMemo(
    () =>
      sortedEntries.map((e) => ({
        city: e.city,
        "Current AQI": e.currentAqi != null ? Math.round(e.currentAqi) : null,
        "Forecast AQI (24h avg)": e.forecastAqi != null ? Math.round(e.forecastAqi) : null,
      })),
    [sortedEntries]
  );

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDirection("desc");
    }
  }

  function SortHeader({ label, sortKeyForHeader }: { label: string; sortKeyForHeader: SortKey }) {
    const active = sortKey === sortKeyForHeader;
    return (
      <button
        onClick={() => toggleSort(sortKeyForHeader)}
        className={[
          "flex items-center gap-1 hover:text-white transition-colors",
          active ? "text-white" : "text-white/50",
        ].join(" ")}
      >
        {label}
        {active ? <span className="text-[10px]">{sortDirection === "asc" ? "▲" : "▼"}</span> : null}
      </button>
    );
  }

  const header = (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-white font-semibold">Compare Cities</h2>
      <div className="flex items-center gap-2">
        {entries.length > 0 ? (
          <div className="text-white/40 text-xs mr-1">{entries.length} cities</div>
        ) : null}
        <div className="flex bg-white/5 border border-white/10 rounded-full p-0.5">
          {(["table", "chart"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className={[
                "px-3 py-1 rounded-full text-xs font-medium transition-colors capitalize",
                viewMode === mode ? "bg-white/20 text-white" : "text-white/50 hover:text-white/80",
              ].join(" ")}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="bg-black/60 border border-white/10 rounded-2xl p-4">
        {header}
        <CardSkeleton lines={6} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-black/60 border border-white/10 rounded-2xl p-4">
        {header}
        <div className="text-sm">
          <div className="text-white/80 font-medium mb-1">Couldn&apos;t load the comparison</div>
          <div className="text-white/50 text-xs">{error}</div>
        </div>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="bg-black/60 border border-white/10 rounded-2xl p-4">
        {header}
        <div className="text-white/60 text-sm">No cities available yet.</div>
      </div>
    );
  }

  return (
    <div className="bg-black/60 border border-white/10 rounded-2xl p-4">
      {header}

      {viewMode === "chart" ? (
        <div style={{ width: "100%", height: 420 }}>
          <ResponsiveContainer>
            <BarChart data={chartData} margin={{ top: 10, right: 14, bottom: 40, left: 0 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.1)" vertical={false} />
              <XAxis
                dataKey="city"
                tick={{ fill: "rgba(255,255,255,0.7)", fontSize: 11 }}
                axisLine={{ stroke: "rgba(255,255,255,0.2)" }}
                tickLine={{ stroke: "rgba(255,255,255,0.2)" }}
                angle={-35}
                textAnchor="end"
                interval={0}
                height={70}
              />
              <YAxis
                tick={{ fill: "rgba(255,255,255,0.7)", fontSize: 12 }}
                axisLine={{ stroke: "rgba(255,255,255,0.2)" }}
                tickLine={{ stroke: "rgba(255,255,255,0.2)" }}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={{
                  background: "rgba(0,0,0,0.85)",
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderRadius: 12,
                }}
                labelStyle={{ color: "white" }}
                formatter={(value: unknown) => (value == null ? "Forecast pending" : `${value}`)}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: "rgba(255,255,255,0.7)" }} />
              <Bar dataKey="Current AQI" fill="#e8702a" radius={[4, 4, 0, 0]} />
              <Bar dataKey="Forecast AQI (24h avg)" fill="#4dabf7" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-xs uppercase tracking-wide border-b border-white/10">
                <th className="text-left py-2 pr-3 font-medium">
                  <SortHeader label="City" sortKeyForHeader="city" />
                </th>
                <th className="text-right py-2 pr-3 font-medium">
                  <SortHeader label="Current AQI" sortKeyForHeader="currentAqi" />
                </th>
                <th className="text-right py-2 pr-3 font-medium">
                  <SortHeader label="24h Forecast" sortKeyForHeader="forecastAqi" />
                </th>
                <th className="text-right py-2 pl-3 font-medium">
                  <SortHeader label="Δ Delta" sortKeyForHeader="delta" />
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedEntries.map((entry) => {
                const currentBand = entry.currentAqi != null ? getAqiBand(entry.currentAqi) : null;
                const forecastBand = entry.forecastAqi != null ? getAqiBand(entry.forecastAqi) : null;
                const forecastPending = entry.stationsWithForecast === 0;

                return (
                  <tr key={entry.city} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                    <td className="py-2 pr-3 text-white font-medium whitespace-nowrap">{entry.city}</td>
                    <td className="py-2 pr-3 text-right">
                      {entry.currentAqi != null ? (
                        <span className="font-semibold" style={{ color: currentBand?.color ?? "#fff" }}>
                          {formatAqi(entry.currentAqi)}
                        </span>
                      ) : (
                        <span className="text-white/30">—</span>
                      )}
                      <span className="text-white/30 text-[10px] ml-1">
                        ({entry.stationsWithReading}/{entry.totalStations})
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-right">
                      {forecastPending ? (
                        <span className="text-white/40 text-xs italic">Forecast pending</span>
                      ) : (
                        <>
                          <span className="font-semibold" style={{ color: forecastBand?.color ?? "#fff" }}>
                            {formatAqi(entry.forecastAqi)}
                          </span>
                          <span className="text-white/30 text-[10px] ml-1">
                            ({entry.stationsWithForecast}/{entry.totalStations})
                          </span>
                        </>
                      )}
                    </td>
                    <td className="py-2 pl-3 text-right">
                      {entry.delta != null ? (
                        <span
                          className={[
                            "font-mono text-xs font-medium",
                            entry.delta > 0 ? "text-red-400" : entry.delta < 0 ? "text-green-400" : "text-white/50",
                          ].join(" ")}
                        >
                          {formatDelta(entry.delta)}
                        </span>
                      ) : (
                        <span className="text-white/30 text-xs">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 text-white/30 text-[10px]">
        Current AQI and forecast are averaged across all of a city&apos;s monitored stations that have
        data. &quot;Forecast pending&quot; means no station in that city has a trained model forecast yet —
        never a placeholder number.
      </div>
    </div>
  );
}
