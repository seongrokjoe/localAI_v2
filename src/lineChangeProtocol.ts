import { LineChangeOperation, LineMappedChange } from "./types";

export interface ProtocolParseResult {
  changes: LineMappedChange[];
  issues: string[];
}

const operations = new Set<LineChangeOperation>(["replace", "insert_before", "insert_after", "create_file"]);

export function parseLineChangeResponse(content: string, expectedProtocolId: string): ProtocolParseResult {
  const changes: LineMappedChange[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  const blockPattern = /<<<CCA_CHANGE_BEGIN:([A-Z0-9]+)>>>\s*\r?\n([\s\S]*?)<<<CCA_CHANGE_END:\1>>>/g;
  let matchedBlock = false;

  for (const match of content.matchAll(blockPattern)) {
    matchedBlock = true;
    const protocolId = match[1];
    const body = match[2];
    if (protocolId !== expectedProtocolId) {
      issues.push(`응답 protocolId가 다릅니다: ${protocolId}`);
      continue;
    }
    const code = extractMarkedSection(body, `CCA_CODE_BEGIN:${protocolId}`, `CCA_CODE_END:${protocolId}`);
    if (code === undefined) {
      issues.push("변경 블록에 CCA_CODE_BEGIN/END 플래그가 없습니다.");
      continue;
    }
    const description = extractMarkedSection(body, `CCA_DESCRIPTION_BEGIN:${protocolId}`, `CCA_DESCRIPTION_END:${protocolId}`)?.trim();
    const metadataText = body.split(`<<<CCA_DESCRIPTION_BEGIN:${protocolId}>>>`)[0].split(`<<<CCA_CODE_BEGIN:${protocolId}>>>`)[0];
    const metadata = parseMetadata(metadataText);
    const id = metadata.get("id") || `change-${changes.length + 1}`;
    const fileId = metadata.get("file") || "";
    const snapshot = metadata.get("snapshot") || "";
    const operationText = metadata.get("operation") as LineChangeOperation | undefined;
    const startLine = parseLine(metadata.get("startLine"));
    const endLine = parseLine(metadata.get("endLine"));
    const path = metadata.get("path");
    const errors: string[] = [];

    if (!fileId) errors.push("file이 없습니다.");
    if (!snapshot) errors.push("snapshot이 없습니다.");
    if (!operationText || !operations.has(operationText)) errors.push(`operation이 올바르지 않습니다: ${operationText ?? "없음"}`);
    if (operationText === "create_file") {
      if (!path) errors.push("create_file에는 path가 필요합니다.");
      if (fileId !== "NEW") errors.push("create_file의 file은 NEW여야 합니다.");
    } else {
      if (startLine === undefined || endLine === undefined || startLine < 1 || endLine < startLine) {
        errors.push("startLine/endLine 범위가 올바르지 않습니다.");
      }
    }

    const change: LineMappedChange = {
      id,
      protocolId,
      fileId,
      snapshot,
      operation: operationText && operations.has(operationText) ? operationText : "replace",
      path,
      startLine: startLine ?? 0,
      endLine: endLine ?? 0,
      description,
      code,
      mappingError: errors.length > 0 ? errors.join(" ") : undefined,
    };
    const key = `${change.fileId}\u0000${change.snapshot}\u0000${change.operation}\u0000${change.startLine}\u0000${change.endLine}\u0000${change.path ?? ""}\u0000${change.code}`;
    if (!seen.has(key)) {
      seen.add(key);
      changes.push(change);
    }
    issues.push(...errors.map((error) => `${id}: ${error}`));
  }

  if (!matchedBlock) {
    const fallback = extractLooseCode(content, expectedProtocolId);
    if (fallback !== undefined) {
      changes.push({
        id: "unmapped-1",
        protocolId: expectedProtocolId,
        fileId: "",
        snapshot: "",
        operation: "replace",
        startLine: 0,
        endLine: 0,
        code: fallback,
        mappingError: "완전한 CCA_CHANGE 플래그를 찾지 못했습니다. 대상 범위를 직접 연결하세요.",
      });
      issues.push("완전한 CCA_CHANGE 플래그 없이 코드 본문만 복구했습니다.");
    } else if (content.trim()) {
      issues.push("응답에서 CCA 변경 블록을 찾지 못했습니다.");
    }
  }

  return { changes, issues };
}

export function renderNumberedFile(snapshot: { id: string; path: string; snapshot: string; text: string; lineCount: number }, startLine = 1, endLine = snapshot.lineCount): string {
  const lines = snapshot.text.split(/\r\n|\r|\n/);
  const first = Math.max(1, startLine);
  const last = Math.min(lines.length, endLine);
  const numbered = lines.slice(first - 1, last).map((line, index) => `${String(first + index).padStart(6, "0")}|${line}`).join("\n");
  return [
    `<CCA_FILE id="${snapshot.id}" path="${escapeAttribute(snapshot.path)}" snapshot="${snapshot.snapshot}" lineCount="${snapshot.lineCount}" startLine="${first}" endLine="${last}">`,
    numbered,
    "</CCA_FILE>",
  ].join("\n");
}

function extractMarkedSection(content: string, beginName: string, endName: string): string | undefined {
  const begin = `<<<${beginName}>>>`;
  const end = `<<<${endName}>>>`;
  const start = content.indexOf(begin);
  if (start < 0) return undefined;
  const bodyStart = start + begin.length;
  const finish = content.indexOf(end, bodyStart);
  if (finish < 0) return undefined;
  return content.slice(bodyStart, finish).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

function extractLooseCode(content: string, protocolId: string): string | undefined {
  return extractMarkedSection(content, `CCA_CODE_BEGIN:${protocolId}`, `CCA_CODE_END:${protocolId}`);
}

function parseMetadata(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line.trim());
    if (match) values.set(match[1], match[2].trim());
  }
  return values;
}

function parseLine(value: string | undefined): number | undefined {
  return value && /^\d+$/.test(value) ? Number(value) : undefined;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
