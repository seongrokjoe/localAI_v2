import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  AgentMode,
  ChatToolDefinition,
  FileSnapshotChange,
  PatchApplyOutcome,
  PatchTargetResult,
  WorkspacePatchChange,
} from "./types";
import { assertSafePathSegment } from "./security";
import { decodeText, detectTextEncoding, encodeText, encodingForNewFile, TextEncodingInfo } from "./textEncoding";
import { applyLineRangeChanges, findOriginalTextMatch, isLineRangeChange } from "./patchText";

const excludeGlob = "**/{.git,node_modules,dist,out,build,.company-code-ai,.vscode-test}/**";

interface TextFileState {
  exists: boolean;
  text: string;
  eol: string;
  isDirty: boolean;
  bytes?: Uint8Array;
  encoding: TextEncodingInfo;
}

interface PatchInput {
  changes?: WorkspacePatchChange[];
}

interface PreparedPatch {
  edit: vscode.WorkspaceEdit;
  snapshots: FileSnapshotChange[];
  targets: PreparedPatchTarget[];
  labels: string;
  count: number;
}

interface PreparedPatchTarget {
  path: string;
  uri: vscode.Uri;
  before: string;
  after: string;
  existed: boolean;
  beforeBytes?: Uint8Array;
  encoding: TextEncodingInfo;
}

