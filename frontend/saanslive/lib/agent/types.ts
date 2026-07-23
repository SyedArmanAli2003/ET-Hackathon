export type AgentTrigger = "manual" | "scheduled";

export type AlertLevel = "elevated" | "high" | "critical";

export type AgentReasoningStep = {
    step: "plan" | "decide" | "act" | "self_review" | "log";
    description: string;
    /** Only real query inputs/counts and deterministic decision outputs. */
    data: Record<string, unknown>;
};

export type FlaggedStation = {
    stationId: string;
    city: string;
    stationName: string;
    currentAqi: number | null;
    currentReadingAt: string | null;
    forecastAqi: number | null;
    forecastAt: string | null;
    alertLevel: AlertLevel;
    reason: string;
};

export type AgentSelfReviewOutcome = {
    stationId: string;
    city: string;
    verdict: "confirmed" | "false_alarm" | "no_data";
    observedAqi: number | null;
    observedAt: string | null;
};

export type AgentSelfReview = {
    reviewedRunId: string;
    evaluatedAt: string;
    summary: {
        flagged: number;
        confirmed: number;
        falseAlarms: number;
        unavailable: number;
    };
    outcomes: AgentSelfReviewOutcome[];
};

export type AgentRun = {
    id: string;
    createdAt: string;
    trigger: AgentTrigger;
    reasoningSteps: AgentReasoningStep[];
    flaggedStations: FlaggedStation[];
    advisories: Record<string, string>;
    selfReview: AgentSelfReview | null;
};
