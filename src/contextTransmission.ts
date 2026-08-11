import { estimateTokens, sliceTextToTokens } from "./tokenBudget";

export interface ContextTransmissionInput {
  label: string;
  content: string;
  source: "explicit" | "visible";
  maxTokens: number;
}

export interface ContextTransmissionEntry {
  label: string;
  source: "explicit" | "visible";
  startLine: number;
  endLine: number;
  totalLines: number;
  estimatedTokens: number;
  tokenLimit: number;
  truncated: boolean;
  omitted: boolean;
  partialEndColumn?: number;
  truncationReason?: "file-limit" | "context-budget";
}

export interface ContextTransmissionSection {
  content: string;
  entries: ContextTransmissionEntry[];
  usedTokens: number;
}

export function buildContextTransmissionSection(inputs: ContextTransmissionInput[], totalTokenBudget: number): ContextTransmissionSection {
  const sections: string[] = [];
  const entries: ContextTransmissionEntry[] = [];
  let remaining = Math.max(0, totalTokenBudget);
  let usedTokens = 0;
  for (const input of inputs) {
    const totalLines = lineCount(input.content);
    const header = `--- ${input.label} ---`;
    const headerTokens = estimateTokens(header) + 12;
    const available = Math.max(0, Math.min(input.maxTokens, remaining - headerTokens));
    if (available === 0) {
      entries.push({ label: input.label, source: input.source, startLine: 0, endLine: 0, totalLines, estimatedTokens: 0, tokenLimit: input.maxTokens, truncated: true, omitted: true, truncationReason: "context-budget" });
      continue;
    }
    const sliced = sliceCompleteLines(input.content, available);
    const bodyTokens = estimateTokens(sliced.text);
    const wasFileLimited = estimateTokens(input.content) > input.maxTokens && available === input.maxTokens;
    const metadata = transmissionMetadata(input.label, sliced.endLine, totalLines, bodyTokens, sliced.truncated, sliced.partialEndColumn);
    const rendered = `${header}\n${metadata}\n${sliced.text}`;
    const renderedTokens = estimateTokens(rendered);
    sections.push(rendered);
    remaining = Math.max(0, remaining - renderedTokens);
    usedTokens += renderedTokens;
    entries.push({
      label: input.label,
      source: input.source,
      startLine: sliced.text ? 1 : 0,
      endLine: sliced.endLine,
      totalLines,
      estimatedTokens: bodyTokens,
      tokenLimit: input.maxTokens,
      truncated: sliced.truncated,
      omitted: false,
      partialEndColumn: sliced.partialEndColumn,
      truncationReason: sliced.truncated ? (wasFileLimited ? "file-limit" : "context-budget") : undefined,
    });
  }
  return { content: sections.join("\n\n"), entries, usedTokens };
}

export function formatContextTransmissionManifest(entries: ContextTransmissionEntry[]): string {
  const lines = entries.map((entry) => {
    if (entry.omitted) return `- ${entry.label}: 전달 안 됨 (전체 ${entry.totalLines}줄, 전체 컨텍스트 예산 부족)`;
    const range = entry.partialEndColumn
      ? `1줄 중 열 1~${entry.partialEndColumn}`
      : `1~${entry.endLine} / 전체 ${entry.totalLines}줄`;
    const reason = entry.truncationReason === "file-limit" ? `파일 ${entry.tokenLimit.toLocaleString("ko-KR")}토큰 제한` : entry.truncationReason === "context-budget" ? "전체 컨텍스트 예산" : "전체 전달";
    return `- ${entry.label}: ${range}, 약 ${entry.estimatedTokens}토큰, ${reason}`;
  });
  return `[컨텍스트] LLM 실제 전달 범위\n${lines.join("\n")}`;
}

function sliceCompleteLines(content: string, maxTokens: number): { text: string; endLine: number; truncated: boolean; partialEndColumn?: number } {
  if (estimateTokens(content) <= maxTokens) {
    const text = content.replace(/(?:\r\n|\r|\n)+$/, "");
    return { text, endLine: lineCount(text), truncated: false };
  }
  const prefix = sliceTextToTokens(content, maxTokens);
  const newline = Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf("\r"));
  if (newline < 0) return { text: prefix, endLine: 1, truncated: true, partialEndColumn: prefix.length };
  const text = prefix.slice(0, newline).replace(/\r$/, "");
  return { text, endLine: lineCount(text), truncated: true };
}

function transmissionMetadata(label: string, endLine: number, totalLines: number, tokens: number, truncated: boolean, partialEndColumn?: number): string {
  const range = partialEndColumn ? `line=1 columns=1-${partialEndColumn}` : `lines=1-${endLine}`;
  return `<transmission path="${escapeAttribute(label)}" ${range} totalLines=${totalLines} estimatedTokens=${tokens} truncated=${truncated} />`;
}

function lineCount(content: string): number {
  return content.length === 0 ? 0 : content.split(/\r\n|\r|\n/).length;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
