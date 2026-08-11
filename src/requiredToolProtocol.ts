import { ChatToolCall, ChatToolDefinition } from "./types";

export const finalResponseToolName = "submitFinalResponse";

export const finalResponseTool: ChatToolDefinition = {
  type: "function",
  function: {
    name: finalResponseToolName,
    description: "추가 워크스페이스 조회가 필요 없을 때 사용자에게 보여줄 최종 답변을 제출합니다.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", minLength: 1, description: "사용자에게 보여줄 완성된 최종 답변입니다." },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
};

export const requiredToolPrompt = [
  "이 서버에서는 매 응답마다 도구 호출이 필요합니다.",
  "추가 정보가 필요하면 워크스페이스 도구를 호출하세요.",
  `답변이 완성되면 다른 도구와 함께 호출하지 말고 ${finalResponseToolName} 도구 하나만 호출하세요.`,
].join("\n");

export function extractFinalResponse(call: ChatToolCall): string | undefined {
  try {
    const parsed = JSON.parse(call.function.arguments) as Record<string, unknown>;
    const content = parsed.content;
    return typeof content === "string" && content.trim() ? content : undefined;
  } catch {
    return undefined;
  }
}