export class WorkspaceTools {
  private activeScope?: string;
  private lastOutcome?: PatchApplyOutcome;
  private lastDiagnostics: string[] = [];

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly onChangeSet?: (mode: AgentMode, changes: FileSnapshotChange[]) => Promise<void>,
  ) {}

  get lastPatchOutcome(): PatchApplyOutcome | undefined {
    return this.lastOutcome;
  }

  showLastPatchDiagnostics(): void {
    this.output.show(true);
    if (this.lastDiagnostics.length === 0) {
      this.output.appendLine("[패치 진단] 아직 기록된 패치 적용 시도가 없습니다.");
    }
  }

  setActiveScope(scope: string | undefined): void {
    this.activeScope = scope;
  }

  definitionsForMode(mode: AgentMode, allowWrite = false): ChatToolDefinition[] {
    return mode === "plan" || !allowWrite
      ? this.definitions.filter((tool) => tool.function.name !== "applyPatchAfterUserApproval")
      : this.definitions;
  }

  private readonly definitions: ChatToolDefinition[] = [
    {
      type: "function",
      function: {
        name: "listFiles",
        description: "glob 패턴으로 워크스페이스 파일 목록을 조회합니다. 읽기 전용입니다.",
        parameters: {
          type: "object",
          properties: {
            glob: { type: "string", description: "glob 패턴입니다. 기본값은 **/*입니다." },
            maxResults: { type: "number", description: "최대 파일 수입니다. 기본값은 200입니다." },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "readFile",
        description: "워크스페이스 파일 하나를 읽습니다. 읽기 전용이며 워크스페이스 밖은 읽을 수 없습니다.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "워크스페이스 기준 상대 경로입니다." },
            maxChars: { type: "number", description: "반환할 최대 문자 수입니다. 기본값은 40000입니다." },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "searchWorkspace",
        description: "워크스페이스 파일에서 텍스트를 검색합니다. 읽기 전용입니다.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "그대로 검색할 텍스트입니다." },
            maxResults: { type: "number", description: "최대 검색 결과 수입니다. 기본값은 40입니다." },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "getGitDiff",
        description: "현재 워크스페이스의 Git diff를 읽습니다. 고정된 읽기 전용 Git 명령입니다.",
        parameters: {
          type: "object",
          properties: {
            maxChars: { type: "number", description: "반환할 최대 문자 수입니다. 기본값은 60000입니다." },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "proposePatch",
        description: "패치를 적용하지 않고 구조화된 패치 제안만 반환합니다.",
        parameters: {
          type: "object",
          properties: {
            summary: { type: "string" },
            changes: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  description: { type: "string" },
                },
                required: ["path", "description"],
                additionalProperties: false,
              },
            },
          },
          required: ["summary", "changes"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "applyPatchAfterUserApproval",
        description: "VS Code 승인 프롬프트에서 사용자가 명시적으로 승인한 뒤 정확한 워크스페이스 수정만 적용합니다.",
        parameters: {
          type: "object",
          properties: {
            changes: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  fullContent: { type: "string" },
                  originalText: { type: "string" },
                  replacementText: { type: "string" },
                  startLine: { type: "number" },
                  endLine: { type: "number" },
                  startAnchor: { type: "string" },
                  endAnchor: { type: "string" },
                  createIfMissing: { type: "boolean" },
                  description: { type: "string" },
                },
                required: ["path"],
                additionalProperties: false,
              },
            },
          },
          required: ["changes"],
          additionalProperties: false,
        },
      },
    },
  ];

  async executeTool(name: string, rawArgs: string, mode: AgentMode): Promise<string> {
    if (mode === "plan" && name === "applyPatchAfterUserApproval") {
      throw new Error("PlanMode에서는 파일 수정이 허용되지 않습니다. 계획을 승인한 뒤 ImplementMode로 전환하세요.");
    }
    const args = parseArgs(rawArgs);
    switch (name) {
      case "listFiles":
        return JSON.stringify(await this.listFiles(String(args.glob ?? "**/*"), numberOr(args.maxResults, 200)));
      case "readFile":
        return await this.readFile(String(args.path ?? ""), numberOr(args.maxChars, 40000));
      case "searchWorkspace":
        return JSON.stringify(await this.searchWorkspace(String(args.query ?? ""), numberOr(args.maxResults, 40)));
      case "getGitDiff":
        return await this.getGitDiff(numberOr(args.maxChars, 60000));
      case "proposePatch":
        return JSON.stringify(args);
      case "applyPatchAfterUserApproval": {
        const outcome = await this.applyPatchAfterUserApproval(args, mode);
        return formatPatchApplyOutcome(outcome);
      }
      default:
        throw new Error(`알 수 없는 도구입니다: '${name}'.`);
    }
  }

  async listFiles(glob = "**/*", maxResults = 200): Promise<string[]> {
    const scopedGlob = this.applyActiveScope(glob);
    const files = await vscode.workspace.findFiles(scopedGlob, excludeGlob, maxResults);
    return files.map(workspaceRelativePath).sort();
  }

  async readFile(relativePath: string, maxChars = 40000): Promise<string> {
    const uri = this.resolveWorkspacePath(relativePath);
    const document = await vscode.workspace.openTextDocument(uri);
    const text = document.getText();
    if (text.length <= maxChars) {
      return text;
    }
    return `${text.slice(0, maxChars)}\n[truncated]`;
  }

  async readFileExact(relativePath: string): Promise<string> {
    const uri = this.resolveWorkspacePath(relativePath);
    const document = await vscode.workspace.openTextDocument(uri);
    return document.getText();
  }

  async fileExists(relativePath: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(this.resolveWorkspacePath(relativePath));
      return true;
    } catch {
      return false;
    }
  }

  async validatePatch(
    changes: WorkspacePatchChange[],
  ): Promise<{ valid: boolean; message: string; count: number; preview?: string }> {
    this.beginPatchDiagnostics("패치 검증");
    try {
      const prepared = await this.preparePatch({ changes });
      this.appendPatchDiagnostic(`검증 성공: ${prepared.labels}`);
      return {
        valid: true,
        message: `검증 완료: ${prepared.labels}`,
        count: prepared.count,
        preview: renderPatchPreview(prepared),
      };
    } catch (error) {
      const message = errorMessage(error);
      this.appendPatchDiagnostic(`검증 실패: ${message}`);
      return { valid: false, message, count: 0 };
    }
  }

  async searchWorkspace(query: string, maxResults = 40): Promise<Array<{ path: string; line: number; preview: string }>> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const results: Array<{ path: string; line: number; preview: string }> = [];
    const needle = trimmed.toLowerCase();
    const files = await this.listFiles("**/*", 1500);

    for (const file of files) {
      if (results.length >= maxResults) {
        break;
      }

      let content = "";
      try {
        content = await this.readFile(file, 200000);
      } catch {
        continue;
      }
      if (content.includes("\0")) {
        continue;
      }

      const haystack = content.toLowerCase();
      let offset = 0;
      for (;;) {
        if (results.length >= maxResults) {
          break;
        }
        const index = haystack.indexOf(needle, offset);
        if (index === -1) {
          break;
        }
        const line = lineNumberAt(content, index);
        results.push({
          path: file,
          line,
          preview: linePreviewAt(content, index),
        });
        offset = index + needle.length;
      }
    }

    return results;
  }

  async getGitDiff(maxChars = 60000): Promise<string> {
    const root = getWorkspaceRoot();
    return new Promise((resolve) => {
      const child = spawn("git", ["diff", "--no-ext-diff", "--"], {
        cwd: root.fsPath,
        shell: false,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", () => resolve(""));
      child.on("close", (code) => {
        if (code !== 0) {
          resolve(stderr.trim() ? `[git diff unavailable]\n${stderr.trim()}` : "");
          return;
        }
        resolve(stdout.length > maxChars ? `${stdout.slice(0, maxChars)}\n[truncated]` : stdout);
      });
    });
  }

  async applyPatchAfterUserApproval(rawArgs: unknown, mode: AgentMode): Promise<PatchApplyOutcome> {
    assertPatchAllowed(mode);
    this.beginPatchDiagnostics();
    try {
      const prepared = await this.preparePatch(rawArgs);
      const approved = await vscode.window.showWarningMessage(
        `워크스페이스 변경 ${prepared.count}개를 적용할까요? ${prepared.labels}`,
        { modal: true },
        "적용",
      );
      if (approved !== "적용") {
        return this.finishPatchOutcome(notAppliedOutcome("사용자가 패치 적용을 취소했습니다. 파일은 변경되지 않았습니다."));
      }
      return await this.applyPreparedPatch(prepared, mode);
    } catch (error) {
      return this.finishPatchOutcome(failedOutcome(errorMessage(error)));
    }
  }

  async applyPatchWithPriorApproval(rawArgs: unknown, mode: AgentMode): Promise<PatchApplyOutcome> {
    assertPatchAllowed(mode);
    this.beginPatchDiagnostics();
    try {
      return await this.applyPreparedPatch(await this.preparePatch(rawArgs), mode);
    } catch (error) {
      return this.finishPatchOutcome(failedOutcome(errorMessage(error)));
    }
  }

  private async preparePatch(rawArgs: unknown): Promise<PreparedPatch> {
    const args = rawArgs as PatchInput;
    const changes = args.changes ?? [];
    if (changes.length === 0) {
      throw new Error("제공된 변경이 없습니다.");
    }

    const edit = new vscode.WorkspaceEdit();
    const snapshots: FileSnapshotChange[] = [];
    const targets: PreparedPatchTarget[] = [];
    const grouped = new Map<string, WorkspacePatchChange[]>();
    for (const change of changes) {
      const relativePath = String(change.path ?? "").trim();
      if (!relativePath) {
        throw new Error("변경 대상 path가 비어 있습니다.");
      }
      const fileChanges = grouped.get(relativePath) ?? [];
      fileChanges.push(change);
      grouped.set(relativePath, fileChanges);
    }

    for (const [relativePath, fileChanges] of grouped) {
      const uri = this.resolveWorkspacePath(relativePath);
      this.appendPatchDiagnostic(`검증 경로: ${relativePath} -> ${uri.scheme === "file" ? uri.fsPath : uri.toString(true)}`);
      const state = await readTextFileState(uri);
      const current = state.text;
      const exists = state.exists;
      if (exists && state.isDirty) {
        throw new Error(`${relativePath} 파일에 저장되지 않은 변경이 있습니다. 먼저 저장한 뒤 다시 적용하세요.`);
      }

      let after = current;
      const descriptions: string[] = [];
      const lineRangeChanges = fileChanges.filter(isLineRangeChange);
      if (lineRangeChanges.length > 0) {
        if (lineRangeChanges.length !== fileChanges.length) {
          throw new Error(`${relativePath}에서 줄 범위 변경과 다른 패치 형식을 함께 사용할 수 없습니다.`);
        }
        if (!exists) {
          throw new Error(`${relativePath} 파일이 없습니다.`);
        }
        const expectedHashes = new Set(lineRangeChanges.map((change) => change.expectedFileHash).filter(Boolean));
        if (expectedHashes.size > 1) {
          throw new Error(`${relativePath}의 줄 범위 변경에 서로 다른 파일 기준 해시가 포함되어 있습니다.`);
        }
        const expectedHash = [...expectedHashes][0];
        if (expectedHash && expectedHash !== hashText(current)) {
          throw new Error(`${relativePath} 파일이 패치 검증 이후 변경되었습니다. 변경안을 다시 생성하세요.`);
        }
        for (const change of lineRangeChanges) {
          if (change.description?.trim()) {
            descriptions.push(change.description.trim());
          }
        }
        after = applyLineRangeChanges(current, state.eol, lineRangeChanges);
      } else for (const change of fileChanges) {
        if (change.description?.trim()) {
          descriptions.push(change.description.trim());
        }

        if (typeof change.fullContent === "string") {
          if (!exists && !change.createIfMissing) {
            throw new Error(`${relativePath} 파일이 없습니다. 새로 만들려면 createIfMissing을 true로 설정하세요.`);
          }
          if (fileChanges.length > 1) {
            throw new Error(`${relativePath}의 fullContent 변경은 다른 변경과 함께 사용할 수 없습니다.`);
          }
          after = exists ? adaptLineEndings(change.fullContent, state.eol) : change.fullContent;
          continue;
        }

        if (typeof change.originalText === "string" && typeof change.replacementText === "string") {
          if (!exists) {
            throw new Error(`${relativePath} 파일이 없습니다.`);
          }
          const match = findOriginalTextMatch(after, change.originalText, state.eol);
          if (!match) {
            throw new Error(`${relativePath}에서 originalText를 찾지 못했습니다.`);
          }
          if (match.occurrences !== 1) {
            throw new Error(`${relativePath}에서 originalText가 ${match.occurrences}곳에 발견됐습니다. 한 곳만 식별되도록 더 넓은 원문이 필요합니다.`);
          }
          if (match.method === "whitespace-normalized") {
            this.appendPatchDiagnostic(`${relativePath}: 공백 정규화 후 originalText 위치를 한 곳으로 확인했습니다.`);
          }
          const replacement = adaptLineEndings(change.replacementText, state.eol);
          after = after.replace(match.text, replacement);
          continue;
        }

        throw new Error(`${relativePath}에는 fullContent 또는 originalText/replacementText가 필요합니다.`);
      }

      if (after === current) {
        continue;
      }
      replaceWholeDocument(edit, uri, exists ? current : "", after);
      snapshots.push({
        path: relativePath,
        before: exists ? current : "",
        after,
        description: descriptions.length > 0 ? descriptions.join("; ") : undefined,
      });
      targets.push({
        path: relativePath,
        uri,
        before: exists ? current : "",
        after,
        existed: exists,
        beforeBytes: state.bytes,
        encoding: state.encoding,
      });
    }

    if (targets.length === 0) {
      throw new Error("실제 변경된 파일이 없습니다. 제안된 변경이 현재 파일 내용과 동일합니다.");
    }

    return {
      edit,
      snapshots,
      targets,
      labels: targets.map((target) => target.path).join(", "),
      count: targets.length,
    };
  }

  private async applyPreparedPatch(prepared: PreparedPatch, mode: AgentMode): Promise<PatchApplyOutcome> {
    try {
      this.appendPatchDiagnostic(`워크스페이스 편집 시작: ${prepared.labels}`);
      const ok = await vscode.workspace.applyEdit(prepared.edit);
      if (!ok) {
        return this.finishPatchOutcome(failedOutcome("VS Code가 워크스페이스 편집을 거부했습니다."));
      }

      const targetResults: PatchTargetResult[] = [];
      for (const target of prepared.targets) {
        const absolutePath = target.uri.scheme === "file" ? target.uri.fsPath : target.uri.toString(true);
        const expectedBytes = encodeText(target.after, target.encoding);
        const beforeHash = target.beforeBytes ? hashBytes(target.beforeBytes) : undefined;
        this.appendPatchDiagnostic(`대상: ${target.path}`);
        this.appendPatchDiagnostic(`실제 경로: ${absolutePath}`);
        this.appendPatchDiagnostic(`인코딩: ${target.encoding.name}${target.encoding.addBom ? " + BOM" : ""}`);

        const document = await vscode.workspace.openTextDocument(target.uri);
        if (document.getText() !== target.after) {
          throw new Error(`${target.path} 파일에 패치가 예상대로 반영되지 않았습니다.`);
        }

        let saveMethod: PatchTargetResult["saveMethod"] = "vscode";
        let saved = true;
        if (document.isDirty) {
          saved = await document.save();
          this.appendPatchDiagnostic(`VS Code 저장 결과: ${saved ? "성공" : "실패"}`);
        }
        if (document.getText() !== target.after) {
          throw new Error(`${target.path} 파일이 저장 과정에서 포맷터나 다른 확장에 의해 변경되었습니다.`);
        }

        let diskBytes = await tryReadBytes(target.uri);
        if (!saved || !diskBytes || !bytesEqual(diskBytes, expectedBytes)) {
          saveMethod = "direct";
          this.appendPatchDiagnostic("디스크 내용이 예상과 달라 workspace.fs.writeFile 직접 저장을 시작합니다.");
          await vscode.workspace.fs.writeFile(target.uri, expectedBytes);
          diskBytes = await tryReadBytes(target.uri);
        }

        if (!diskBytes || !bytesEqual(diskBytes, expectedBytes)) {
          throw new Error(`${target.path} 파일을 직접 저장한 뒤에도 디스크 내용이 예상과 다릅니다.`);
        }
        if (decodeText(diskBytes, target.encoding) !== target.after) {
          throw new Error(`${target.path} 파일 저장 후 텍스트를 원래 인코딩으로 검증하지 못했습니다.`);
        }

        const afterHash = hashBytes(diskBytes);
        if (target.existed && beforeHash === afterHash) {
          throw new Error(`${target.path} 파일의 디스크 해시가 변경되지 않았습니다.`);
        }
        this.appendPatchDiagnostic(`저장 방식: ${saveMethod === "direct" ? "직접 저장" : "VS Code 저장"}`);
        this.appendPatchDiagnostic(`해시: ${beforeHash ?? "새 파일"} -> ${afterHash}`);
        targetResults.push({
          path: target.path,
          absolutePath,
          encoding: `${target.encoding.name}${target.encoding.addBom ? " + BOM" : ""}`,
          saveMethod,
          beforeHash,
          afterHash,
        });
      }

      let snapshotWarning = "";
      if (prepared.snapshots.length > 0) {
        try {
          await this.onChangeSet?.(mode, prepared.snapshots);
        } catch (error) {
          snapshotWarning = ` 변경 스냅샷 기록은 실패했습니다: ${errorMessage(error)}`;
          this.appendPatchDiagnostic(snapshotWarning.trim());
        }
      }

      return this.finishPatchOutcome({
        status: "applied",
        message: `실제 파일 ${targetResults.length}개의 디스크 저장과 검증을 완료했습니다.${snapshotWarning}`,
        targets: targetResults,
      });
    } catch (error) {
      return this.finishPatchOutcome(failedOutcome(errorMessage(error)));
    }
  }

  resolveWorkspacePath(input: string): vscode.Uri {
    assertSafePathSegment(input);
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      throw new Error("워크스페이스 도구를 사용하려면 먼저 워크스페이스 폴더를 여세요.");
    }

    if (path.isAbsolute(input)) {
      const fsPath = path.normalize(input);
      const folder = folders.find((candidate) => isPathInside(candidate.uri.fsPath, fsPath));
      if (!folder) {
        throw new Error(`경로가 열린 워크스페이스 밖에 있습니다: ${input}`);
      }
      return vscode.Uri.file(fsPath);
    }

    const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "");
    const segments = normalized.split("/").filter(Boolean);
    if (segments.includes("..")) {
      throw new Error(`경로가 열린 워크스페이스 밖을 가리킵니다: ${input}`);
    }
    if (folders.length === 1) {
      return vscode.Uri.joinPath(folders[0].uri, ...segments);
    }

    const matchedFolder = folders.find((folder) => normalized.toLowerCase().startsWith(`${folder.name.toLowerCase()}/`));
    if (!matchedFolder) {
      throw new Error(`다중 루트 워크스페이스의 경로에는 워크스페이스 폴더 이름이 필요합니다: ${input}`);
    }
    const relative = normalized.slice(matchedFolder.name.length + 1);
    return vscode.Uri.joinPath(matchedFolder.uri, ...relative.split("/").filter(Boolean));
  }

  private beginPatchDiagnostics(phase = "패치 적용"): void {
    this.lastOutcome = undefined;
    this.lastDiagnostics = [`[패치 진단 ${new Date().toISOString()}]`, `단계: ${phase}`];
    const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString(true)).join(", ");
    this.appendPatchDiagnostic(`열린 워크스페이스: ${roots || "없음"}`);
    this.appendPatchDiagnostic(`활성 스코프: ${this.activeScope ?? "전체 워크스페이스"}`);
  }

  private appendPatchDiagnostic(message: string): void {
    this.lastDiagnostics.push(message);
    this.output.appendLine(`[패치 진단] ${message}`);
  }

  private finishPatchOutcome(outcome: PatchApplyOutcome): PatchApplyOutcome {
    this.lastOutcome = outcome;
    this.appendPatchDiagnostic(`최종 상태: ${outcome.status} - ${outcome.message}`);
    return outcome;
  }

  private applyActiveScope(glob: string): string {
    if (!this.activeScope) {
      return glob;
    }
    const normalized = this.activeScope.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!normalized) {
      return glob;
    }
    if (isProjectOrSolutionPath(normalized)) {
      const slash = normalized.lastIndexOf("/");
      const folder = slash === -1 ? "" : normalized.slice(0, slash);
      return folder ? `${folder}/${glob}` : glob;
    }
    return `${normalized}/${glob}`;
  }
}

