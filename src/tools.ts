import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { ChatToolDefinition } from "./types";
import { assertSafePathSegment } from "./security";

const excludeGlob = "**/{.git,node_modules,dist,out,build,.company-code-ai,.vscode-test}/**";

export class WorkspaceTools {
  readonly definitions: ChatToolDefinition[] = [
    {
      type: "function",
      function: {
        name: "listFiles",
        description: "List workspace files using a glob pattern. This is read-only.",
        parameters: {
          type: "object",
          properties: {
            glob: { type: "string", description: "Glob pattern. Defaults to **/*." },
            maxResults: { type: "number", description: "Maximum file count. Defaults to 200." },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "readFile",
        description: "Read one workspace file. This is read-only and cannot read outside the workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path." },
            maxChars: { type: "number", description: "Maximum characters to return. Defaults to 40000." },
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
        description: "Search text in workspace files. This is read-only.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Literal text query." },
            maxResults: { type: "number", description: "Maximum matches. Defaults to 40." },
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
        description: "Read the current Git diff for the workspace. This is a fixed read-only Git command.",
        parameters: {
          type: "object",
          properties: {
            maxChars: { type: "number", description: "Maximum characters to return. Defaults to 60000." },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "proposePatch",
        description: "Return a structured patch proposal without applying it.",
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
        description: "Apply exact workspace edits only after an explicit VS Code approval prompt.",
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

  async executeTool(name: string, rawArgs: string): Promise<string> {
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
        return await this.applyPatchAfterUserApproval(args);
      default:
        throw new Error(`Unknown tool '${name}'.`);
    }
  }

  async listFiles(glob = "**/*", maxResults = 200): Promise<string[]> {
    const files = await vscode.workspace.findFiles(glob, excludeGlob, maxResults);
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

  async applyPatchAfterUserApproval(rawArgs: unknown): Promise<string> {
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
      throw new Error("No changes were provided.");
    }

    const labels = changes.map((change) => change.path ?? "[missing path]").join(", ");
    const approved = await vscode.window.showWarningMessage(
      `Apply ${changes.length} workspace change(s)? ${labels}`,
      { modal: true },
      "Apply",
    );
    if (approved !== "Apply") {
      return "User rejected the patch.";
    }

    const edit = new vscode.WorkspaceEdit();
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
          throw new Error(`${relativePath} does not exist. Set createIfMissing to true to create it.`);
        }
        replaceWholeDocument(edit, uri, exists ? current : "", change.fullContent);
        continue;
      }

      if (typeof change.originalText === "string" && typeof change.replacementText === "string") {
        if (!exists) {
          throw new Error(`${relativePath} does not exist.`);
        }
        if (!current.includes(change.originalText)) {
          throw new Error(`Original text was not found in ${relativePath}.`);
        }
        const next = current.replace(change.originalText, change.replacementText);
        replaceWholeDocument(edit, uri, current, next);
        continue;
      }

      throw new Error(`${relativePath} must provide fullContent or originalText/replacementText.`);
    }

    const ok = await vscode.workspace.applyEdit(edit);
    return ok ? "Patch applied." : "VS Code rejected the workspace edit.";
  }

  resolveWorkspacePath(input: string): vscode.Uri {
    assertSafePathSegment(input);
    const root = getWorkspaceRoot();
    const fsPath = path.isAbsolute(input) ? path.normalize(input) : path.normalize(path.join(root.fsPath, input));
    const relative = path.relative(root.fsPath, fsPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path is outside the workspace: ${input}`);
    }
    return vscode.Uri.file(fsPath);
  }
}

function getWorkspaceRoot(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("Open a workspace folder before using workspace tools.");
  }
  return folder.uri;
}

function parseArgs(rawArgs: string): Record<string, unknown> {
  if (!rawArgs.trim()) {
    return {};
  }
  const parsed = JSON.parse(rawArgs) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object.");
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
