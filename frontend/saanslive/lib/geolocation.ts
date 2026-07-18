/**
 * lib/geolocation.ts — Client-side "nearest station" auto-detect.
 *
 * Pure convenience layer: never blocks page load, never shows an error,
 * never makes a network call. If the browser grants location permission,
 * we compute the nearest station from the already-loaded `stations` array
 * using the haversine formula (great-circle distance) entirely client-side.
 * If permission is denied, unavailable, or the browser doesn't support the
 * Geolocation API at all, callers get `null` and should silently fall back
 * to their existing default-station logic.
 */

import type { Station } from "./data";

const EARTH_RADIUS_KM = 6371;

function toRadians(deg: number): number {
    return (deg * Math.PI) / 180;
}

/** Great-circle distance between two lat/lng points, in kilometers. */
export function haversineDistanceKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
): number {
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_RADIUS_KM * c;
}

/** Return the station nearest to (lat, lon), or null if the list is empty. */
export function findNearestStation(
    stations: Station[],
    lat: number,
    lon: number
): Station | null {
    if (stations.length === 0) return null;

    let nearest = stations[0];
    let nearestDist = haversineDistanceKm(lat, lon, nearest.latitude, nearest.longitude);

    for (let i = 1; i < stations.length; i++) {
        const st = stations[i];
        const dist = haversineDistanceKm(lat, lon, st.latitude, st.longitude);
        if (dist < nearestDist) {
            nearest = st;
            nearestDist = dist;
        }
    }

    return nearest;
}

const GEOLOCATION_TIMEOUT_MS = 5000;

/**
 * Request the browser's geolocation once, resolving to coordinates or null.
 *
 * NEVER rejects/throws -- permission denial, unsupported browsers, and
 * timeouts all resolve to null so callers can unconditionally fall back
 * to their default-station logic without needing a try/catch.
 */
export function requestGeolocation(): Promise<{ lat: number; lon: number } | null> {
    return new Promise((resolve) => {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            resolve(null);
            return;
        }

        navigator.geolocation.getCurrentPosition(
            (position) => {
                resolve({
                    lat: position.coords.latitude,
                    lon: position.coords.longitude,
                });
            },
            () => {
                // Permission denied, position unavailable, or any other
                // error -- this is a convenience layer only, never surface
                // an error to the user.
                resolve(null);
            },
            {
                enableHighAccuracy: false,
                timeout: GEOLOCATION_TIMEOUT_MS,
                maximumAge: 5 * 60 * 1000, // accept a cached fix up to 5 min old
            }
        );
    });
}
