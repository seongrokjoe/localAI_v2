import { ChatMessage, ChatToolDefinition } from "./types";

export const MIN_INPUT_TOKENS = 4096;

export interface TokenBudget {
  contextWindowTokens: number;
  outputTokens: number;
  safetyTokens: number;
  inputTokens: number;
}

export class TokenBudgetConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenBudgetConfigurationError";
  }
}

export class TokenBudgetExceededError extends Error {
  constructor(
    readonly estimatedInputTokens: number,
    readonly budget: TokenBudget,
  ) {
    super(
      "LLM 요청 토큰 예산 초과: 입력 약 " + estimatedInputTokens.toLocaleString("ko-KR") + " 토큰, " +
      "허용 입력 " + budget.inputTokens.toLocaleString("ko-KR") + " 토큰 " +
      "(전체 " + budget.contextWindowTokens.toLocaleString("ko-KR") +
      ", 출력 예약 " + budget.outputTokens.toLocaleString("ko-KR") +
      ", 안전 여유 " + budget.safetyTokens.toLocaleString("ko-KR") +
      "). 첨부 컨텍스트를 줄이거나 출력 토큰 설정을 낮추세요.",
    );
    this.name = "TokenBudgetExceededError";
  }
}

export function createTokenBudget(contextWindowTokens: number, outputTokens: number): TokenBudget {
  const safetyTokens = Math.max(8192, Math.ceil(contextWindowTokens * 0.05));
  const inputTokens = contextWindowTokens - outputTokens - safetyTokens;
  if (inputTokens < MIN_INPUT_TOKENS) {
    throw new TokenBudgetConfigurationError(
      "LLM 토큰 설정이 유효하지 않습니다. 전체 컨텍스트 " + contextWindowTokens.toLocaleString("ko-KR") +
      "에서 출력 " + outputTokens.toLocaleString("ko-KR") +
      "과 안전 여유 " + safetyTokens.toLocaleString("ko-KR") +
      "를 제외하면 최소 입력 공간 " + MIN_INPUT_TOKENS.toLocaleString("ko-KR") +
      " 토큰을 확보할 수 없습니다.",
    );
  }
  return { contextWindowTokens, outputTokens, safetyTokens, inputTokens };
}

export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) <= 0x7f) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 2) + nonAscii;
}

export function sliceTextToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateTokens(text) <= maxTokens) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

export function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const suffix = "\n[truncated]";
  const contentBudget = Math.max(0, maxTokens - estimateTokens(suffix));
  return sliceTextToTokens(text, contentBudget) + suffix;
}

export function estimateChatInputTokens(messages: ChatMessage[], tools?: ChatToolDefinition[]): number {
  const messageTokens = messages.reduce((total, message) => total + estimateTokens(JSON.stringify(message)) + 8, 0);
  const toolTokens = tools?.length ? estimateTokens(JSON.stringify(tools)) + 16 : 0;
  return messageTokens + toolTokens + 32;
}

export function assertChatRequestFits(
  messages: ChatMessage[],
  tools: ChatToolDefinition[] | undefined,
  budget: TokenBudget,
): number {
  const estimated = estimateChatInputTokens(messages, tools);
  if (estimated > budget.inputTokens) throw new TokenBudgetExceededError(estimated, budget);
  return estimated;
}
