"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";

import type { Forecast, Reading, Station } from "../../lib/data";
import {
    getCurrentReading,
    getLatestForecasts,
    getStations,
} from "../../lib/data";

const StationMap = dynamic(
    () => import("../../components/StationMap"),
    { ssr: false }
);

import ForecastChart from "../../components/ForecastChart";
import AdvisoryPanel from "../../components/AdvisoryPanel";
import OnboardingModal from "../../components/OnboardingModal";
import { usePreferences } from "../../lib/localPreferences";

const darkBgCard =
    "bg-black/70 border border-white/10 rounded-2xl p-4 backdrop-blur-md";

export default function DashboardPage() {
    const [stations, setStations] = useState<Station[]>([]);
    const [selectedStationId, setSelectedStationId] = useState<string | null>(
        null
    );

    const [currentReading, setCurrentReading] = useState<Reading | null>(null);
    const [forecasts, setForecasts] = useState<Forecast[]>([]);
    const [loading, setLoading] = useState(true);
    const [stationsError, setStationsError] = useState<string | null>(null);
    const [stationDataLoading, setStationDataLoading] = useState(true);
    const [stationDataError, setStationDataError] = useState<string | null>(null);
    const { preferences } = usePreferences();

    useEffect(() => {
        let cancelled = false;

        async function loadStations() {
            setLoading(true);
            setStationsError(null);
            try {
                const s = await getStations();
                if (cancelled) return;
                setStations(s);
                if (s.length > 0 && !selectedStationId) {
                    setSelectedStationId(s[0].id);
                }
            } catch (err) {
                if (cancelled) return;
                setStationsError(
                    err instanceof Error ? err.message : "Failed to load stations."
                );
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        loadStations();

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!selectedStationId) return;

        const stationId: string = selectedStationId;

        let cancelled = false;

        async function loadStationData() {
            setLoading(true);
            setStationDataLoading(true);
            setStationDataError(null);
            try {
                const [r, f] = await Promise.all([
                    getCurrentReading(stationId),
                    getLatestForecasts(stationId),
                ]);
                if (cancelled) return;
                setCurrentReading(r);
                setForecasts(f);
            } catch (err) {
                if (cancelled) return;
                setStationDataError(
                    err instanceof Error ? err.message : "Failed to load station data."
                );
                setForecasts([]);
                setCurrentReading(null);
            } finally {
                if (!cancelled) {
                    setLoading(false);
                    setStationDataLoading(false);
                }
            }
        }

        loadStationData();

        return () => {
            cancelled = true;
        };
    }, [selectedStationId]);

    const selectedStation = useMemo(() => {
        return (
            stations.find((s) => s.id === selectedStationId) ?? null
        );
    }, [stations, selectedStationId]);

    const cities = useMemo(() => {
        const set = new Set<string>();
        stations.forEach((s) => set.add(s.city));
        return Array.from(set);
    }, [stations]);

    const stationsByCity = useMemo(() => {
        const map: Record<string, Station[]> = {};
        stations.forEach((s) => {
            if (!map[s.city]) map[s.city] = [];
            map[s.city].push(s);
        });
        return map;
    }, [stations]);

    const selectedCity = useMemo(() => {
        if (!selectedStation) return null;
        return selectedStation.city;
    }, [selectedStation]);

    const onSelectCity = (city: string) => {
        const list = stationsByCity[city] ?? [];
        if (list.length === 0) return;
        setSelectedStationId(list[0].id);
    };

    const currentAqi = currentReading?.aqi ?? null;

    return (
        <div className="min-h-screen bg-black text-white">
            <OnboardingModal
                onComplete={(prefs) => {
                    if (prefs.preferred_station) {
                        setSelectedStationId(prefs.preferred_station);
                    }
                }}
            />

            <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
                <div className="mb-5">
                    <h1 className="text-3xl font-semibold">Dashboard</h1>
                    <p className="text-white/70 mt-1">
                        Select a city or click a station marker to view the next-24h AQI
                        forecast.
                    </p>
                </div>

                {stationsError ? (
                    <div className="mb-4 bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-red-300 text-sm">
                        Couldn&apos;t load stations: {stationsError}
                    </div>
                ) : null}

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <div className={darkBgCard}>
                        <div className="mb-3">
                            <div className="text-white/80 text-sm font-medium mb-2">City</div>
                            <div className="flex flex-wrap gap-2">
                                {cities.length === 0 && !stationsError ? (
                                    <div className="text-white/60 text-sm">Loading cities…</div>
                                ) : (
                                    cities.map((city) => {
                                        const active = city === selectedCity;
                                        return (
                                            <button
                                                key={city}
                                                onClick={() => onSelectCity(city)}
                                                className={[
                                                    "px-3 py-1.5 rounded-full text-sm border transition-colors",
                                                    active
                                                        ? "bg-white/20 border-white/40 text-white"
                                                        : "bg-white/5 border-white/10 text-white/80 hover:bg-white/10",
                                                ].join(" ")}
                                            >
                                                {city}
                                            </button>
                                        );
                                    })
                                )}
                            </div>
                        </div>

                        <div style={{ borderRadius: 16, overflow: "hidden" }}>
                            <StationMap
                                onStationSelect={(stationId) => setSelectedStationId(stationId)}
                            />
                        </div>
                    </div>

                    <div className="flex flex-col gap-4">
                        <ForecastChart
                            forecasts={forecasts}
                            currentAqi={currentAqi}
                            loading={stationDataLoading}
                            error={stationDataError}
                        />

                        <div id="advisory">
                            {selectedStation ? (
                                <AdvisoryPanel
                                    station={selectedStation}
                                    forecasts={forecasts}
                                    currentReading={currentReading}
                                    vulnerabilityFlags={preferences.vulnerability_flags}
                                    preferredLanguage={preferences.preferred_language}
                                    loading={stationDataLoading}
                                    error={stationDataError}
                                />
                            ) : (
                                <div className="bg-black/60 border border-white/10 rounded-2xl p-4">
                                    Select a station to see the advisory.
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {loading ? (
                    <div className="mt-4 text-white/60 text-sm">Loading data…</div>
                ) : null}
            </div>
        </div>
    );
}
