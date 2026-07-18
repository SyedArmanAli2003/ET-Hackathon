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
] as const;

export type NimModelId = (typeof NIM_MODELS)[number]["id"];

export const DEFAULT_NIM_MODEL: NimModelId = "meta/llama-3.3-70b-instruct";

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
};

export function isNimModelId(value: unknown): value is NimModelId {
    return NIM_MODELS.some((model) => model.id === value);
}
