/**
 * app/api/advisory/route.ts — Server-side LLM rephrasing proxy for AdvisoryPanel.
 *
 * WHY A SERVER ROUTE
 * -------------------
 * AdvisoryPanel is a client component. OpenRouter/NVIDIA NIM API keys must
 * never reach the browser bundle, so this route holds the secrets and the
 * client (lib/generateAdvisory.ts) POSTs the already-computed template data
 * here instead of calling either provider directly.
 *
 * PROVIDERS
 * ---------
 * 1. OpenRouter (model "openrouter/free") — tried first.
 * 2. NVIDIA NIM — fallback if OpenRouter fails/times out. Model configurable
 *    via NVIDIA_NIM_MODEL env var; swap this value whenever you decide which
 *    NIM model to use, no code change needed.
 * 3. If both fail (or neither API key is configured), returns { polished: null }
 *    so the client falls back to the deterministic template. This route is
 *    NEVER the only path to a displayed advisory.
 *
 * SAFETY
 * ------
 * The LLM is instructed to only rephrase — never invent numbers, never
 * change the AQI value or category. Even so, this is model output and must
 * be treated as advisory only, not authoritative. We also strip the
 * response down to a single sentence server-side as a defensive measure in
 * case the model ignores the instruction.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";

type AdvisoryRequestBody = {
    aqiValue: number;
    aqiCategory: string;
    stationName: string;
    timeLabel: string;
    guidanceClause: string;
    preferredLanguage: string;
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "openrouter/free";

const NVIDIA_NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
// Swap this to whichever NIM model you decide on later -- no other code
// needs to change.
const NVIDIA_NIM_MODEL = process.env.NVIDIA_NIM_MODEL || "meta/llama-3.1-8b-instruct";

const REQUEST_TIMEOUT_MS = 6000;

function buildPrompt(body: AdvisoryRequestBody): string {
    return `You are rephrasing an air quality advisory sentence for a dashboard. Rewrite the following facts as ONE natural, plain sentence in ${body.preferredLanguage === "en" ? "English" : `the language with BCP-47 code "${body.preferredLanguage}"`}.

Facts (do not change these, do not invent any other numbers):
- Predicted AQI: ${body.aqiValue}
- Category: "${body.aqiCategory}"
- Station: ${body.stationName}
- Time: ${body.timeLabel}
- Guidance: ${body.guidanceClause}

Rules:
- Output ONLY the rewritten sentence, nothing else -- no preamble, no quotes, no explanation.
- Exactly one sentence.
- Keep the AQI value (${body.aqiValue}) and category ("${body.aqiCategory}") exactly as given -- do not change, round differently, or reinterpret them.
- Do not add alarmist language, exclamation points, or invented statistics.
- Do not invent any numbers not listed above.`;
}

async function callChatCompletions(
    url: string,
    apiKey: string,
    model: string,
    prompt: string,
    extraHeaders?: Record<string, string>
): Promise<string | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
                ...extraHeaders,
            },
            body: JSON.stringify({
                model,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.4,
                max_tokens: 120,
            }),
            signal: controller.signal,
        });

        if (!res.ok) {
            console.error(`[advisory-api] ${url} responded ${res.status}`);
            return null;
        }

        const json = await res.json();
        const content: string | undefined = json?.choices?.[0]?.message?.content;
        if (!content || typeof content !== "string") return null;

        // Defensive: collapse to a single sentence/line even if the model
        // ignored the "one sentence" instruction.
        const firstLine = content.trim().split("\n")[0].trim();
        return firstLine.length > 0 ? firstLine : null;
    } catch (err) {
        console.error(`[advisory-api] ${url} failed:`, err);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

export async function POST(request: Request) {
    let body: AdvisoryRequestBody;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ polished: null, reason: "invalid_body" }, { status: 400 });
    }

    if (
        typeof body.aqiValue !== "number" ||
        typeof body.aqiCategory !== "string" ||
        typeof body.stationName !== "string" ||
        typeof body.timeLabel !== "string" ||
        typeof body.guidanceClause !== "string"
    ) {
        return NextResponse.json({ polished: null, reason: "invalid_body" }, { status: 400 });
    }

    const preferredLanguage =
        typeof body.preferredLanguage === "string" ? body.preferredLanguage : "en";
    const prompt = buildPrompt({ ...body, preferredLanguage });

    const openRouterKey = process.env.OPENROUTER_API_KEY;
    const nvidiaKey = process.env.NVIDIA_NIM_API_KEY;

    // ── 1. Try OpenRouter first ────────────────────────────────────────────
    if (openRouterKey) {
        const polished = await callChatCompletions(
            OPENROUTER_URL,
            openRouterKey,
            OPENROUTER_MODEL,
            prompt,
            {
                // Recommended by OpenRouter for attribution/rate-limit purposes.
                "HTTP-Referer": "https://saanslive.vercel.app",
                "X-Title": "SaanSLive",
            }
        );
        if (polished) {
            return NextResponse.json({ polished, provider: "openrouter" });
        }
    }

    // ── 2. Fallback to NVIDIA NIM ──────────────────────────────────────────
    if (nvidiaKey) {
        const polished = await callChatCompletions(
            NVIDIA_NIM_URL,
            nvidiaKey,
            NVIDIA_NIM_MODEL,
            prompt
        );
        if (polished) {
            return NextResponse.json({ polished, provider: "nvidia_nim" });
        }
    }

    // ── 3. Both failed or neither configured — caller falls back to template ──
    return NextResponse.json({ polished: null, reason: "no_provider_succeeded" });
}
