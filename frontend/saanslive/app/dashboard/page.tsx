"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";

import type { Forecast, Reading, Station } from "../../lib/data";
import {
    getCurrentReading,
    getLatestForecasts,
    getStationIdsWithForecasts,
    getStationIdsWithReadings,
    getStations,
} from "../../lib/data";

const StationMap = dynamic(
    () => import("../../components/StationMap"),
    { ssr: false }
);

import ForecastChart from "../../components/ForecastChart";
import AdvisoryPanel from "../../components/AdvisoryPanel";
import HotspotPanel from "../../components/HotspotPanel";
import CityComparisonView from "../../components/CityComparisonView";
import OnboardingModal from "../../components/OnboardingModal";
import { usePreferences } from "../../lib/localPreferences";
import { findNearestStation, requestGeolocation } from "../../lib/geolocation";

const darkBgCard =
    "bg-black/70 border border-white/10 rounded-2xl p-4 backdrop-blur-md";

type DashboardTab = "overview" | "hotspots" | "compare";

export default function DashboardPage() {
    const [activeTab, setActiveTab] = useState<DashboardTab>("overview");
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
    const { preferences, updatePreferences } = usePreferences();

    // "geo" = auto-selected via browser geolocation, "default" = fell back
    // to the existing has-data heuristic. Drives the small indicator UI.
    // Purely informational -- never blocks anything.
    const [locationSource, setLocationSource] = useState<"geo" | "default" | null>(null);

    useEffect(() => {
        let cancelled = false;

        async function loadStations() {
            setLoading(true);
            setStationsError(null);
            try {
                const [s, stationIdsWithForecasts, stationIdsWithReadings, geo] = await Promise.all([
                    getStations(),
                    getStationIdsWithForecasts(),
                    getStationIdsWithReadings(),
                    requestGeolocation(),
                ]);
                if (cancelled) return;
                setStations(s);
                if (s.length > 0 && !selectedStationId) {
                    // Priority 1: nearest station to the user's real location,
                    // if geolocation permission was granted (never blocks --
                    // requestGeolocation() always resolves, never rejects).
                    const nearest = geo ? findNearestStation(s, geo.lat, geo.lon) : null;

                    if (nearest) {
                        setSelectedStationId(nearest.id);
                        setLocationSource("geo");
                    } else {
                        // Fallback (unchanged): a station with BOTH a current
                        // reading and a forecast. Chain: both → forecast only → first.
                        const withBoth = s.find(
                            (st) => stationIdsWithForecasts.has(st.id) && stationIdsWithReadings.has(st.id)
                        );
                        const withForecast = s.find((st) => stationIdsWithForecasts.has(st.id));
                        setSelectedStationId((withBoth ?? withForecast ?? s[0]).id);
                        setLocationSource("default");
                    }
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
        setLocationSource(null); // manual override — indicator no longer applies
    };

    const currentAqi = currentReading?.aqi ?? null;

    return (
        <div className="min-h-screen bg-black text-white">
            <OnboardingModal
                onComplete={(prefs) => {
                    updatePreferences(prefs);
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
                    {locationSource && selectedStation ? (
                        <div className="mt-2 inline-flex items-center gap-1.5 text-xs text-white/50 bg-white/5 border border-white/10 rounded-full px-3 py-1">
                            {locationSource === "geo" ? (
                                <>
                                    <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                                    Using your location — showing {selectedStation.city}
                                </>
                            ) : (
                                <>Showing {selectedStation.city}</>
                            )}
                        </div>
                    ) : null}
                </div>

                {stationsError ? (
                    <div className="mb-4 bg-red-500/10 border border-red-500/30 rounded-xl p-3 text-red-300 text-sm">
                        Couldn&apos;t load stations: {stationsError}
                    </div>
                ) : null}

                <div className="mb-5 flex gap-2 border-b border-white/10">
                    {(
                        [
                            { id: "overview" as const, label: "Overview" },
                            { id: "hotspots" as const, label: "Hotspot Prioritization" },
                            { id: "compare" as const, label: "Compare Cities" },
                        ]
                    ).map((tab) => {
                        const active = tab.id === activeTab;
                        return (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={[
                                    "px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px",
                                    active
                                        ? "border-white text-white"
                                        : "border-transparent text-white/50 hover:text-white/80",
                                ].join(" ")}
                            >
                                {tab.label}
                            </button>
                        );
                    })}
                </div>

                {activeTab === "overview" ? (
                    <>
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
                                        onStationSelect={(stationId) => {
                                            setSelectedStationId(stationId);
                                            setLocationSource(null); // manual override
                                        }}
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
                    </>
                ) : activeTab === "hotspots" ? (
                    <HotspotPanel />
                ) : (
                    <CityComparisonView />
                )}
            </div>
        </div>
    );
}
