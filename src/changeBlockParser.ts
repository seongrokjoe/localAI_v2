import { randomUUID } from "node:crypto";
import { AiChangeBlock } from "./types";

interface RawChangeBlock {
  id?: unknown;
  path?: unknown;
  pathHint?: unknown;
  file?: unknown;
  filePath?: unknown;
  languageId?: unknown;
  language?: unknown;
  description?: unknown;
  summary?: unknown;
  originalText?: unknown;
  originalCode?: unknown;
  before?: unknown;
  proposedText?: unknown;
  replacementText?: unknown;
  newCode?: unknown;
  after?: unknown;
  startLine?: unknown;
  endLine?: unknown;
}

interface Fence {
  info: string;
  text: string;
  before: string;
}

export function parseChangeBlockArguments(argumentsText: string): AiChangeBlock[] {
  try {
    const value = JSON.parse(argumentsText) as unknown;
    return parseStructuredValue(value, "tool");
  } catch {
    return [];
  }
}

export function extractChangeBlocks(content: string): AiChangeBlock[] {
  const structured: AiChangeBlock[] = [];
  for (const match of content.matchAll(/```(?:company-code-ai|json)\s*\r?\n([\s\S]*?)```/gi)) {
    try {
      structured.push(...parseStructuredValue(JSON.parse(match[1]), "json"));
    } catch {
      // A normal JSON example is not a change proposal.
    }
  }
  if (structured.length > 0) {
    return deduplicate(structured);
  }

  const fences = collectFences(content).filter((fence) => !/^(?:json|company-code-ai)$/i.test(fence.info));
  const blocks: AiChangeBlock[] = [];
  for (let index = 0; index < fences.length; index++) {
    const fence = fences[index];
    const role = fenceRole(fence);
    const next = fences[index + 1];
    if (role === "original" && next && fenceRole(next) === "replacement") {
      blocks.push({
        id: randomUUID(),
        pathHint: inferPath(`${fence.before}\n${next.before}`),
        languageId: languageFromFence(next.info),
        description: inferDescription(fence.before),
        originalText: trimFenceText(fence.text),
        proposedText: trimFenceText(next.text),
        source: "markdown",
      });
      index++;
      continue;
    }
    if (role === "original") {
      continue;
    }
    const proposedText = trimFenceText(fence.text);
    if (!proposedText.trim()) {
      continue;
    }
    blocks.push({
      id: randomUUID(),
      pathHint: inferPath(fence.before),
      languageId: languageFromFence(fence.info),
      description: inferDescription(fence.before),
      proposedText,
      source: "markdown",
    });
  }
  return deduplicate(blocks);
}

export function mergeChangeBlocks(...groups: AiChangeBlock[][]): AiChangeBlock[] {
  return deduplicate(groups.flat());
}

function parseStructuredValue(value: unknown, source: "tool" | "json"): AiChangeBlock[] {
  const record = asRecord(value);
  if (!record) return [];
  const rawBlocks = Array.isArray(record.changes)
    ? record.changes
    : Array.isArray(record.blocks)
      ? record.blocks
      : Array.isArray(record.edits)
        ? record.edits
        : [];
  return rawBlocks.flatMap((raw) => normalizeRawBlock(raw, source));
}

function normalizeRawBlock(raw: unknown, source: "tool" | "json"): AiChangeBlock[] {
  const value = asRecord(raw) as RawChangeBlock | undefined;
  if (!value) return [];
  const proposedText = firstString(value.proposedText, value.replacementText, value.newCode, value.after);
  if (proposedText === undefined || !proposedText.trim()) return [];
  const startLine = positiveInteger(value.startLine);
  const endLine = positiveInteger(value.endLine);
  return [{
    id: firstString(value.id) || randomUUID(),
    pathHint: cleanPath(firstString(value.pathHint, value.path, value.filePath, value.file)),
    languageId: firstString(value.languageId, value.language),
    description: firstString(value.description, value.summary),
    originalText: firstString(value.originalText, value.originalCode, value.before),
    proposedText,
    startLine,
    endLine: endLine !== undefined && startLine !== undefined && endLine >= startLine ? endLine : undefined,
    source,
  }];
}

function collectFences(content: string): Fence[] {
  const matches = [...content.matchAll(/```([^\r\n`]*)\r?\n([\s\S]*?)```/g)];
  return matches.map((match) => ({
    info: match[1].trim(),
    text: match[2],
    before: content.slice(Math.max(0, (match.index ?? 0) - 500), match.index ?? 0),
  }));
}

function fenceRole(fence: Fence): "original" | "replacement" | "proposal" {
  const info = fence.info.toLowerCase();
  const tail = fence.before.slice(-120).toLowerCase();
  if (/^(?:original|before|old)$/.test(info) || /(?:original|before|원본|기존)\s*:?\s*$/.test(tail)) return "original";
  if (/^(?:replacement|after|new|proposed)$/.test(info) || /(?:replacement|after|수정|변경|제안)\s*:?\s*$/.test(tail)) return "replacement";
  return "proposal";
}

function inferPath(before: string): string | undefined {
  const tail = before.slice(-500);
  const matches = [...tail.matchAll(/(?:^|[\s`'"(])([A-Za-z0-9_@.+-]+(?:[\\/][A-Za-z0-9_@.+ -]+)*\.[A-Za-z0-9_+-]{1,12})(?=$|[\s`'":),])/gm)];
  return cleanPath(matches.at(-1)?.[1]);
}

function inferDescription(before: string): string | undefined {
  const lines = before.trimEnd().split(/\r?\n/);
  const value = lines.at(-1)?.replace(/^\s{0,3}#{1,6}\s*/, "").replace(/\s*:?\s*$/, "").trim();
  return value && value.length <= 160 ? value : undefined;
}

function languageFromFence(info: string): string | undefined {
  const value = info.trim().split(/\s+/)[0];
  return /^(?:original|before|old|replacement|after|new|proposed)$/i.test(value) ? undefined : value || undefined;
}

function trimFenceText(value: string): string {
  return value.replace(/\r?\n$/, "");
}

function cleanPath(value: string | undefined): string | undefined {
  const cleaned = value?.trim().replace(/^['"`]+|['"`]+$/g, "").replace(/\\/g, "/");
  return cleaned || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value);
  return undefined;
}

function deduplicate(blocks: AiChangeBlock[]): AiChangeBlock[] {
  const seen = new Set<string>();
  return blocks.filter((block) => {
    const key = `${block.pathHint ?? ""}\u0000${block.originalText ?? ""}\u0000${block.proposedText}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
