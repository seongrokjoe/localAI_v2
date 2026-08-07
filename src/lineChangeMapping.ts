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
  if (operation === "create_file") return adapted;
  if (operation === "insert_before") return ensureTrailingEol(adapted, eol);
  if (operation === "insert_after") {
    return insertionOffset === baseText.length && !endsWithEol(baseText)
      ? `${eol}${adapted}`
      : ensureTrailingEol(adapted, eol);
  }
  return endsWithEol(originalText) && adapted && !endsWithEol(adapted) ? `${adapted}${eol}` : adapted;
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