function getWorkspaceRoot(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("워크스페이스 도구를 사용하려면 먼저 워크스페이스 폴더를 여세요.");
  }
  return folder.uri;
}

function parseArgs(rawArgs: string): Record<string, unknown> {
  if (!rawArgs.trim()) {
    return {};
  }
  const parsed = JSON.parse(rawArgs) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("도구 인자는 JSON 객체여야 합니다.");
  }
  return parsed as Record<string, unknown>;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function assertPatchAllowed(mode: AgentMode): void {
  if (mode === "plan") {
    throw new Error("PlanMode에서는 파일 수정이 허용되지 않습니다. 계획을 승인한 뒤 ImplementMode로 전환하세요.");
  }
}

function isProjectOrSolutionPath(normalizedPath: string): boolean {
  return /\.(slnx?|csproj|vcxproj|vbproj|fsproj|sqlproj|wixproj|proj)$/i.test(normalizedPath);
}

function replaceWholeDocument(edit: vscode.WorkspaceEdit, uri: vscode.Uri, current: string, next: string): void {
  if (!current) {
    edit.createFile(uri, { ignoreIfExists: true });
    edit.insert(uri, new vscode.Position(0, 0), next);
    return;
  }
  const lineCount = current.split(/\r\n|\r|\n/).length;
  edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lineCount, 0)), next);
}

