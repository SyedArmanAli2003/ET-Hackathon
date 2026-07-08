"use client";

/**
 * OnboardingModal.tsx
 *
 * First-visit onboarding form for SaanSLive.
 *
 * Flow
 * ────
 * 1. On mount, calls getOrCreateProfile() (lib/userProfile.js) which
 *    restores or creates an anonymous Supabase Auth session and ensures a
 *    user_profiles row exists (defaults only written on first insert).
 * 2. If the returned profile already has non-default vulnerability_flags or
 *    preferred_language, the user has completed onboarding before — the
 *    modal never renders (see `hasCompletedOnboarding` below).
 * 3. Otherwise renders a short form (flags, language, preferred station).
 * 4. On submit, calls updateProfile() — a real UPDATE scoped by RLS to the
 *    caller's own row, never an upsert with hardcoded defaults. Only the
 *    fields the user actually touched are sent.
 *
 * The completed profile is reported to the parent via onComplete so it can
 * be threaded into AdvisoryPanel without a second fetch.
 */

import { useEffect, useState } from "react";
import { getOrCreateProfile, updateProfile } from "../lib/userProfile";
import { supabase } from "../lib/supabaseClient";
import { getStations, type Station } from "../lib/data";

export type UserProfile = {
    id: string;
    user_id: string;
    name: string | null;
    vulnerability_flags: string[];
    preferred_station: string | null;
    preferred_language: string;
    created_at: string;
};

export type OnboardingModalProps = {
    onComplete: (profile: UserProfile) => void;
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

/**
 * A profile counts as "already onboarded" if it has been explicitly
 * customized away from the getOrCreateProfile() insert defaults
 * (vulnerability_flags: [], preferred_language: 'en'). This is the same
 * signal used to decide whether to show the modal at all.
 */
function hasCompletedOnboarding(profile: UserProfile | null): boolean {
    if (!profile) return false;
    const hasFlags = Array.isArray(profile.vulnerability_flags) && profile.vulnerability_flags.length > 0;
    const hasNonDefaultLanguage = !!profile.preferred_language && profile.preferred_language !== "en";
    const hasStation = !!profile.preferred_station;
    return hasFlags || hasNonDefaultLanguage || hasStation;
}

export default function OnboardingModal({ onComplete }: OnboardingModalProps) {
    const [visible, setVisible] = useState(false);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [stations, setStations] = useState<Station[]>([]);
    const [flags, setFlags] = useState<Record<string, boolean>>({});
    const [language, setLanguage] = useState("en");
    const [preferredStation, setPreferredStation] = useState<string>("");

    useEffect(() => {
        let cancelled = false;

        async function init() {
            try {
                const [rawProfile, stationList] = await Promise.all([
                    getOrCreateProfile(supabase),
                    getStations(),
                ]);

                if (cancelled) return;

                const profile = rawProfile as UserProfile;
                setStations(stationList);

                if (hasCompletedOnboarding(profile)) {
                    // Already onboarded — skip the modal, hand the profile up.
                    onComplete(profile);
                    setVisible(false);
                } else {
                    setVisible(true);
                }
            } catch (err) {
                if (cancelled) return;
                console.error("[OnboardingModal] init failed:", err);
                setError(
                    err instanceof Error ? err.message : "Failed to load your profile."
                );
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        init();

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const toggleFlag = (key: string) => {
        setFlags((prev) => ({ ...prev, [key]: !prev[key] }));
    };

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setSubmitting(true);
        setError(null);

        try {
            const selectedFlags = VULNERABILITY_OPTIONS
                .map((o) => o.key)
                .filter((key) => flags[key]);

            // Only send fields the user actually set — never blanket-write
            // hardcoded defaults over whatever is already in the row.
            const updates: Record<string, unknown> = {
                vulnerability_flags: selectedFlags,
                preferred_language: language,
            };
            if (preferredStation) {
                updates.preferred_station = preferredStation;
            }

            await updateProfile(supabase, updates);

            // Re-fetch the row so the parent gets the authoritative state
            // (RLS scopes this to the caller's own row automatically).
            const { data: refreshed, error: fetchError } = await supabase
                .from("user_profiles")
                .select("*")
                .single();

            if (fetchError) throw new Error(fetchError.message);

            onComplete(refreshed as UserProfile);
            setVisible(false);
        } catch (err) {
            console.error("[OnboardingModal] submit failed:", err);
            setError(
                err instanceof Error ? err.message : "Failed to save your preferences."
            );
        } finally {
            setSubmitting(false);
        }
    }

    if (loading || !visible) return null;

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
                    This helps us tailor health advisories to your household. You can
                    change these later.
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

                    {error ? (
                        <div className="text-red-400 text-sm">{error}</div>
                    ) : null}

                    <button
                        type="submit"
                        disabled={submitting}
                        className="w-full bg-[#e8702a] hover:bg-[#d2611f] disabled:opacity-60 text-white text-sm font-semibold py-2.5 rounded-full transition-colors"
                    >
                        {submitting ? "Saving…" : "Save preferences"}
                    </button>
                </form>
            </div>
        </div>
    );
}
