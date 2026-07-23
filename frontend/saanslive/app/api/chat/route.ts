/**
 * app/api/chat/route.ts — Server-side AI chatbot with live-data tool calls.
 *
 * This is deliberately NOT a generic "chat with an LLM" endpoint. Every
 * factual claim about AQI/forecasts the bot makes is backed by a real
 * Supabase query via lib/chatTools.ts -- the model calls a tool, gets real
 * data back, and responds using that data. It cannot invent AQI numbers
 * because it's never asked to guess one; it's asked to report what the
 * tool returned.
 *
 * Runs the standard OpenAI-compatible tool-calling loop against NVIDIA NIM:
 *   1. Send user message + tool schemas.
 *   2. If the model requests tool call(s), execute them for real (against
 *      Supabase) and feed the results back as tool-role messages.
 *   3. Repeat until the model returns a final plain-text answer or the
 *      loop safety cap is hit.
 *
 * Same reliability posture as the advisory route: if NVIDIA NIM is
 * unreachable/unconfigured, returns a clear error the client can display
 * -- this is a standalone feature (chat), so there's no template to fall
 * back to, but it must fail visibly and quickly, never hang silently.
 */

import { NextResponse } from "next/server";
import {
    DEFAULT_NIM_MODEL,
    isNimModelId,
    NIM_GENERATION_SETTINGS,
    type NimModelId,
} from "../../../lib/nimModels";
import { CHAT_TOOLS, runChatTool } from "../../../lib/chatTools";

export const runtime = "nodejs";

const NVIDIA_NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_TOOL_ROUNDS = 4;

type ChatMessage = {
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
};

const BASE_SYSTEM_PROMPT = `You are the SaanSLive air quality assistant. You help users understand real, current, and forecast AQI data for Indian cities tracked by this app.

Rules:
- You have tools to look up real station data, current AQI readings, forecasts, city comparisons, and the most recent Civic AQI Alert Agent run. ALWAYS use a tool to get real numbers before answering any question about AQI values, categories, forecasts, or active alerts -- never guess or estimate a number yourself.
- If a tool returns an error or no data, tell the user honestly that data isn't available for that station/city right now -- do not make up a plausible-sounding number instead.
- Keep answers concise and conversational, a few sentences at most unless the user asks for detail.
- You may give general air-quality health advice (e.g. what "Unhealthy for Sensitive Groups" means), but always base specific numbers on tool results.
- If asked about something unrelated to air quality/this app, politely redirect to what you can help with.`;

// BCP-47 code -> human language name, for the system-prompt instruction below.
// Kept in sync with the onboarding language picker (lib/localPreferences.ts /
// components/OnboardingModal.tsx) -- en/hi/ta/bn/mr are the only codes a user
// can actually select, so those are the only ones this needs to name.
const LANGUAGE_NAMES: Record<string, string> = {
    en: "English",
    hi: "Hindi",
    ta: "Tamil",
    bn: "Bengali",
    mr: "Marathi",
};

/**
 * Build the system prompt for a given preferred language. Only the WORDING
 * of the reply changes -- the rules above (always use a tool, never invent
 * a number) are unconditional and repeated regardless of language, same
 * "translate, don't fabricate" contract as the advisory cascade.
 */
function buildSystemPrompt(preferredLanguage: string | undefined): string {
    const languageName = preferredLanguage ? LANGUAGE_NAMES[preferredLanguage] : undefined;
    if (!languageName || preferredLanguage === "en") return BASE_SYSTEM_PROMPT;
    return `${BASE_SYSTEM_PROMPT}\n\n- Respond in ${languageName} (BCP-47 "${preferredLanguage}"). Keep all AQI numbers, station names, and city names exactly as returned by the tools -- translate the wording around them, never the data itself.`;
}

async function callNimWithTools(
    apiKey: string,
    model: NimModelId,
    messages: ChatMessage[]
): Promise<{ message?: ChatMessage; error?: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const settings = NIM_GENERATION_SETTINGS[model];
        const res = await fetch(NVIDIA_NIM_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages,
                tools: CHAT_TOOLS,
                tool_choice: "auto",
                temperature: settings.temperature,
                top_p: settings.topP,
                max_tokens: settings.maxTokens,
                stream: false,
            }),
            signal: controller.signal,
        });

        if (!res.ok) {
            const text = await res.text().catch(() => "");
            return { error: `NVIDIA NIM responded ${res.status}: ${text.slice(0, 300)}` };
        }

        const json = await res.json();
        const message = json?.choices?.[0]?.message;
        if (!message) return { error: "Empty response from model." };
        return { message };
    } catch (err) {
        return {
            error:
                err instanceof Error
                    ? `${err.name}: ${err.message}`
                    : "Unknown error calling NVIDIA NIM.",
        };
    } finally {
        clearTimeout(timeout);
    }
}

export async function POST(request: Request) {
    let body: {
        messages?: { role: string; content: string }[];
        model?: NimModelId;
        preferredLanguage?: string;
    };
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return NextResponse.json({ error: "messages[] is required." }, { status: 400 });
    }

    const apiKey = process.env.NVIDIA_NIM_API_KEY;
    if (!apiKey) {
        return NextResponse.json(
            { error: "Chat is not configured (no API key set)." },
            { status: 503 }
        );
    }

    const configuredModel = process.env.NVIDIA_NIM_MODEL;
    const model = isNimModelId(body.model)
        ? body.model
        : isNimModelId(configuredModel)
            ? configuredModel
            : DEFAULT_NIM_MODEL;

    const conversation: ChatMessage[] = [
        { role: "system", content: buildSystemPrompt(body.preferredLanguage) },
        ...body.messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];

    const toolCallsMade: { name: string; args: unknown }[] = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const { message, error } = await callNimWithTools(apiKey, model, conversation);

        if (error) {
            console.error("[chat-api] NVIDIA NIM call failed:", error);
            return NextResponse.json({ error }, { status: 502 });
        }

        if (!message) {
            return NextResponse.json({ error: "No response from model." }, { status: 502 });
        }

        conversation.push(message);

        if (!message.tool_calls || message.tool_calls.length === 0) {
            // Final answer -- no more tools requested.
            return NextResponse.json({
                reply: message.content ?? "",
                model,
                toolCalls: toolCallsMade,
            });
        }

        // Execute every requested tool call for real, feed results back.
        for (const call of message.tool_calls) {
            let args: Record<string, unknown> = {};
            try {
                args = JSON.parse(call.function.arguments || "{}");
            } catch {
                // Malformed arguments from the model -- pass empty args,
                // the tool implementation will report what it can.
            }

            toolCallsMade.push({ name: call.function.name, args });

            const result = await runChatTool(call.function.name, args);

            conversation.push({
                role: "tool",
                tool_call_id: call.id,
                content: JSON.stringify(result),
            });
        }
    }

    return NextResponse.json(
        { error: "Too many tool-call rounds without a final answer." },
        { status: 502 }
    );
}
