import { LineChangeOperation } from "./types";

export function lineOperationOffsets(
  content: string,
  operation: LineChangeOperation,
  startLine: number,
  endLine: number,
): { start: number; end: number } | undefined {
  if (operation === "create_file") return { start: 0, end: 0 };
  const starts = [0];
  const pattern = /\r\n|\r|\n/g;
  for (let match = pattern.exec(content); match; match = pattern.exec(content)) starts.push(match.index + match[0].length);
  if (startLine < 1 || endLine < startLine || endLine > starts.length) return undefined;
  const start = starts[startLine - 1];
  const afterEnd = endLine < starts.length ? starts[endLine] : content.length;
  if (operation === "insert_before") return { start, end: start };
  if (operation === "insert_after") return { start: afterEnd, end: afterEnd };
  return { start, end: afterEnd };
}

export function replacementForLineChange(
  operation: LineChangeOperation,
  code: string,
  originalText: string,
  insertionOffset: number,
  baseText: string,
  eol: string,
): string {
  const adapted = adaptEol(code, eol);
  const indented = operation === "create_file"
    ? dedentCommonIndent(adapted)
    : alignReplacementIndent(operation, adapted, originalText, baseText, insertionOffset, eol);
  if (operation === "create_file") return indented;
  if (operation === "insert_before") return ensureTrailingEol(indented, eol);
  if (operation === "insert_after") {
    return insertionOffset === baseText.length && !endsWithEol(baseText)
      ? `${eol}${indented}`
      : ensureTrailingEol(indented, eol);
  }
  return endsWithEol(originalText) && indented && !endsWithEol(indented) ? `${indented}${eol}` : indented;
}

/**
 * LLM code blocks are commonly returned with their own indentation baseline
 * (or with no indentation at all). Rebase that baseline on the line being
 * replaced so a nested block remains valid in the surrounding syntax.
 */
function alignReplacementIndent(
  operation: Exclude<LineChangeOperation, "create_file">,
  code: string,
  originalText: string,
  baseText: string,
  insertionOffset: number,
  eol: string,
): string {
  const targetIndent = operation === "insert_after" && !originalText.trim()
    ? indentationBefore(baseText, insertionOffset)
    : indentationAt(baseText, insertionOffset) || firstNonBlankIndent(originalText);
  const dedented = dedentCommonIndent(code);
  if (!targetIndent || !dedented) return dedented;
  return dedented
    .split(eol)
    .map((line) => line.trim() ? `${targetIndent}${line}` : line)
    .join(eol);
}

function dedentCommonIndent(content: string): string {
  const eol = content.match(/\r\n|\r|\n/)?.[0] ?? "\n";
  const lines = content.split(/\r\n|\r|\n/);
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => (line.match(/^[ \t]*/) ?? [""])[0].length);
  const common = indents.length > 0 ? Math.min(...indents) : 0;
  if (common === 0) return content;
  return lines.map((line) => line.trim() ? line.slice(common) : line).join(eol);
}

function indentationAt(content: string, offset: number): string {
  const safeOffset = Math.max(0, Math.min(offset, content.length));
  const lineStart = Math.max(content.lastIndexOf("\n", safeOffset - 1), content.lastIndexOf("\r", safeOffset - 1)) + 1;
  const line = content.slice(lineStart, safeOffset);
  return (line.match(/^[ \t]*/) ?? [""])[0];
}

function indentationBefore(content: string, offset: number): string {
  const safeOffset = Math.max(0, Math.min(offset, content.length));
  const lineEnd = safeOffset > 0 && /\r|\n/.test(content[safeOffset - 1]) ? safeOffset - 1 : safeOffset;
  const lineEndWithoutBreak = lineEnd > 0 && content[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
  const lineStart = Math.max(content.lastIndexOf("\n", lineEndWithoutBreak - 1), content.lastIndexOf("\r", lineEndWithoutBreak - 1)) + 1;
  const line = content.slice(lineStart, lineEndWithoutBreak);
  return (line.match(/^[ \t]*/) ?? [""])[0];
}

function firstNonBlankIndent(content: string): string {
  for (const line of content.split(/\r\n|\r|\n/)) {
    if (line.trim()) return (line.match(/^[ \t]*/) ?? [""])[0];
  }
  return "";
}

function adaptEol(content: string, eol: string): string {
  return content.replace(/\r\n|\r|\n/g, eol);
}

function endsWithEol(content: string): boolean {
  return /(?:\r\n|\r|\n)$/.test(content);
}

function ensureTrailingEol(content: string, eol: string): string {
  return content && !endsWithEol(content) ? `${content}${eol}` : content;
}
