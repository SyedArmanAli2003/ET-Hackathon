import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
    AgentConfigurationError,
    runCivicAqiAlertAgent,
} from "../../../../lib/agent/aqiAlertAgent";

export const runtime = "nodejs";

const MANUAL_COOLDOWN_MS = 60_000;

/**
 * Query agent_runs directly for the guard check instead of an in-memory
 * globalThis flag. Vercel serverless functions do not share memory across
 * instances -- an in-memory guard only protects against bursts that happen
 * to land on the SAME warm instance, and does nothing when two requests hit
 * two different (possibly cold-started) instances at once. Querying the
 * actual most recent row makes the cooldown/concurrency check correct
 * regardless of how many instances are running.
 *
 * A run that started within the last MANUAL_COOLDOWN_MS -- whether it has
 * finished or is still in flight -- blocks a new manual run. This also
 * subsumes the old separate "already in progress" check: an in-flight run
 * hasn't written its row yet, but the run that just started blocking a new
 * one for 60s is a stronger and simpler guarantee than trying to detect
 * "in progress" across instances, which isn't reliably knowable without a
 * dedicated lock table.
 */
async function checkRecentRunGuard(): Promise<{ blocked: boolean; secondsRemaining: number }> {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceRoleKey) {
        throw new AgentConfigurationError(
            "The alert agent needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server."
        );
    }

    const client = createClient(url, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data, error } = await client
        .from("agent_runs")
        .select("created_at")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) {
        throw new Error(`Could not check the agent's recent-run guard: ${error.message}`);
    }
    if (!data) {
        return { blocked: false, secondsRemaining: 0 };
    }

    const elapsedMs = Date.now() - new Date(data.created_at).getTime();
    if (elapsedMs >= MANUAL_COOLDOWN_MS) {
        return { blocked: false, secondsRemaining: 0 };
    }
    return { blocked: true, secondsRemaining: Math.ceil((MANUAL_COOLDOWN_MS - elapsedMs) / 1000) };
}

/**
 * Public manual runs are burst-limited so the dashboard remains demoable
 * without exposing a secret. Scheduled calls must include AGENT_RUN_TOKEN
 * and skip the cooldown guard entirely (the scheduled cron already spaces
 * runs out by hours).
 */
export async function POST(request: Request) {
    const suppliedToken = request.headers.get("x-agent-run-token");
    const configuredToken = process.env.AGENT_RUN_TOKEN;
    const isScheduledRun = suppliedToken != null;

    if (isScheduledRun && (!configuredToken || suppliedToken !== configuredToken)) {
        return NextResponse.json({ error: "Invalid scheduled-run token." }, { status: 401 });
    }

    if (!isScheduledRun) {
        try {
            const { blocked, secondsRemaining } = await checkRecentRunGuard();
            if (blocked) {
                return NextResponse.json(
                    { error: `Please wait ${secondsRemaining}s before running the agent again.` },
                    { status: 429 }
                );
            }
        } catch (error) {
            console.error("[agent-run] Guard check failed:", error);
            const status = error instanceof AgentConfigurationError ? 503 : 500;
            return NextResponse.json(
                {
                    error: error instanceof AgentConfigurationError
                        ? error.message
                        : "Could not verify the agent's run state. Please try again.",
                },
                { status }
            );
        }
    }

    try {
        const run = await runCivicAqiAlertAgent({
            trigger: isScheduledRun ? "scheduled" : "manual",
        });
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
    }
}
