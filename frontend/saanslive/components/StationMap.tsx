"use client";

import { useEffect, useMemo, useState } from "react";
import { MapContainer, Marker, Popup, TileLayer } from "react-leaflet";
import type { LatLngExpression } from "leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import {
    getCurrentReading,
    getStations,
    type Reading,
    type Station,
} from "../lib/data";
import { getAqiBand } from "../lib/aqi";
import { Skeleton } from "./Skeleton";

export type StationMapProps = {
    onStationSelect: (stationId: string) => void;
};

function createColoredIcon(color: string) {
    return L.divIcon({
        className: "aqi-station-marker",
        html: `<div style="
        width:18px;height:18px;border-radius:50%;
        background:${color};
        border:2px solid rgba(255,255,255,0.95);
        box-shadow:0 2px 10px rgba(0,0,0,0.25);
      "></div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
        popupAnchor: [0, -9],
    });
}

export default function StationMap({ onStationSelect }: StationMapProps) {
    const [stations, setStations] = useState<Station[]>([]);
    const [readingsByStationId, setReadingsByStationId] = useState<
        Record<string, Reading | null>
    >({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            setLoading(true);
            setError(null);
            try {
                const s = await getStations();
                if (cancelled) return;

                setStations(s);

                // Use allSettled, not all: a single station's reading failure
                // (transient network blip, etc.) must not take down every
                // other marker on the map. Failed stations just render gray
                // (unknown AQI) instead of the whole map showing an error.
                const readingResults = await Promise.allSettled(
                    s.map(async (station) => {
                        const r = await getCurrentReading(station.id);
                        return [station.id, r] as const;
                    })
                );

                if (cancelled) return;

                const byId: Record<string, Reading | null> = {};
                for (const result of readingResults) {
                    if (result.status === "fulfilled") {
                        const [stationId, r] = result.value;
                        byId[stationId] = r;
                    } else {
                        console.error("[StationMap] Failed to load a station reading:", result.reason);
                    }
                }

                setReadingsByStationId(byId);
            } catch (err) {
                if (cancelled) return;
                setError(
                    err instanceof Error ? err.message : "Failed to load the map."
                );
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        load();

        return () => {
            cancelled = true;
        };
    }, []);

    const indiaCenter: LatLngExpression = useMemo(
        () => [22.9734, 79.9548],
        []
    );

    if (loading) {
        return (
            <Skeleton className="w-full" style={{ height: "520px", borderRadius: 16 }} />
        );
    }

    if (error) {
        return (
            <div
                style={{ height: "520px" }}
                className="w-full rounded-2xl border border-white/10 bg-black/60 flex flex-col items-center justify-center gap-2 text-center px-6"
            >
                <div className="text-white/80 text-sm font-medium">
                    Couldn&apos;t load the map
                </div>
                <div className="text-white/50 text-xs">{error}</div>
            </div>
        );
    }

    return (
        <div
            style={{
                width: "100%",
                height: "520px",
                position: "relative",
            }}
        >
            <MapContainer
                center={indiaCenter}
                zoom={4.7}
                scrollWheelZoom={false}
                style={{
                    width: "100%",
                    height: "100%",
                    borderRadius: 16,
                    overflow: "hidden",
                }}
            >
                <TileLayer
                    attribution="&copy; OpenStreetMap contributors"
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />

                {stations.map((station) => {
                    const reading = readingsByStationId[station.id];
                    const aqi = reading?.aqi ?? null;
                    const band = aqi === null ? null : getAqiBand(aqi);
                    const markerColor = band?.color ?? "#9ca3af";

                    return (
                        <Marker
                            key={station.id}
                            position={[station.latitude, station.longitude]}
                            eventHandlers={{
                                click: () => onStationSelect(station.id),
                            }}
                            icon={createColoredIcon(markerColor)}
                        >
                            <Popup>
                                <div style={{ minWidth: 180 }}>
                                    <div style={{ fontWeight: 700, marginBottom: 4 }}>
                                        {station.name}
                                    </div>
                                    <div style={{ fontSize: 13, color: "#111827" }}>
                                        Current AQI:&nbsp;
                                        {aqi === null ? "—" : ` ${aqi}`}
                                    </div>
                                    {band ? (
                                        <div
                                            style={{
                                                fontSize: 12,
                                                color: "#6b7280",
                                                marginTop: 2,
                                            }}
                                        >
                                            Severity: {band.label}
                                        </div>
                                    ) : null}
                                </div>
                            </Popup>
                        </Marker>
                    );
                })}
            </MapContainer>
        </div>
    );
}
