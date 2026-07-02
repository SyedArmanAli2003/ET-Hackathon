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
} from "../saanslive/lib/data";

export type StationMapProps = {
    onStationSelect: (stationId: string) => void;
};

type SeverityBand = {
    min: number;
    max: number; // inclusive upper bound, or Infinity
    label: string;
    color: string;
};

const AQI_SEVERITY_BANDS: SeverityBand[] = [
    { min: 0, max: 50, label: "Good", color: "#2e7d32" }, // green
    { min: 51, max: 100, label: "Moderate", color: "#f2c94c" }, // yellow
    {
        min: 101,
        max: 150,
        label: "Unhealthy for Sensitive Groups",
        color: "#f2994a",
    }, // orange
    { min: 151, max: 200, label: "Unhealthy", color: "#eb5757" }, // red
    { min: 201, max: 300, label: "Very Unhealthy", color: "#9b51e0" }, // purple
    { min: 301, max: Infinity, label: "Hazardous", color: "#6b1b24" }, // maroon
];

function severityForAqi(aqi: number): SeverityBand {
    return (
        AQI_SEVERITY_BANDS.find((b) => aqi >= b.min && aqi <= b.max) ??
        AQI_SEVERITY_BANDS[AQI_SEVERITY_BANDS.length - 1]
    );
}

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

    useEffect(() => {
        let cancelled = false;

        async function load() {
            setLoading(true);
            try {
                const s = await getStations();
                if (cancelled) return;

                setStations(s);

                const readingResults = await Promise.all(
                    s.map(async (station) => {
                        const r = await getCurrentReading(station.id);
                        return [station.id, r] as const;
                    })
                );

                if (cancelled) return;

                const byId: Record<string, Reading | null> = {};
                for (const [stationId, r] of readingResults) byId[stationId] = r;

                setReadingsByStationId(byId);
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        load();

        return () => {
            cancelled = true;
        };
    }, []);

    const indiaCenter: LatLngExpression = useMemo(() => [22.9734, 79.9548], []);

    return (
        <div
            style={{
                width: "100%",
                height: "520px",
                position: "relative",
            }}
        >
            {loading && (
                <div
                    style={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: "rgba(255,255,255,0.7)",
                        zIndex: 1000,
                        fontSize: 14,
                        color: "#111827",
                    }}
                >
                    Loading map…
                </div>
            )}

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
                    const band = aqi === null ? null : severityForAqi(aqi);
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
