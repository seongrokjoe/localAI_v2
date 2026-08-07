import { WorkspacePatchChange } from "./types";

export interface ParsedPatchResponse {
  message: string;
  changes: WorkspacePatchChange[];
  issues: string[];
}

export interface ParsedTargetResponse {
  message: string;
  targetPaths: string[];
  issues: string[];
}

export function parsePatchResponse(content: string, expectedPath?: string): ParsedPatchResponse {
  const parsed = parseJsonObject(content);
  if (!parsed.value) {
    return { message: "", changes: [], issues: [parsed.error ?? "응답이 JSON 객체가 아닙니다."] };
  }

  const changeArray = Array.isArray(parsed.value.changes)
    ? parsed.value.changes
    : Array.isArray(parsed.value.edits)
      ? parsed.value.edits
      : undefined;
  const rawChanges = changeArray ? expandChanges(changeArray) : [];
  const issues: string[] = [];
  if (!changeArray) {
    issues.push("changes 또는 edits 배열이 없습니다.");
  }

  const changes: WorkspacePatchChange[] = [];
  rawChanges.forEach((raw, index) => {
    const normalized = normalizePatchChange(raw, expectedPath);
    if (normalized.change) {
      changes.push(normalized.change);
    } else {
      issues.push(`changes[${index}]: ${normalized.error}`);
    }
  });

  return {
    message: typeof parsed.value.message === "string" ? parsed.value.message.trim() : "",
    changes,
    issues,
  };
}

export function parseTargetResponse(content: string): ParsedTargetResponse {
  const parsed = parseJsonObject(content);
  if (!parsed.value) {
    return { message: "", targetPaths: [], issues: [parsed.error ?? "응답이 JSON 객체가 아닙니다."] };
  }

  const rawPaths = Array.isArray(parsed.value.targetPaths)
    ? parsed.value.targetPaths
    : Array.isArray(parsed.value.paths)
      ? parsed.value.paths
      : Array.isArray(parsed.value.files)
        ? parsed.value.files
      : [];
  const targetPaths = [
    ...new Set(
      rawPaths
        .map((value) =>
          typeof value === "string"
            ? value
            : value && typeof value === "object" && !Array.isArray(value)
              ? stringValue((value as Record<string, unknown>).path, (value as Record<string, unknown>).filePath, (value as Record<string, unknown>).file)
              : undefined,
        )
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  const issues = targetPaths.length === 0 ? ["targetPaths 배열에 유효한 파일 경로가 없습니다."] : [];
  return {
    message: typeof parsed.value.message === "string" ? parsed.value.message.trim() : "",
    targetPaths,
    issues,
  };
}

function normalizePatchChange(raw: unknown, expectedPath?: string): { change?: WorkspacePatchChange; error?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "변경 항목이 JSON 객체가 아닙니다." };
  }
  const value = raw as Record<string, unknown>;
  const path = stringValue(value.path, value.filePath, value.file) || expectedPath || "";
  if (!path) {
    return { error: "path가 없습니다." };
  }

  const originalText = stringValue(value.originalText, value.oldText, value.oldCode, value.originalCode, value.originalContent, value.search, value.before);
  const replacementText = stringValue(
    value.replacementText,
    value.newText,
    value.newCode,
    value.modifiedCode,
    value.modifiedContent,
    value.replace,
    value.after,
  );
  const fullContent = stringValue(value.fullContent, value.newContent, value.updatedContent, value.content);
  const description = stringValue(value.description, value.summary);
  const startLine = integerValue(value.startLine, value.lineStart, value.fromLine);
  const endLine = integerValue(value.endLine, value.lineEnd, value.toLine);
  const startAnchor = stringValue(value.startAnchor, value.firstLine, value.beforeAnchor);
  const endAnchor = stringValue(value.endAnchor, value.lastLine, value.afterAnchor);

  const hasRangeField = startLine !== undefined || endLine !== undefined || startAnchor !== undefined || endAnchor !== undefined;
  if (hasRangeField) {
    if (startLine === undefined || endLine === undefined) {
      return { error: "줄 범위 변경에는 startLine과 endLine이 모두 필요합니다." };
    }
    if (startLine < 1 || endLine < startLine) {
      return { error: "줄 범위는 1부터 시작하며 endLine은 startLine보다 작을 수 없습니다." };
    }
    if (!startAnchor?.trim() || !endAnchor?.trim()) {
      return { error: "줄 범위 변경에는 비어 있지 않은 startAnchor와 endAnchor가 필요합니다." };
    }
    if (replacementText === undefined) {
      return { error: "줄 범위 변경에는 replacementText가 필요합니다." };
    }
    return {
      change: { path, startLine, endLine, startAnchor, endAnchor, replacementText, description },
    };
  }

  if (originalText !== undefined && replacementText !== undefined) {
    return { change: { path, originalText, replacementText, description } };
  }
  if (fullContent !== undefined) {
    return {
      change: {
        path,
        fullContent,
        createIfMissing: value.createIfMissing === true,
        description,
      },
    };
  }
  if (replacementText !== undefined) {
    return { error: "수정 코드는 있지만 originalText가 없습니다." };
  }
  return { error: "originalText/replacementText 또는 fullContent가 없습니다." };
}

function expandChanges(changes: unknown[]): unknown[] {
  const expanded: unknown[] = [];
  for (const raw of changes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      expanded.push(raw);
      continue;
    }
    const value = raw as Record<string, unknown>;
    if (!Array.isArray(value.edits)) {
      expanded.push(raw);
      continue;
    }
    const parentPath = stringValue(value.path, value.filePath, value.file);
    for (const edit of value.edits) {
      expanded.push(edit && typeof edit === "object" && !Array.isArray(edit) ? { path: parentPath, ...(edit as Record<string, unknown>) } : edit);
    }
  }
  return expanded;
}

function parseJsonObject(content: string): { value?: Record<string, unknown>; error?: string } {
  const fenced = content.match(/```json\s*([\s\S]*?)```/i);
  const raw = fenced?.[1] ?? content.trim();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "응답 최상위 값이 JSON 객체가 아닙니다." };
    }
    return { value: parsed as Record<string, unknown> };
  } catch (error) {
    return { error: `JSON 파싱 실패: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function integerValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value)) {
      return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      return Number(value);
    }
  }
  return undefined;
}
