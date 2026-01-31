import { streamText, convertToModelMessages, type UIMessage } from "ai";
import { createGeminiOAuth } from "@/lib/gemini-model";

export async function POST(req: Request) {
  const { messages, model: modelId } = (await req.json()) as {
    messages: UIMessage[];
    model?: string;
  };

  const model = createGeminiOAuth(modelId ?? "gemini-2.5-flash");

  const modelMessages = await convertToModelMessages(messages);

  const result = streamText({
    model,
    messages: modelMessages,
  });

  return result.toUIMessageStreamResponse();
}
