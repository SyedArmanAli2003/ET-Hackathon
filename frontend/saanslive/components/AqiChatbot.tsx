"use client";

/**
 * AqiChatbot.tsx — Floating AI assistant with live-data tool calls.
 *
 * NOT a generic chatbot: every factual answer about AQI/forecasts is
 * grounded in real Supabase queries executed server-side by
 * app/api/chat/route.ts via lib/chatTools.ts. This component only handles
 * conversation UI state and talks to that one route.
 */

import { useEffect, useRef, useState } from "react";
import { MessageCircle, X, Send, Wrench } from "lucide-react";

type ChatRole = "user" | "assistant";

type ChatMessage = {
    role: ChatRole;
    content: string;
    toolCalls?: { name: string; args: unknown }[];
};

const SUGGESTED_PROMPTS = [
    "What's the AQI in Delhi right now?",
    "Will Mumbai's air quality get worse today?",
    "Compare Delhi and Bengaluru's air quality",
];

function ToolCallBadge({ toolCalls }: { toolCalls: { name: string; args: unknown }[] }) {
    if (!toolCalls || toolCalls.length === 0) return null;
    const names = Array.from(new Set(toolCalls.map((t) => t.name)));
    return (
        <div className="flex items-center gap-1.5 mt-1.5 text-white/35 text-[10px]">
            <Wrench size={10} />
            <span>Checked live data: {names.join(", ")}</span>
        </div>
    );
}

export default function AqiChatbot() {
    const [open, setOpen] = useState(false);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }, [messages, sending]);

    async function sendMessage(text: string) {
        const trimmed = text.trim();
        if (!trimmed || sending) return;

        const nextMessages: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
        setMessages(nextMessages);
        setInput("");
        setSending(true);
        setError(null);

        try {
            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
                }),
            });

            const json = await res.json();

            if (!res.ok || json.error) {
                setError(json.error || "Something went wrong. Please try again.");
                return;
            }

            setMessages((prev) => [
                ...prev,
                { role: "assistant", content: json.reply || "(no response)", toolCalls: json.toolCalls },
            ]);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Network error. Please try again.");
        } finally {
            setSending(false);
        }
    }

    function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        sendMessage(input);
    }

    return (
        <>
            {/* Floating toggle button */}
            <button
                onClick={() => setOpen((v) => !v)}
                aria-label={open ? "Close AI assistant" : "Open AI assistant"}
                className="fixed bottom-5 right-5 z-[150] w-14 h-14 rounded-full bg-[#e8702a] hover:bg-[#d2611f] text-white shadow-xl shadow-[#e8702a]/30 flex items-center justify-center transition-all hover:scale-105 active:scale-95"
            >
                {open ? <X size={22} /> : <MessageCircle size={22} />}
            </button>

            {/* Chat panel */}
            {open && (
                <div className="fixed bottom-24 right-5 z-[150] w-[92vw] max-w-sm h-[70vh] max-h-[560px] bg-[#0a0a0a] border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-white/[0.03]">
                        <div>
                            <div className="text-white text-sm font-semibold">SaanSLive Assistant</div>
                            <div className="text-white/40 text-[10px]">Answers backed by live station data</div>
                        </div>
                        <button
                            onClick={() => setOpen(false)}
                            aria-label="Close"
                            className="text-white/50 hover:text-white p-1"
                        >
                            <X size={18} />
                        </button>
                    </div>

                    {/* Messages */}
                    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                        {messages.length === 0 ? (
                            <div className="flex flex-col gap-2">
                                <div className="text-white/50 text-xs mb-1">
                                    Ask me about current AQI, forecasts, or compare cities.
                                </div>
                                {SUGGESTED_PROMPTS.map((p) => (
                                    <button
                                        key={p}
                                        onClick={() => sendMessage(p)}
                                        className="text-left text-white/70 text-xs bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl px-3 py-2 transition-colors"
                                    >
                                        {p}
                                    </button>
                                ))}
                            </div>
                        ) : (
                            messages.map((m, i) => (
                                <div
                                    key={i}
                                    className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                                >
                                    <div
                                        className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                                            m.role === "user"
                                                ? "bg-[#e8702a] text-white"
                                                : "bg-white/[0.06] text-white/90 border border-white/10"
                                        }`}
                                    >
                                        {m.content}
                                        {m.role === "assistant" && m.toolCalls ? (
                                            <ToolCallBadge toolCalls={m.toolCalls} />
                                        ) : null}
                                    </div>
                                </div>
                            ))
                        )}

                        {sending ? (
                            <div className="flex justify-start">
                                <div className="bg-white/[0.06] border border-white/10 rounded-2xl px-3.5 py-2.5 flex items-center gap-1.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-white/50 animate-bounce [animation-delay:-0.3s]" />
                                    <span className="w-1.5 h-1.5 rounded-full bg-white/50 animate-bounce [animation-delay:-0.15s]" />
                                    <span className="w-1.5 h-1.5 rounded-full bg-white/50 animate-bounce" />
                                </div>
                            </div>
                        ) : null}

                        {error ? (
                            <div className="text-red-400 text-xs bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
                                {error}
                            </div>
                        ) : null}
                    </div>

                    {/* Input */}
                    <form onSubmit={handleSubmit} className="flex items-center gap-2 p-3 border-t border-white/10">
                        <input
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            placeholder="Ask about air quality..."
                            disabled={sending}
                            className="flex-1 bg-white/5 border border-white/15 rounded-full px-4 py-2 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-[#e8702a] disabled:opacity-50"
                        />
                        <button
                            type="submit"
                            disabled={sending || !input.trim()}
                            aria-label="Send"
                            className="w-9 h-9 rounded-full bg-[#e8702a] hover:bg-[#d2611f] disabled:opacity-40 disabled:hover:bg-[#e8702a] text-white flex items-center justify-center transition-colors flex-shrink-0"
                        >
                            <Send size={15} />
                        </button>
                    </form>
                </div>
            )}
        </>
    );
}
