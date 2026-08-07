export type ToolCallMode = "auto" | "native" | "json" | "disabled";

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
