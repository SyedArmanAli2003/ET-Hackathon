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

export type ForecastChartProps = {
    forecasts: Forecast[];
    currentAqi: number | null;
};

type SeverityBand = {
    min: number;
    max: number; // inclusive upper bound, or Infinity
    color: string;
};

const AQI_SEVERITY_BANDS: SeverityBand[] = [
    { min: 0, max: 50, color: "rgba(46,125,50,0.12)" }, // green
    { min: 51, max: 100, color: "rgba(242,201,76,0.16)" }, // yellow
    { min: 101, max: 150, color: "rgba(242,153,74,0.18)" }, // orange
    { min: 151, max: 200, color: "rgba(235,87,87,0.18)" }, // red
    { min: 201, max: 300, color: "rgba(155,81,224,0.18)" }, // purple
    { min: 301, max: Infinity, color: "rgba(107,27,36,0.18)" }, // maroon
];

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
                                fill={b.color}
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
        </div>
    );
}
