import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { AgentMemoryContext, AgentMode, ChangeSet, ChatRole, FileSnapshotChange } from "./types";

interface StoredTurn {
  role: ChatRole;
  content: string;
  createdAt: number;
}

interface StoredState {
  sessionId: string;
  activeScope?: string;
  projectMemory: string;
  sessionSummary: string;
  turns: StoredTurn[];
  lastChangeSetId?: string;
}

const defaultState = (): StoredState => ({
  sessionId: crypto.randomUUID(),
  projectMemory: "",
  sessionSummary: "",
  turns: [],
});

export class SessionStore {
  private state: StoredState = defaultState();

  async initialize(): Promise<void> {
    await this.ensureDirs();
    try {
      const raw = await fs.readFile(this.statePath(), "utf8");
      this.state = { ...defaultState(), ...JSON.parse(raw) };
    } catch {
      await this.save();
    }
  }

  get activeScope(): string | undefined {
    return this.state.activeScope;
  }

  async setActiveScope(scope: string | undefined): Promise<void> {
    this.state.activeScope = scope;
    await this.save();
  }

  memoryContext(includeConversation = true): AgentMemoryContext {
    return {
      activeScope: this.state.activeScope,
      projectMemory: this.state.projectMemory,
      sessionSummary: includeConversation ? this.state.sessionSummary : "",
      recentTurns: includeConversation ? this.state.turns.slice(-6) : [],
    };
  }

  async recordTurn(role: ChatRole, content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) {
      return;
    }
    this.state.turns.push({ role, content: trimmed, createdAt: Date.now() });
    this.state.turns = this.state.turns.slice(-20);
    this.state.sessionSummary = compactSessionSummary(this.state.turns);
    await this.save();
  }

  async remember(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const entry = `- ${new Date().toISOString()}: ${oneLine(trimmed, 800)}`;
    this.state.projectMemory = [this.state.projectMemory.trim(), entry].filter(Boolean).join("\n");
    this.state.projectMemory = trimChars(this.state.projectMemory, 12000);
    await this.save();
  }

  async clearAddedSession(): Promise<void> {
    this.state.sessionId = crypto.randomUUID();
    this.state.sessionSummary = "";
    this.state.turns = [];
    await this.save();
  }

  async clearProjectMemory(): Promise<void> {
    this.state.projectMemory = "";
    await this.save();
  }

  async clearAll(): Promise<void> {
    const activeScope = this.state.activeScope;
    this.state = defaultState();
    this.state.activeScope = activeScope;
    await this.save();
  }

  async recordChangeSet(mode: AgentMode, changes: FileSnapshotChange[]): Promise<ChangeSet> {
    await this.ensureDirs();
    const changeSet: ChangeSet = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      mode,
      changes,
    };
    await fs.writeFile(this.changeSetPath(changeSet.id), JSON.stringify(changeSet, null, 2), "utf8");
    this.state.lastChangeSetId = changeSet.id;
    await this.save();
    return changeSet;
  }

  async getLastChangeSet(): Promise<ChangeSet | undefined> {
    if (!this.state.lastChangeSetId) {
      return undefined;
    }
    try {
      const raw = await fs.readFile(this.changeSetPath(this.state.lastChangeSetId), "utf8");
      return JSON.parse(raw) as ChangeSet;
    } catch {
      return undefined;
    }
  }

  renderChangeSetDiff(changeSet: ChangeSet): string {
    return changeSet.changes.map((change) => renderFileDiff(change.path, change.before, change.after)).join("\n\n");
  }

  private async ensureDirs(): Promise<void> {
    await fs.mkdir(this.rootPath(), { recursive: true });
    await fs.mkdir(path.join(this.rootPath(), "changes"), { recursive: true });
  }

  private async save(): Promise<void> {
    await this.ensureDirs();
    await fs.writeFile(this.statePath(), JSON.stringify(this.state, null, 2), "utf8");
  }

  private rootPath(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error("Company Code AI 세션을 사용하려면 먼저 워크스페이스 폴더를 여세요.");
    }
    return path.join(folder.uri.fsPath, ".company-code-ai");
  }

  private statePath(): string {
    return path.join(this.rootPath(), "state.json");
  }

  private changeSetPath(id: string): string {
    return path.join(this.rootPath(), "changes", `${id}.json`);
  }
}

function compactSessionSummary(turns: StoredTurn[]): string {
  return turns
    .slice(-8)
    .map((turn) => `${turn.role}: ${oneLine(turn.content, 700)}`)
    .join("\n");
}

function oneLine(text: string, max: number): string {
  return trimChars(text.replace(/\s+/g, " ").trim(), max);
}

function trimChars(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function renderFileDiff(relativePath: string, before: string, after: string): string {
  if (before === after) {
    return `--- ${relativePath}\n(텍스트 변경 없음)`;
  }
  return [
    `--- ${relativePath} before`,
    trimChars(before, 30000),
    `+++ ${relativePath} after`,
    trimChars(after, 30000),
  ].join("\n");
}
