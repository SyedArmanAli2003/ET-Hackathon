"use client";

/**
 * lib/localPreferences.ts — Purely client-side user preferences.
 *
 * Replaces the previous Supabase-backed user_profiles flow. No auth session,
 * no database row, no network request of any kind — everything lives in
 * localStorage under a single key on the visitor's own browser.
 *
 * This was an intentional privacy decision: we no longer want a persistent
 * auth.users record created for every anonymous visitor. The `user_profiles`
 * table and its RLS policies still exist in Supabase (see schema.sql) but are
 * no longer written to or read from by the frontend. That table is left as
 * unused-but-present infrastructure, not a mistake — do not drop it, and do
 * not resurrect calls to it from here.
 */

import { useCallback, useEffect, useState } from "react";

export const PREFERENCES_STORAGE_KEY = "saanslive_preferences";

export type Preferences = {
    vulnerability_flags: string[];
    preferred_language: string;
    preferred_station: string | null;
    onboarding_completed: boolean;
};

const DEFAULT_PREFERENCES: Preferences = {
    vulnerability_flags: [],
    preferred_language: "en",
    preferred_station: null,
    onboarding_completed: false,
};

/**
 * Reads preferences synchronously from localStorage. Returns defaults if
 * nothing is stored yet, the stored value is malformed, or localStorage is
 * unavailable (e.g. SSR — this guards against `window` not existing).
 */
function readPreferences(): Preferences {
    if (typeof window === "undefined") return DEFAULT_PREFERENCES;

    try {
        const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
        if (!raw) return DEFAULT_PREFERENCES;

        const parsed = JSON.parse(raw);
        const vulnerabilityFlags = Array.isArray(parsed.vulnerability_flags)
            ? parsed.vulnerability_flags
            : DEFAULT_PREFERENCES.vulnerability_flags;
        const preferredLanguage =
            typeof parsed.preferred_language === "string"
                ? parsed.preferred_language
                : DEFAULT_PREFERENCES.preferred_language;
        const preferredStation =
            typeof parsed.preferred_station === "string"
                ? parsed.preferred_station
                : DEFAULT_PREFERENCES.preferred_station;

        return {
            vulnerability_flags: vulnerabilityFlags,
            preferred_language: preferredLanguage,
            preferred_station: preferredStation,
            // Migrate earlier completed profiles that predate this explicit flag.
            onboarding_completed:
                parsed.onboarding_completed === true ||
                vulnerabilityFlags.length > 0 ||
                preferredLanguage !== DEFAULT_PREFERENCES.preferred_language ||
                !!preferredStation,
        };
    } catch (err) {
        console.warn("[localPreferences] Failed to parse stored preferences:", err);
        return DEFAULT_PREFERENCES;
    }
}

function writePreferences(prefs: Preferences): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(prefs));
    } catch (err) {
        console.warn("[localPreferences] Failed to write preferences:", err);
    }
}

/**
 * True once the visitor submits onboarding. This is separate from preference
 * values so accepting the default selections still means "don't show again."
 */
export function hasCompletedOnboarding(prefs: Preferences): boolean {
    return prefs.onboarding_completed;
}

export type UsePreferencesResult = {
    preferences: Preferences;
    /** False until the initial localStorage read has happened on mount. */
    loaded: boolean;
    /** Merge partial updates and persist immediately. */
    updatePreferences: (updates: Partial<Preferences>) => void;
};

/**
 * usePreferences — client-side hook for reading/writing local preferences.
 *
 * Loads from localStorage on mount (loaded flips true right after), and
 * persists any updates back to localStorage synchronously.
 */
export function usePreferences(): UsePreferencesResult {
    const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        setPreferences(readPreferences());
        setLoaded(true);
    }, []);

    const updatePreferences = useCallback((updates: Partial<Preferences>) => {
        setPreferences((prev) => {
            const next = { ...prev, ...updates };
            writePreferences(next);
            return next;
        });
    }, []);

    return { preferences, loaded, updatePreferences };
}
