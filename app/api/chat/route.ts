import { streamText, convertToModelMessages, type UIMessage } from "ai";
import { createGeminiOAuth } from "@/lib/gemini-model";

export async function POST(req: Request) {
  const {
    messages,
    model: modelId,
    thinking,
  } = (await req.json()) as {
    messages: UIMessage[];
    model?: string;
    thinking?: {
      enabled?: boolean;
      includeThoughts?: boolean;
      thinkingLevel?: "low" | "medium" | "high";
      thinkingBudget?: number;
    };
  };

  const model = createGeminiOAuth(modelId ?? "gemini-3-flash");

  const modelMessages = await convertToModelMessages(messages);

  const result = streamText({
    model,
    messages: modelMessages,
    providerOptions: {
      antigravity: {
        thinking,
      },
    },
  });

  return result.toUIMessageStreamResponse();
}
