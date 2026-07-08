"use client";

/**
 * OnboardingModal.tsx
 *
 * First-visit onboarding form for SaanSLive — fully client-side.
 *
 * Flow
 * ────
 * 1. On mount, reads preferences from localStorage via usePreferences()
 *    (lib/localPreferences.ts). No auth session, no network request.
 * 2. If the stored preferences are already non-default (flags set, language
 *    changed, or a station chosen), the visitor has completed onboarding
 *    before — the modal never renders.
 * 3. Otherwise renders a short form (flags, language, preferred station).
 * 4. On submit, calls updatePreferences() which merges and writes straight
 *    to localStorage — no database round-trip of any kind.
 *
 * Intentionally does NOT import Supabase, supabaseClient, or userProfile.js.
 * This component has zero knowledge of the database — see lib/localPreferences.ts
 * for the full rationale (privacy: no persistent auth.users row per visitor).
 */

import { useEffect, useState } from "react";
import { usePreferences, hasCompletedOnboarding, type Preferences } from "../lib/localPreferences";
import { getStations, type Station } from "../lib/data";

export type OnboardingModalProps = {
    onComplete: (preferences: Preferences) => void;
};

const VULNERABILITY_OPTIONS: { key: string; label: string }[] = [
    { key: "children", label: "Children in household" },
    { key: "elderly", label: "Elderly residents" },
    { key: "asthma", label: "Asthma / respiratory condition" },
];

const LANGUAGE_OPTIONS: { code: string; label: string }[] = [
    { code: "en", label: "English" },
    { code: "hi", label: "Hindi" },
    { code: "ta", label: "Tamil" },
    { code: "bn", label: "Bengali" },
    { code: "mr", label: "Marathi" },
];

export default function OnboardingModal({ onComplete }: OnboardingModalProps) {
    const { preferences, loaded, updatePreferences } = usePreferences();

    const [visible, setVisible] = useState(false);
    const [decided, setDecided] = useState(false);

    const [stations, setStations] = useState<Station[]>([]);
    const [flags, setFlags] = useState<Record<string, boolean>>({});
    const [language, setLanguage] = useState("en");
    const [preferredStation, setPreferredStation] = useState<string>("");

    // Load the station list for the "preferred station" dropdown. This is
    // public read-only data via lib/data.ts (Supabase), unrelated to auth.
    useEffect(() => {
        let cancelled = false;

        getStations().then((list) => {
            if (!cancelled) setStations(list);
        });

        return () => {
            cancelled = true;
        };
    }, []);

    // Once localStorage has been read, decide once whether to show the modal.
    useEffect(() => {
        if (!loaded || decided) return;

        if (hasCompletedOnboarding(preferences)) {
            onComplete(preferences);
            setVisible(false);
        } else {
            setVisible(true);
        }
        setDecided(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loaded]);

    const toggleFlag = (key: string) => {
        setFlags((prev) => ({ ...prev, [key]: !prev[key] }));
    };

    function handleSubmit(e: React.FormEvent) {
        e.preventDefault();

        const selectedFlags = VULNERABILITY_OPTIONS
            .map((o) => o.key)
            .filter((key) => flags[key]);

        const updates: Partial<Preferences> = {
            vulnerability_flags: selectedFlags,
            preferred_language: language,
        };
        if (preferredStation) {
            updates.preferred_station = preferredStation;
        }

        updatePreferences(updates);
        onComplete({ ...preferences, ...updates });
        setVisible(false);
    }

    if (!loaded || !visible) return null;

    return (
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="onboarding-title"
        >
            <div className="bg-[#0a0a0a] border border-white/10 rounded-2xl w-full max-w-md p-6">
                <h2 id="onboarding-title" className="text-white text-xl font-semibold mb-1">
                    Personalize your air quality alerts
                </h2>
                <p className="text-white/60 text-sm mb-5">
                    This helps us tailor health advisories to your household. Saved only
                    on this device — you can change these later.
                </p>

                <form onSubmit={handleSubmit} className="space-y-5">
                    <div>
                        <div className="text-white/80 text-sm font-medium mb-2">
                            Who are you monitoring air quality for?
                        </div>
                        <div className="space-y-2">
                            {VULNERABILITY_OPTIONS.map((opt) => (
                                <label
                                    key={opt.key}
                                    className="flex items-center gap-2 text-white/90 text-sm cursor-pointer"
                                >
                                    <input
                                        type="checkbox"
                                        checked={!!flags[opt.key]}
                                        onChange={() => toggleFlag(opt.key)}
                                        className="w-4 h-4 accent-[#e8702a]"
                                    />
                                    {opt.label}
                                </label>
                            ))}
                        </div>
                    </div>

                    <div>
                        <label className="block text-white/80 text-sm font-medium mb-2" htmlFor="preferred-language">
                            Preferred language
                        </label>
                        <select
                            id="preferred-language"
                            value={language}
                            onChange={(e) => setLanguage(e.target.value)}
                            className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#e8702a]"
                        >
                            {LANGUAGE_OPTIONS.map((opt) => (
                                <option key={opt.code} value={opt.code} className="bg-[#0a0a0a]">
                                    {opt.label}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label className="block text-white/80 text-sm font-medium mb-2" htmlFor="preferred-station">
                            Preferred station
                        </label>
                        <select
                            id="preferred-station"
                            value={preferredStation}
                            onChange={(e) => setPreferredStation(e.target.value)}
                            className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-[#e8702a]"
                        >
                            <option value="" className="bg-[#0a0a0a]">
                                No preference
                            </option>
                            {stations.map((s) => (
                                <option key={s.id} value={s.id} className="bg-[#0a0a0a]">
                                    {s.name} — {s.city}
                                </option>
                            ))}
                        </select>
                    </div>

                    <button
                        type="submit"
                        className="w-full bg-[#e8702a] hover:bg-[#d2611f] text-white text-sm font-semibold py-2.5 rounded-full transition-colors"
                    >
                        Save preferences
                    </button>
                </form>
            </div>
        </div>
    );
}