async function readTextFileState(uri: vscode.Uri): Promise<TextFileState> {
  const configuredEncoding = vscode.workspace.getConfiguration("files", uri).get<string>("encoding", "utf8");
  try {
    await vscode.workspace.fs.stat(uri);
  } catch (error) {
    if (!isFileNotFound(error)) {
      throw error;
    }
    return {
      exists: false,
      text: "",
      eol: "\n",
      isDirty: false,
      encoding: encodingForNewFile(configuredEncoding),
    };
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  const document = await vscode.workspace.openTextDocument(uri);
  return {
    exists: true,
    text: document.getText(),
    eol: documentLineEnding(document),
    isDirty: document.isDirty,
    bytes,
    encoding: detectTextEncoding(bytes, document.getText(), configuredEncoding),
  };
}

function documentLineEnding(document: vscode.TextDocument): string {
  return document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
}

function adaptLineEndings(text: string, eol: string): string {
  return text.replace(/\r\n|\r|\n/g, eol);
}

function renderPatchPreview(prepared: PreparedPatch, maxChars = 16000): string {
  const sections: string[] = [];
  for (const target of prepared.targets) {
    const snapshot = prepared.snapshots.find((candidate) => candidate.path === target.path);
    if (!snapshot) {
      continue;
    }
    const beforeLines = splitPreviewLines(snapshot.before);
    const afterLines = splitPreviewLines(snapshot.after);
    let prefix = 0;
    while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
      prefix++;
    }
    let suffix = 0;
    while (
      suffix < beforeLines.length - prefix &&
      suffix < afterLines.length - prefix &&
      beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
    ) {
      suffix++;
    }
    const beforeChanged = beforeLines.slice(prefix, beforeLines.length - suffix);
    const afterChanged = afterLines.slice(prefix, afterLines.length - suffix);
    const beforeEnd = Math.max(prefix + 1, prefix + beforeChanged.length);
    const afterEnd = Math.max(prefix + 1, prefix + afterChanged.length);
    const absolutePath = target.uri.scheme === "file" ? target.uri.fsPath : target.uri.toString(true);
    sections.push(
      [
        `파일: ${target.path}`,
        `실제 경로: ${absolutePath}`,
        `변경 전 줄: ${prefix + 1}-${beforeEnd}`,
        ...previewLines(beforeChanged, "-"),
        `변경 후 줄: ${prefix + 1}-${afterEnd}`,
        ...previewLines(afterChanged, "+"),
      ].join("\n"),
    );
    if (sections.join("\n\n").length >= maxChars) {
      break;
    }
  }
  const preview = sections.join("\n\n");
  return preview.length > maxChars ? `${preview.slice(0, maxChars)}\n[미리보기 생략]` : preview;
}

