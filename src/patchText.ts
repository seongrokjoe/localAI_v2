import { WorkspacePatchChange } from "./types";

export interface OriginalTextMatch {
  text: string;
  occurrences: number;
  method: "exact" | "line-ending" | "whitespace-normalized";
}

interface ResolvedLineEdit {
  start: number;
  end: number;
  replacement: string;
  startLine: number;
  endLine: number;
}

export function isLineRangeChange(change: WorkspacePatchChange): boolean {
  return change.startLine !== undefined || change.endLine !== undefined || change.startAnchor !== undefined || change.endAnchor !== undefined;
}

export function applyLineRangeChanges(current: string, eol: string, changes: WorkspacePatchChange[]): string {
  const resolved = changes.map((change) => resolveLineEdit(current, eol, change));
  const ordered = [...resolved].sort((left, right) => right.start - left.start);

  for (let index = 1; index < ordered.length; index++) {
    const later = ordered[index - 1];
    const earlier = ordered[index];
    if (earlier.end > later.start) {
      throw new Error(
        `줄 범위 변경이 서로 겹칩니다: ${earlier.startLine}-${earlier.endLine}, ${later.startLine}-${later.endLine}`,
      );
    }
  }

  let result = current;
  for (const edit of ordered) {
    result = `${result.slice(0, edit.start)}${edit.replacement}${result.slice(edit.end)}`;
  }
  return result;
}

export function findOriginalTextMatch(current: string, originalText: string, eol: string): OriginalTextMatch | undefined {
  if (!originalText) {
    return undefined;
  }

  const exactOccurrences = countOccurrences(current, originalText);
  if (exactOccurrences > 0) {
    return { text: originalText, occurrences: exactOccurrences, method: "exact" };
  }

  const eolAdjusted = adaptLineEndings(originalText, eol);
  const adjustedOccurrences = countOccurrences(current, eolAdjusted);
  if (adjustedOccurrences > 0) {
    return { text: eolAdjusted, occurrences: adjustedOccurrences, method: "line-ending" };
  }

  const currentLines = splitLines(current);
  const originalLines = splitLines(eolAdjusted);
  while (originalLines.length > 1 && originalLines.at(-1)?.text === "") {
    originalLines.pop();
  }
  if (originalLines.length === 0 || originalLines.some((line) => normalizeLine(line.text) === "")) {
    return undefined;
  }

  const candidates: string[] = [];
  for (let start = 0; start + originalLines.length <= currentLines.length; start++) {
    const matches = originalLines.every(
      (line, offset) => normalizeLine(line.text) === normalizeLine(currentLines[start + offset].text),
    );
    if (!matches) {
      continue;
    }
    const first = currentLines[start];
    const last = currentLines[start + originalLines.length - 1];
    const originalEndsWithEol = /(?:\r\n|\r|\n)$/.test(eolAdjusted);
    const candidateEnd = originalEndsWithEol ? last.endWithEol : last.start + last.text.length;
    candidates.push(current.slice(first.start, candidateEnd));
  }

  if (candidates.length === 0) {
    return undefined;
  }
  return { text: candidates[0], occurrences: candidates.length, method: "whitespace-normalized" };
}

function resolveLineEdit(current: string, eol: string, change: WorkspacePatchChange): ResolvedLineEdit {
  const startLine = change.startLine;
  const endLine = change.endLine;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine === undefined || endLine === undefined) {
    throw new Error("줄 범위 변경에는 정수 startLine과 endLine이 필요합니다.");
  }
  if (startLine < 1 || endLine < startLine) {
    throw new Error(`잘못된 줄 범위입니다: ${startLine}-${endLine}`);
  }
  if (!change.startAnchor?.trim() || !change.endAnchor?.trim() || typeof change.replacementText !== "string") {
    throw new Error(`줄 범위 ${startLine}-${endLine}에는 startAnchor, endAnchor, replacementText가 필요합니다.`);
  }

  const lines = splitLines(current);
  if (endLine > lines.length) {
    throw new Error(`줄 범위 ${startLine}-${endLine}가 현재 파일의 ${lines.length}개 줄을 벗어납니다.`);
  }

  const first = lines[startLine - 1];
  const last = lines[endLine - 1];
  if (normalizeLine(first.text) !== normalizeLine(change.startAnchor)) {
    throw new Error(`startAnchor가 현재 파일의 ${startLine}번째 줄과 일치하지 않습니다.`);
  }
  if (normalizeLine(last.text) !== normalizeLine(change.endAnchor)) {
    throw new Error(`endAnchor가 현재 파일의 ${endLine}번째 줄과 일치하지 않습니다.`);
  }

  const original = current.slice(first.start, last.endWithEol);
  let replacement = adaptLineEndings(change.replacementText, eol);
  if (original.endsWith(eol) && replacement && !replacement.endsWith(eol)) {
    replacement += eol;
  }

  return { start: first.start, end: last.endWithEol, replacement, startLine, endLine };
}

interface SourceLine {
  text: string;
  start: number;
  endWithEol: number;
}

function splitLines(content: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const expression = /\r\n|\r|\n/g;
  let start = 0;
  for (let match = expression.exec(content); match; match = expression.exec(content)) {
    lines.push({ text: content.slice(start, match.index), start, endWithEol: match.index + match[0].length });
    start = match.index + match[0].length;
  }
  lines.push({ text: content.slice(start), start, endWithEol: content.length });
  return lines;
}

function normalizeLine(value: string): string {
  return value.trim().replace(/[ \t]+/g, " ");
}

function adaptLineEndings(text: string, eol: string): string {
  return text.replace(/\r\n|\r|\n/g, eol);
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= content.length - needle.length) {
    const index = content.indexOf(needle, offset);
    if (index === -1) {
      break;
    }
    count++;
    offset = index + needle.length;
  }
  return count;
}
