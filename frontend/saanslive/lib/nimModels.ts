export const NIM_MODELS = [
    {
        id: "meta/llama-3.3-70b-instruct",
        label: "Llama 3.3 70B",
        description: "Balanced multilingual advisory rewriting",
    },
    {
        id: "minimaxai/minimax-m3",
        label: "MiniMax M3",
        description: "General-purpose, detailed responses",
    },
    {
        id: "openai/gpt-oss-120b",
        label: "GPT-OSS 120B",
        description: "Advanced reasoning; may take longer",
    },
    {
        id: "deepseek-ai/deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        description: "Fast reasoning model; latency varies under shared-pool load",
    },
] as const;

export type NimModelId = (typeof NIM_MODELS)[number]["id"];

// DEFAULT MODEL SELECTION — measured, not assumed
// ------------------------------------------------
// deepseek-ai/deepseek-v4-flash was benchmarked against the other 3
// allowlisted models with real timed calls (see kiro.md). Results:
//   - minimaxai/minimax-m3:   1.3-2.2s, 0 failures across all test runs
//   - openai/gpt-oss-120b:    1.9s, 0 failures
//   - deepseek-ai/deepseek-v4-flash: 0.6-19.3s, includes a real
//     503 "Worker local total request limit reached" failure and 2 more
//     failures in a 3-call follow-up batch -- NVIDIA's shared free-tier
//     pool for this model is currently saturated/rate-limited.
//   - meta/llama-3.3-70b-instruct: 37-46s, 4/5 timeouts (worst of all four).
// minimax-m3 is kept as default because it was the only model with zero
// observed failures. deepseek-v4-flash is available in the picker since it
// CAN be fast (sub-1s) when the pool isn't saturated, but it is not
// currently reliable enough to be the unconditional default.
export const DEFAULT_NIM_MODEL: NimModelId = "minimaxai/minimax-m3";

export const NIM_GENERATION_SETTINGS: Record<
    NimModelId,
    { temperature: number; topP: number; maxTokens: number }
> = {
    "meta/llama-3.3-70b-instruct": {
        temperature: 0.2,
        topP: 0.7,
        maxTokens: 1024,
    },
    "minimaxai/minimax-m3": {
        temperature: 1,
        topP: 0.95,
        maxTokens: 8192,
    },
    "openai/gpt-oss-120b": {
        temperature: 1,
        topP: 1,
        maxTokens: 4096,
    },
    "deepseek-ai/deepseek-v4-flash": {
        temperature: 1,
        topP: 0.95,
        maxTokens: 4096,
    },
};

export function isNimModelId(value: unknown): value is NimModelId {
    return NIM_MODELS.some((model) => model.id === value);
}
