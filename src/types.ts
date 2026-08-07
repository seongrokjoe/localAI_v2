export type ToolCallMode = "auto" | "native" | "json" | "disabled";
export type AgentMode = "plan" | "implement";
export type ChatRole = "user" | "assistant";

export interface ExtensionSettings {
  serverUrl: string;
  model: string;
  maxContextTokens: number;
  maxOutputTokens: number;
  allowedServerHosts: string[];
  toolCallMode: ToolCallMode;
  requestTimeoutMs: number;
  enableCommandRunner: boolean;
}

export interface RuntimeConfig extends ExtensionSettings {
  authToken?: string;
}

export interface ContextItem {
  id: string;
  type: "selection" | "file" | "note";
  label: string;
  content: string;
  uri?: string;
  languageId?: string;
  createdAt: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface CompletionResult {
  content: string;
  toolCalls: ChatToolCall[];
  usage?: Record<string, unknown>;
}

export interface AgentMemoryContext {
  activeScope?: string;
  projectMemory: string;
  sessionSummary: string;
  recentTurns: Array<{
    role: ChatRole;
    content: string;
    createdAt: number;
  }>;
}

export interface AgentRunOptions {
  mode: AgentMode;
  memory: AgentMemoryContext;
}

export interface FileSnapshotChange {
  path: string;
  before: string;
  after: string;
  description?: string;
}

export type PatchApplyStatus = "applied" | "notApplied" | "failed";
export type PatchSaveMethod = "vscode" | "direct";

export interface PatchTargetResult {
  path: string;
  absolutePath: string;
  encoding: string;
  saveMethod: PatchSaveMethod;
  beforeHash?: string;
  afterHash: string;
}

export interface PatchApplyOutcome {
  status: PatchApplyStatus;
  message: string;
  targets: PatchTargetResult[];
}

export interface AssistantPatchApplyResult {
  response: string;
  outcome: PatchApplyOutcome;
}

export interface ChangeSet {
  id: string;
  createdAt: number;
  mode: AgentMode;
  changes: FileSnapshotChange[];
}
