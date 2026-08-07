import { createHash } from "node:crypto";

export interface ProposalTextRegion {
  id: string;
  startOffset: number;
  endOffset: number;
  originalText: string;
  replacementText: string;
}

export interface ProposalConflict {
  id: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  originalText: string;
  replacementText: string;
  preserveNoFinalEol: boolean;
}

export type ConflictChoice = "original" | "proposal" | "both";

export function buildProposalDraft(baseText: string, regions: ProposalTextRegion[], eol: string): string {
  const ordered = [...regions].sort((left, right) => right.startOffset - left.startOffset);
  for (let index = 0; index < ordered.length; index++) {
    const region = ordered[index];
    if (region.startOffset < 0 || region.endOffset < region.startOffset || region.endOffset > baseText.length) {
      throw new Error(`잘못된 작업본 범위입니다: ${region.startOffset}-${region.endOffset}`);
    }
    if (baseText.slice(region.startOffset, region.endOffset) !== region.originalText) {
      throw new Error(`작업본 범위 ${region.id}의 원문이 현재 파일과 일치하지 않습니다.`);
    }
    const previous = ordered[index - 1];
    if (previous && region.endOffset > previous.startOffset) {
      throw new Error(`작업본 범위가 서로 겹칩니다: ${region.id}, ${previous.id}`);
    }
  }

  let draft = baseText;
  for (const region of ordered) {
    const conflict = renderConflict(region, eol);
    draft = `${draft.slice(0, region.startOffset)}${conflict}${draft.slice(region.endOffset)}`;
  }
  return draft;
}

export function parseProposalConflicts(content: string): ProposalConflict[] {
  const pattern = /^<<<<<<< ORIGINAL \(Company Code AI: ([a-f0-9-]+)(; no-final-eol)?\)\r?\n([\s\S]*?)^=======\r?\n([\s\S]*?)^>>>>>>> AI \(Company Code AI: \1\)(?:\r?\n|$)/gm;
  const conflicts: ProposalConflict[] = [];
  for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
    conflicts.push({
      id: match[1],
      startOffset: match.index,
      endOffset: match.index + match[0].length,
      startLine: lineNumberAt(content, match.index),
      originalText: match[3],
      replacementText: match[4],
      preserveNoFinalEol: Boolean(match[2]),
    });
  }
  return conflicts;
}

export function unresolvedProposalConflictCount(content: string): number {
  const parsed = parseProposalConflicts(content).length;
  const starts = (content.match(/^<<<<<<< ORIGINAL \(Company Code AI:/gm) ?? []).length;
  const ends = (content.match(/^>>>>>>> AI \(Company Code AI:/gm) ?? []).length;
  const separators = (content.match(/^=======$/gm) ?? []).length;
  const dangling = Math.max(starts, ends, separators) > parsed ? 1 : 0;
  return parsed + dangling;
}

export function resolveProposalConflict(content: string, conflictId: string, choice: ConflictChoice, eol: string): string {
  const conflict = parseProposalConflicts(content).find((candidate) => candidate.id === conflictId);
  if (!conflict) {
    throw new Error(`작업본에서 conflict ${conflictId}를 찾지 못했습니다.`);
  }
  let replacement = choice === "original" ? conflict.originalText : conflict.replacementText;
  if (choice === "both") {
    replacement = `${ensureTrailingEol(conflict.originalText, eol)}${conflict.replacementText}`;
  }
  if (conflict.preserveNoFinalEol && conflict.endOffset === content.length) {
    replacement = replacement.replace(/(?:\r\n|\r|\n)$/, "");
  }
  return `${content.slice(0, conflict.startOffset)}${replacement}${content.slice(conflict.endOffset)}`;
}

export function hashProposalText(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function extractReplacementContent(content: string): { text: string; source: "fence" | "raw" } {
  const trimmed = content.trim();
  const fences = [...trimmed.matchAll(/```[^\r\n]*\r?\n([\s\S]*?)```/g)];
  if (fences.length === 1) {
    return { text: fences[0][1].replace(/\r?\n$/, ""), source: "fence" };
  }
  return { text: content.trimEnd(), source: "raw" };
}

function renderConflict(region: ProposalTextRegion, eol: string): string {
  const noFinalEol = !/(?:\r\n|\r|\n)$/.test(region.originalText);
  const original = ensureTrailingEol(adaptEol(region.originalText, eol), eol);
  const proposal = ensureTrailingEol(adaptEol(region.replacementText, eol), eol);
  return [
    `<<<<<<< ORIGINAL (Company Code AI: ${region.id}${noFinalEol ? "; no-final-eol" : ""})`,
    original.slice(0, -eol.length),
    "=======",
    proposal.slice(0, -eol.length),
    `>>>>>>> AI (Company Code AI: ${region.id})`,
    "",
  ].join(eol);
}

function ensureTrailingEol(content: string, eol: string): string {
  return content.endsWith(eol) ? content : `${content}${eol}`;
}

function adaptEol(content: string, eol: string): string {
  return content.replace(/\r\n|\r|\n/g, eol);
}

function lineNumberAt(content: string, offset: number): number {
  let line = 0;
  for (let index = 0; index < offset; index++) {
    if (content.charCodeAt(index) === 10) {
      line++;
    }
  }
  return line;
}
