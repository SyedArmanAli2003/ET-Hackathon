/**
 * app/api/advisory/route.ts — Server-side LLM rephrasing proxy for AdvisoryPanel.
 *
 * WHY A SERVER ROUTE
 * -------------------
 * AdvisoryPanel is a client component. The NVIDIA NIM API key must
 * never reach the browser bundle, so this route holds the secrets and the
 * client (lib/generateAdvisory.ts) POSTs the already-computed template data
 * here instead of calling NVIDIA directly.
 *
 * CASCADE STRATEGY
 * ----------------
 * Primary  : minimaxai/minimax-m3      — fastest, most reliable on free pool
 * Fallback1: openai/gpt-oss-120b
 * Fallback2: deepseek-ai/deepseek-v4-flash
 *
 * When no model is specified by the client, all three are tried in order.
 * The first non-null response wins. Only if all three fail does the route
 * return { polished: null } so the caller renders the deterministic template.
 *
 * When the client explicitly picks a model via the UI picker, we honour that
 * selection with a single-model call (no cascade) — the picker is opt-in.
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
import {
    isNimModelId,
    NIM_GENERATION_SETTINGS,
    type NimModelId,
} from "../../../lib/nimModels";

export const runtime = "nodejs";

type AdvisoryRequestBody = {
    aqiValue: number;
    aqiCategory: string;
    stationName: string;
    timeLabel: string;
    guidanceClause: string;
    preferredLanguage: string;
    model?: NimModelId;
};

const NVIDIA_NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

const REQUEST_TIMEOUT_MS = 45_000;

// Cascade order: primary → fallback-1 → fallback-2
const CASCADE_MODELS: NimModelId[] = [
    "minimaxai/minimax-m3",          // primary   — fastest, most reliable
    "openai/gpt-oss-120b",           // fallback 1
    "deepseek-ai/deepseek-v4-flash", // fallback 2
];

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
    model: NimModelId,
    prompt: string
): Promise<string | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const settings = NIM_GENERATION_SETTINGS[model];
        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages: [{ role: "user", content: prompt }],
                temperature: settings.temperature,
                top_p: settings.topP,
                max_tokens: settings.maxTokens,
                stream: false,
            }),
            signal: controller.signal,
        });

        if (!res.ok) {
            console.error(`[advisory-api] ${url} responded ${res.status} for model ${model}`);
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
        console.error(`[advisory-api] ${url} failed for model ${model}:`, err);
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

    // Validate client-supplied model if present
    const clientModel = body.model;
    if (clientModel !== undefined && !isNimModelId(clientModel)) {
        return NextResponse.json({ polished: null, reason: "invalid_model" }, { status: 400 });
    }

    const prompt = buildPrompt({ ...body, preferredLanguage });
    const nvidiaKey = process.env.NVIDIA_NIM_API_KEY;

    if (!nvidiaKey) {
        return NextResponse.json({ polished: null, reason: "no_provider_succeeded" });
    }

    // ── Single-model path (client explicitly picked a model via the picker) ─
    if (clientModel !== undefined) {
        console.info("[advisory-api] Single-model call", { model: clientModel, preferredLanguage });
        const polished = await callChatCompletions(NVIDIA_NIM_URL, nvidiaKey, clientModel, prompt);
        if (polished) {
            return NextResponse.json({ polished, provider: "nvidia_nim", model: clientModel });
        }
        return NextResponse.json({ polished: null, reason: "no_provider_succeeded" });
    }

    // ── Cascade path: MiniMax M3 → GPT-OSS 120B → DeepSeek V4 Flash ────────
    for (const model of CASCADE_MODELS) {
        console.info("[advisory-api] Cascade attempt", { model, preferredLanguage });
        const polished = await callChatCompletions(NVIDIA_NIM_URL, nvidiaKey, model, prompt);
        if (polished) {
            console.info("[advisory-api] Cascade succeeded", { model });
            return NextResponse.json({ polished, provider: "nvidia_nim", model });
        }
        console.warn("[advisory-api] Model failed, trying next in cascade", { model });
    }

    // All three models failed — caller renders the deterministic template.
    return NextResponse.json({ polished: null, reason: "no_provider_succeeded" });
}
