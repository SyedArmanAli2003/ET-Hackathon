import { NextResponse } from "next/server";
import {
    AgentConfigurationError,
    runCivicAqiAlertAgent,
} from "../../../../lib/agent/aqiAlertAgent";

export const runtime = "nodejs";

const MANUAL_COOLDOWN_MS = 60_000;

type AgentRunGuard = { running: boolean; lastManualRunAt: number };
const globalWithAgentGuard = globalThis as typeof globalThis & {
    __saansliveAgentRunGuard?: AgentRunGuard;
};

function getManualRunGuard(): AgentRunGuard {
    if (!globalWithAgentGuard.__saansliveAgentRunGuard) {
        globalWithAgentGuard.__saansliveAgentRunGuard = { running: false, lastManualRunAt: 0 };
    }
    return globalWithAgentGuard.__saansliveAgentRunGuard;
}

/**
 * Public manual runs are burst-limited so the dashboard remains demoable
 * without exposing a secret. Scheduled calls must include AGENT_RUN_TOKEN.
 */
export async function POST(request: Request) {
    const suppliedToken = request.headers.get("x-agent-run-token");
    const configuredToken = process.env.AGENT_RUN_TOKEN;
    const isScheduledRun = suppliedToken != null;

    if (isScheduledRun && (!configuredToken || suppliedToken !== configuredToken)) {
        return NextResponse.json({ error: "Invalid scheduled-run token." }, { status: 401 });
    }

    const guard = getManualRunGuard();
    if (guard.running) {
        return NextResponse.json({ error: "An agent run is already in progress." }, { status: 409 });
    }

    if (!isScheduledRun) {
        const elapsed = Date.now() - guard.lastManualRunAt;
        if (elapsed < MANUAL_COOLDOWN_MS) {
            const seconds = Math.ceil((MANUAL_COOLDOWN_MS - elapsed) / 1000);
            return NextResponse.json({ error: `Please wait ${seconds}s before running the agent again.` }, { status: 429 });
        }
    }

    guard.running = true;

    try {
        const run = await runCivicAqiAlertAgent({
            trigger: isScheduledRun ? "scheduled" : "manual",
        });
        if (!isScheduledRun) guard.lastManualRunAt = Date.now();
        return NextResponse.json({ run });
    } catch (error) {
        console.error("[agent-run] Failed to execute Civic AQI Alert Agent:", error);
        const status = error instanceof AgentConfigurationError ? 503 : 500;
        return NextResponse.json(
            {
                error: error instanceof AgentConfigurationError
                    ? error.message
                    : "The alert agent could not complete its run. Please try again later.",
            },
            { status }
        );
    } finally {
        guard.running = false;
    }
}
