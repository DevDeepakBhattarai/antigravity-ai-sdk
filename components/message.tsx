import type { UIMessage } from "ai";

interface MessageProps {
  message: UIMessage;
}

export function Message({ message }: MessageProps) {
  const isUser = message.role === "user";
  if (process.env.NODE_ENV !== "production") {
    console.log("[ui] message parts", message.id, message.parts);
  }

  const text = message.parts
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");

  const reasoning = message.parts
    .filter((p): p is Extract<typeof p, { type: "reasoning" }> => p.type === "reasoning")
    .map((p) => p.text)
    .join("");

  if (!text && !reasoning) return null;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[75%] space-y-2">
        {!isUser && reasoning && (
          <details className="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-4 py-2 text-xs text-zinc-400">
            <summary className="cursor-pointer select-none">Reasoning</summary>
            <div className="mt-2 whitespace-pre-wrap leading-relaxed text-zinc-300">
              {reasoning}
            </div>
          </details>
        )}
        {text && (
          <div
            className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
              isUser
                ? "bg-blue-600 text-white"
                : "bg-zinc-800 text-zinc-200"
            }`}
          >
            {text}
          </div>
        )}
      </div>
    </div>
  );
}