function splitPreviewLines(content: string): string[] {
  const lines = content.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function previewLines(lines: string[], prefix: string, maxLines = 60): string[] {
  if (lines.length === 0) {
    return [`${prefix} [없음]`];
  }
  const visible = lines.slice(0, maxLines).map((line) => `${prefix} ${line}`);
  if (lines.length > maxLines) {
    visible.push(`${prefix} [... ${lines.length - maxLines}개 줄 생략]`);
  }
  return visible;
}

export function formatPatchApplyOutcome(outcome: PatchApplyOutcome): string {
  if (outcome.status === "notApplied") {
    return `파일은 변경되지 않았습니다. ${outcome.message}`;
  }
  if (outcome.status === "failed") {
    return `파일 적용에 실패했습니다. 성공으로 확인되지 않았으며 일부 편집기 버퍼에 변경이 남아 있을 수 있습니다. ${outcome.message}`;
  }
  const files = outcome.targets
    .map((target) => `- ${target.path} (${target.saveMethod === "direct" ? "직접 저장" : "VS Code 저장"}, ${target.encoding})`)
    .join("\n");
  return [`실제 파일 변경 완료: ${outcome.message}`, files].filter(Boolean).join("\n");
}

function notAppliedOutcome(message: string): PatchApplyOutcome {
  return { status: "notApplied", message, targets: [] };
}

function failedOutcome(message: string): PatchApplyOutcome {
  return { status: "failed", message, targets: [] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

function hashText(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(Buffer.from(right.buffer, right.byteOffset, right.byteLength));
}

async function tryReadBytes(uri: vscode.Uri): Promise<Uint8Array | undefined> {
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch {
    return undefined;
  }
}

function isFileNotFound(error: unknown): boolean {
  if (error instanceof vscode.FileSystemError) {
    return error.code === "FileNotFound";
  }
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function workspaceRelativePath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
}

function lineNumberAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) {
      line++;
    }
  }
  return line;
}

function linePreviewAt(content: string, index: number): string {
  const start = content.lastIndexOf("\n", index) + 1;
  const end = content.indexOf("\n", index);
  const line = content.slice(start, end === -1 ? undefined : end).trim();
  return line.length <= 240 ? line : `${line.slice(0, 240)}...`;
}

export async function ensureCacheDirectory(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return;
  }
  const cacheUri = vscode.Uri.joinPath(folder.uri, ".company-code-ai", "cache");
  await fs.mkdir(cacheUri.fsPath, { recursive: true });
}
