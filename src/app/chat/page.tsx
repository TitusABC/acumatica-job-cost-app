"use client";

import { useState, useRef, useEffect, FormEvent } from "react";
import { useRouter } from "next/navigation";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface UserInfo {
  username: string;
  role: string;
}

interface ErrorLog {
  message: string;
  sql?: string;
}

export default function ChatPage() {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content:
        "Hello! I'm your Job Cost Analyst. I have access to your Acumatica job data and can answer questions about profitability, margins, trade performance, and more. What would you like to know?",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [errorLog, setErrorLog] = useState<ErrorLog | null>(null);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [dataStatus, setDataStatus] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.user) setUser(d.user);
      })
      .catch(() => {});

    fetch("/api/acumatica/jobs")
      .then((r) => r.json())
      .then((d) => {
        if (d.isDemo) setDataStatus("demo");
        else setDataStatus("live");
      })
      .catch(() => setDataStatus("error"));
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const userMessage: Message = { role: "user", content: trimmed };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput("");
    setLoading(true);
    setStatus("Thinking...");
    setErrorLog(null);

    // Insert placeholder assistant message for streaming into
    const assistantIndex = updatedMessages.length;
    setMessages([...updatedMessages, { role: "assistant", content: "" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          conversationHistory: messages,
        }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setMessages([
          ...updatedMessages,
          {
            role: "assistant",
            content: data.error || "Sorry, I encountered an error.",
          },
        ]);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulatedText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;

          let event: {
            type: string;
            message?: string;
            text?: string;
            sql?: string;
          };
          try {
            event = JSON.parse(raw);
          } catch {
            continue;
          }

          if (event.type === "status") {
            setStatus(event.message ?? null);
          } else if (event.type === "text") {
            accumulatedText += event.text ?? "";
            const captured = accumulatedText;
            setMessages((prev) => {
              const next = [...prev];
              if (next[assistantIndex]) {
                next[assistantIndex] = {
                  role: "assistant",
                  content: captured,
                };
              }
              return next;
            });
          } else if (event.type === "error") {
            setErrorLog({
              message: event.message ?? "Unknown error",
              sql: event.sql,
            });
            const fallback = accumulatedText || "I encountered an error while processing your request.";
            setMessages((prev) => {
              const next = [...prev];
              if (next[assistantIndex]) {
                next[assistantIndex] = { role: "assistant", content: fallback };
              }
              return next;
            });
          } else if (event.type === "done") {
            setStatus(null);
          }
        }
      }
    } catch {
      setMessages([
        ...updatedMessages,
        {
          role: "assistant",
          content: "Network error. Please check your connection.",
        },
      ]);
    } finally {
      setLoading(false);
      setStatus(null);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as FormEvent);
    }
  }

  return (
    <div className="flex h-screen bg-gray-100">
      <aside className="w-64 bg-slate-800 flex flex-col flex-shrink-0">
        <div className="px-6 py-5 border-b border-slate-700">
          <h1 className="text-amber-400 font-bold text-lg leading-tight">
            Job Cost Analyst
          </h1>
          <p className="text-slate-400 text-xs mt-0.5">Acumatica Integration</p>
        </div>

        {(dataStatus === "live" || dataStatus === "demo") && (
          <div className="px-6 py-3 border-b border-slate-700">
            <span
              className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full font-medium ${
                dataStatus === "live"
                  ? "bg-green-900/50 text-green-400"
                  : dataStatus === "demo"
                  ? "bg-amber-900/50 text-amber-400"
                  : "bg-red-900/50 text-red-400"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  dataStatus === "live"
                    ? "bg-green-400"
                    : dataStatus === "demo"
                    ? "bg-amber-400"
                    : "bg-red-400"
                }`}
              />
              {dataStatus === "live"
                ? "Live Data"
                : dataStatus === "demo"
                ? "Demo Data"
                : "Data Error"}
            </span>
          </div>
        )}

        <nav className="flex-1 px-4 py-4 space-y-1">
          <a
            href="/chat"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-slate-700 text-white text-sm font-medium"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
            Chat
          </a>
          {user?.role === "admin" && (
            <a
              href="/admin"
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-slate-300 hover:bg-slate-700 hover:text-white text-sm font-medium transition"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
                />
              </svg>
              Admin
            </a>
          )}
        </nav>

        <div className="px-4 py-4 border-t border-slate-700">
          {user && (
            <div className="mb-3 px-3">
              <p className="text-white text-sm font-medium">{user.username}</p>
              <p className="text-slate-400 text-xs capitalize">{user.role}</p>
            </div>
          )}
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-slate-300 hover:bg-slate-700 hover:text-white text-sm font-medium transition"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
              />
            </svg>
            Sign Out
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="bg-white border-b border-gray-200 px-6 py-4 flex-shrink-0">
          <h2 className="text-lg font-semibold text-gray-800">Job Cost Chat</h2>
          <p className="text-sm text-gray-500">
            Ask anything about job profitability and margins
          </p>
        </header>

        {errorLog && (
          <div className="mx-6 mt-4 bg-red-50 border border-red-200 rounded-xl p-4 flex-shrink-0">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-red-700 mb-1">
                  Query Error
                </p>
                <p className="text-sm text-red-600">{errorLog.message}</p>
                {errorLog.sql && (
                  <pre className="mt-2 text-xs text-red-500 bg-red-100 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-all">
                    {errorLog.sql}
                  </pre>
                )}
              </div>
              <button
                onClick={() => setErrorLog(null)}
                className="text-red-400 hover:text-red-600 transition flex-shrink-0 mt-0.5"
                aria-label="Dismiss error"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${
                msg.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              {msg.role === "assistant" && (
                <div className="w-8 h-8 rounded-full bg-amber-400 flex items-center justify-center text-slate-900 font-bold text-xs mr-3 flex-shrink-0 mt-0.5">
                  AI
                </div>
              )}
              <div
                className={`max-w-[70%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white rounded-br-sm"
                    : "bg-white text-gray-800 rounded-bl-sm shadow-sm border border-gray-100"
                }`}
              >
                {msg.content}
                {msg.role === "assistant" && loading && i === messages.length - 1 && msg.content === "" && (
                  <div className="flex gap-1 items-center h-5">
                    <span
                      className="w-2 h-2 rounded-full bg-gray-400 animate-bounce"
                      style={{ animationDelay: "0ms" }}
                    />
                    <span
                      className="w-2 h-2 rounded-full bg-gray-400 animate-bounce"
                      style={{ animationDelay: "150ms" }}
                    />
                    <span
                      className="w-2 h-2 rounded-full bg-gray-400 animate-bounce"
                      style={{ animationDelay: "300ms" }}
                    />
                  </div>
                )}
              </div>
              {msg.role === "user" && (
                <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold text-xs ml-3 flex-shrink-0 mt-0.5">
                  {user?.username?.[0]?.toUpperCase() || "U"}
                </div>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <div className="bg-white border-t border-gray-200 px-6 py-4 flex-shrink-0">
          <form onSubmit={handleSubmit} className="flex gap-3">
            <textarea
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about job margins, top performers, trade breakdowns..."
              className="flex-1 resize-none border border-gray-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition overflow-hidden"
              style={{ minHeight: "42px", maxHeight: "120px" }}
              onInput={(e) => {
                const t = e.currentTarget;
                t.style.height = "auto";
                t.style.height = Math.min(t.scrollHeight, 120) + "px";
              }}
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white rounded-xl px-4 py-2.5 font-medium text-sm transition flex items-center gap-2"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                />
              </svg>
              Send
            </button>
          </form>
          <div className="mt-2 h-4">
            {status ? (
              <p className="text-xs text-gray-400 flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                {status}
              </p>
            ) : (
              <p className="text-xs text-gray-400">
                Press Enter to send, Shift+Enter for new line
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}