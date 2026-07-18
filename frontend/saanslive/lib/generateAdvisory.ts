import { isNimModelId, type NimModelId } from "./nimModels";

/**
 * lib/generateAdvisory.ts — LLM-polish layer for the advisory sentence.
 *
 * Takes the already-computed deterministic advisory (AQI value, category,
 * station, time, guidance clause) and the user's preferred language, and
 * asks the server-side /api/advisory route to rephrase it more naturally.
 *
 * RELIABILITY CONTRACT
 * ---------------------
 * This function NEVER throws. It always resolves to either:
 *   - { polished: string, provider: "nvidia_nim" }                 (success)
 *   - { polished: null }                                           (fall back)
 *
 * Callers must render the deterministic template when `polished` is null.
 * The template is the reliable baseline; the LLM output is a "nice to have"
 * enhancement layered on top, never a replacement dependency.
 *
 * A client-side AbortController enforces its own timeout in addition to the
 * server route's internal timeout, so a hung request never blocks the UI.
 */

export type AdvisoryPolishInput = {
    aqiValue: number;
    aqiCategory: string;
    stationName: string;
    timeLabel: string;
    guidanceClause: string;
    preferredLanguage: string;
    model: NimModelId;
};

export type AdvisoryPolishResult =
    | { polished: string; provider: "nvidia_nim"; model: NimModelId }
    | { polished: null };

const CLIENT_TIMEOUT_MS = 50_000;

export async function generatePolishedAdvisory(
    input: AdvisoryPolishInput
): Promise<AdvisoryPolishResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

    try {
        const res = await fetch("/api/advisory", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
            signal: controller.signal,
        });

        if (!res.ok) {
            return { polished: null };
        }

        const json = await res.json();
        if (
            typeof json?.polished === "string" &&
            json.polished.trim().length > 0 &&
            json?.provider === "nvidia_nim" &&
            isNimModelId(json?.model)
        ) {
            return {
                polished: json.polished.trim(),
                provider: "nvidia_nim",
                model: json.model,
            };
        }
        return { polished: null };
    } catch (err) {
        // Network error, abort/timeout, JSON parse failure -- all fall back
        // to the template. This is intentionally silent to the user; the
        // template renders instantly regardless.
        console.warn("[generateAdvisory] Falling back to template:", err);
        return { polished: null };
    } finally {
        clearTimeout(timeout);
    }
}
