"use client";

import React, { useMemo } from "react";
import {
    CartesianGrid,
    Line,
    LineChart,
    ReferenceArea,
    ReferenceLine,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import type { Forecast } from "../lib/data";
import { AQI_SEVERITY_BANDS } from "../lib/aqi";
import { Skeleton } from "./Skeleton";

export type ForecastChartProps = {
    forecasts: Forecast[];
    currentAqi: number | null;
    loading?: boolean;
    error?: string | null;
};

function clampFinite(max: number) {
    return Number.isFinite(max) ? max : 400;
}

function formatTimeLabel(iso: string) {
    const d = new Date(iso);
    const hours = d.getHours();
    const minutes = d.getMinutes();
    const ampm = hours >= 12 ? "pm" : "am";
    const h12 = hours % 12 === 0 ? 12 : hours % 12;
    const mm = minutes.toString().padStart(2, "0");
    return minutes === 0 ? `${h12}${ampm}` : `${h12}:${mm}${ampm}`;
}

export default function ForecastChart({
    forecasts,
    currentAqi,
    loading = false,
    error = null,
}: ForecastChartProps) {
    const chartData = useMemo(() => {
        const sorted = [...forecasts].sort(
            (a, b) => new Date(a.forecast_at).getTime() - new Date(b.forecast_at).getTime()
        );

        return sorted.map((f) => ({
            forecast_at: f.forecast_at,
            timeLabel: formatTimeLabel(f.forecast_at),
            predicted_aqi: f.predicted_aqi,
            baseline_aqi: currentAqi ?? null,
        }));
    }, [forecasts, currentAqi]);

    const xDomain: [number, number] = useMemo(() => {
        if (chartData.length === 0) return [0, 1];
        return [0, chartData.length - 1];
    }, [chartData]);

    const yDomain: [number, number] = useMemo(() => {
        const values = chartData.map((d) => d.predicted_aqi);
        const maxPred = values.length ? Math.max(...values) : 100;
        const max = Math.max(200, Math.ceil(maxPred / 50) * 50);
        return [0, Math.max(300, max)];
    }, [chartData]);

    const bandAreas = useMemo(() => {
        return AQI_SEVERITY_BANDS.map((b) => ({
            ...b,
            max: b.max === Infinity ? yDomain[1] : b.max,
        }));
    }, [yDomain]);

    if (loading) {
        return (
            <div className="bg-black/60 border border-white/10 rounded-2xl p-4">
                <div className="flex items-center justify-between mb-2">
                    <Skeleton className="h-5 w-40" />
                    <Skeleton className="h-4 w-24" />
                </div>
                <Skeleton className="w-full" style={{ height: 320 }} />
            </div>
        );
    }

    if (error) {
        return (
            <div className="bg-black/60 border border-white/10 rounded-2xl p-4">
                <h2 className="text-white font-semibold mb-2">Next 24h AQI Forecast</h2>
                <div
                    style={{ height: 320 }}
                    className="flex flex-col items-center justify-center gap-2 text-center px-6"
                >
                    <div className="text-white/80 text-sm font-medium">
                        Couldn&apos;t load the forecast
                    </div>
                    <div className="text-white/50 text-xs">{error}</div>
                </div>
            </div>
        );
    }

    return (
        <div className="bg-black/60 border border-white/10 rounded-2xl p-4">
            <div className="flex items-center justify-between mb-2">
                <h2 className="text-white font-semibold">Next 24h AQI Forecast</h2>
                {currentAqi !== null ? (
                    <div className="text-white/70 text-xs">
                        Current AQI: <span className="text-white">{currentAqi}</span>
                    </div>
                ) : (
                    <div className="text-white/70 text-xs">Current AQI unavailable</div>
                )}
            </div>

            {chartData.length === 0 ? (
                <div
                    style={{ height: 320 }}
                    className="flex flex-col items-center justify-center gap-1 text-center px-6"
                >
                    <div className="text-white/70 text-sm font-medium">
                        No forecast available yet
                    </div>
                    <div className="text-white/50 text-xs">
                        The model hasn&apos;t generated a prediction for this station yet.
                    </div>
                </div>
            ) : (
            <div style={{ width: "100%", height: 320 }}>
                <ResponsiveContainer>
                    <LineChart
                        data={chartData.map((d, idx) => ({ ...d, x: idx }))}
                        margin={{ top: 10, right: 14, bottom: 10, left: 0 }}
                    >
                        <CartesianGrid stroke="rgba(255,255,255,0.12)" />

                        {bandAreas.map((b, i) => (
                            <ReferenceArea
                                key={i}
                                x1={xDomain[0]}
                                x2={xDomain[1]}
                                y1={b.min}
                                y2={clampFinite(b.max)}
                                fill={b.areaColor}
                                strokeOpacity={0}
                            />
                        ))}

                        {currentAqi !== null ? (
                            <ReferenceLine
                                y={currentAqi}
                                stroke="rgba(255,255,255,0.7)"
                                strokeDasharray="6 6"
                                label={{
                                    value: "Persistence",
                                    position: "insideTop",
                                    fill: "rgba(255,255,255,0.8)",
                                    fontSize: 12,
                                }}
                            />
                        ) : null}

                        <XAxis
                            dataKey="timeLabel"
                            tick={{ fill: "rgba(255,255,255,0.7)", fontSize: 12 }}
                            axisLine={{ stroke: "rgba(255,255,255,0.2)" }}
                            tickLine={{ stroke: "rgba(255,255,255,0.2)" }}
                            interval="preserveStartEnd"
                        />
                        <YAxis
                            domain={yDomain}
                            tick={{ fill: "rgba(255,255,255,0.7)", fontSize: 12 }}
                            axisLine={{ stroke: "rgba(255,255,255,0.2)" }}
                            tickLine={{ stroke: "rgba(255,255,255,0.2)" }}
                            allowDecimals={false}
                        />

                        <Tooltip
                            contentStyle={{
                                background: "rgba(0,0,0,0.8)",
                                border: "1px solid rgba(255,255,255,0.15)",
                                borderRadius: 12,
                            }}
                            labelStyle={{ color: "white" }}
                            formatter={(value: any) => [`${value}`, "AQI"]}
                        />

                        <Line
                            type="monotone"
                            dataKey="predicted_aqi"
                            stroke="#e8702a"
                            strokeWidth={2.5}
                            dot={false}
                            name="Predicted AQI"
                        />

                        {currentAqi !== null ? (
                            <Line
                                type="monotone"
                                dataKey="baseline_aqi"
                                stroke="rgba(255,255,255,0.75)"
                                strokeWidth={2}
                                dot={false}
                                strokeDasharray="6 6"
                                name="Persistence baseline"
                            />
                        ) : null}
                    </LineChart>
                </ResponsiveContainer>
            </div>
            )}
        </div>
    );
}
