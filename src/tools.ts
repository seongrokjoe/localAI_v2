import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { AgentMode, ChatToolDefinition, FileSnapshotChange } from "./types";
import { assertSafePathSegment } from "./security";

const excludeGlob = "**/{.git,node_modules,dist,out,build,.company-code-ai,.vscode-test}/**";

export class WorkspaceTools {
  private activeScope?: string;

  constructor(private readonly onChangeSet?: (mode: AgentMode, changes: FileSnapshotChange[]) => Promise<void>) {}

  setActiveScope(scope: string | undefined): void {
    this.activeScope = scope;
  }

  definitionsForMode(mode: AgentMode): ChatToolDefinition[] {
    return mode === "plan" ? this.definitions.filter((tool) => tool.function.name !== "applyPatchAfterUserApproval") : this.definitions;
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
      case "applyPatchAfterUserApproval":
        return await this.applyPatchAfterUserApproval(args, mode);
      default:
        throw new Error(`알 수 없는 도구입니다: '${name}'.`);
    }
  }

  async listFiles(glob = "**/*", maxResults = 200): Promise<string[]> {
    const scopedGlob = this.applyActiveScope(glob);
    const files = await vscode.workspace.findFiles(scopedGlob, excludeGlob, maxResults);
    return files.map((uri) => vscode.workspace.asRelativePath(uri, false)).sort();
  }

  async readFile(relativePath: string, maxChars = 40000): Promise<string> {
    const uri = this.resolveWorkspacePath(relativePath);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString("utf8");
    if (text.length <= maxChars) {
      return text;
    }
    return `${text.slice(0, maxChars)}\n[truncated]`;
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

  async applyPatchAfterUserApproval(rawArgs: unknown, mode: AgentMode): Promise<string> {
    const args = rawArgs as {
      changes?: Array<{
        path?: string;
        fullContent?: string;
        originalText?: string;
        replacementText?: string;
        createIfMissing?: boolean;
        description?: string;
      }>;
    };
    const changes = args.changes ?? [];
    if (changes.length === 0) {
      throw new Error("제공된 변경이 없습니다.");
    }

    const labels = changes.map((change) => change.path ?? "[missing path]").join(", ");
    const approved = await vscode.window.showWarningMessage(
      `워크스페이스 변경 ${changes.length}개를 적용할까요? ${labels}`,
      { modal: true },
      "적용",
    );
    if (approved !== "적용") {
      return "사용자가 패치 적용을 거부했습니다.";
    }

    const edit = new vscode.WorkspaceEdit();
    const snapshots: FileSnapshotChange[] = [];
    for (const change of changes) {
      const relativePath = String(change.path ?? "");
      const uri = this.resolveWorkspacePath(relativePath);
      let current = "";
      let exists = true;
      try {
        current = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      } catch {
        exists = false;
      }

      if (typeof change.fullContent === "string") {
        if (!exists && !change.createIfMissing) {
          throw new Error(`${relativePath} 파일이 없습니다. 새로 만들려면 createIfMissing을 true로 설정하세요.`);
        }
        const after = change.fullContent;
        replaceWholeDocument(edit, uri, exists ? current : "", after);
        snapshots.push({ path: relativePath, before: exists ? current : "", after, description: change.description });
        continue;
      }

      if (typeof change.originalText === "string" && typeof change.replacementText === "string") {
        if (!exists) {
          throw new Error(`${relativePath} 파일이 없습니다.`);
        }
        if (!current.includes(change.originalText)) {
          throw new Error(`${relativePath}에서 originalText를 찾지 못했습니다.`);
        }
        const next = current.replace(change.originalText, change.replacementText);
        replaceWholeDocument(edit, uri, current, next);
        snapshots.push({ path: relativePath, before: current, after: next, description: change.description });
        continue;
      }

      throw new Error(`${relativePath}에는 fullContent 또는 originalText/replacementText가 필요합니다.`);
    }

    const ok = await vscode.workspace.applyEdit(edit);
    if (ok && snapshots.length > 0) {
      await this.onChangeSet?.(mode, snapshots);
    }
    return ok ? "패치를 적용했습니다." : "VS Code가 워크스페이스 편집을 거부했습니다.";
  }

  resolveWorkspacePath(input: string): vscode.Uri {
    assertSafePathSegment(input);
    const root = getWorkspaceRoot();
    const fsPath = path.isAbsolute(input) ? path.normalize(input) : path.normalize(path.join(root.fsPath, input));
    const relative = path.relative(root.fsPath, fsPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`경로가 워크스페이스 밖에 있습니다: ${input}`);
    }
    return vscode.Uri.file(fsPath);
  }

  private applyActiveScope(glob: string): string {
    if (!this.activeScope) {
      return glob;
    }
    const normalized = this.activeScope.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!normalized) {
      return glob;
    }
    if (normalized.endsWith(".sln") || normalized.endsWith(".csproj")) {
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

function replaceWholeDocument(edit: vscode.WorkspaceEdit, uri: vscode.Uri, current: string, next: string): void {
  if (!current) {
    edit.createFile(uri, { ignoreIfExists: true });
    edit.insert(uri, new vscode.Position(0, 0), next);
    return;
  }
  const lineCount = current.split(/\r\n|\r|\n/).length;
  edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lineCount, 0)), next);
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
