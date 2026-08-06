import { RuntimeConfig, ChatMessage, ChatToolCall, ChatToolDefinition, CompletionResult } from "./types";
import { validateServerUrl } from "./security";

interface CompletionOptions {
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  onDelta: (text: string) => void;
  signal?: AbortSignal;
}

export class LlmClient {
  constructor(private readonly config: RuntimeConfig) {}

  async complete(options: CompletionOptions): Promise<CompletionResult> {
    const url = buildChatCompletionsUrl(this.config.serverUrl, this.config.allowedServerHosts);
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: options.messages,
      stream: true,
    };
    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = "auto";
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    const signal = anySignal([controller.signal, options.signal].filter(Boolean) as AbortSignal[]);

    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LLM request failed (${response.status}): ${truncate(errorText, 1000)}`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        return await readJsonCompletion(response, options.onDelta);
      }

      return await readSseCompletion(response, options.onDelta);
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
    };
    if (this.config.authToken?.trim()) {
      headers.Authorization = `Bearer ${this.config.authToken.trim()}`;
    }
    return headers;
  }
}

function buildChatCompletionsUrl(rawUrl: string, allowedHosts: string[]): URL {
  const url = validateServerUrl(rawUrl, allowedHosts);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/chat/completions")) {
    return url;
  }
  url.pathname = pathname.endsWith("/v1") ? `${pathname}/chat/completions` : `${pathname}/v1/chat/completions`;
  return url;
}

async function readJsonCompletion(response: Response, onDelta: (text: string) => void): Promise<CompletionResult> {
  const json = (await response.json()) as any;
  const message = json?.choices?.[0]?.message ?? {};
  const content = typeof message.content === "string" ? message.content : "";
  if (content) {
    onDelta(content);
  }
  return {
    content,
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    usage: json?.usage,
  };
}

async function readSseCompletion(response: Response, onDelta: (text: string) => void): Promise<CompletionResult> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("LLM response body is empty.");
  }

  const decoder = new TextDecoder();
  const toolCalls = new Map<number, ChatToolCall>();
  let content = "";
  let usage: Record<string, unknown> | undefined;
  let buffer = "";

  for (;;) {
    const read = await reader.read();
    if (read.done) {
      break;
    }
    buffer += decoder.decode(read.value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) {
        continue;
      }
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") {
        continue;
      }
      const json = JSON.parse(data) as any;
      usage = json.usage ?? usage;
      const delta = json?.choices?.[0]?.delta ?? {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        content += delta.content;
        onDelta(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        aggregateToolCalls(toolCalls, delta.tool_calls);
      }
      const message = json?.choices?.[0]?.message;
      if (message?.content && typeof message.content === "string") {
        content += message.content;
        onDelta(message.content);
      }
      if (Array.isArray(message?.tool_calls)) {
        aggregateToolCalls(toolCalls, message.tool_calls);
      }
    }
  }

  return {
    content,
    toolCalls: Array.from(toolCalls.values()),
    usage,
  };
}

function aggregateToolCalls(target: Map<number, ChatToolCall>, chunks: any[]): void {
  for (const chunk of chunks) {
    const index = typeof chunk.index === "number" ? chunk.index : target.size;
    const existing =
      target.get(index) ??
      ({
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      } satisfies ChatToolCall);

    if (typeof chunk.id === "string") {
      existing.id = chunk.id;
    }
    if (typeof chunk.type === "string") {
      existing.type = "function";
    }
    if (typeof chunk.function?.name === "string") {
      existing.function.name += chunk.function.name;
    }
    if (typeof chunk.function?.arguments === "string") {
      existing.function.arguments += chunk.function.arguments;
    }
    target.set(index, existing);
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 1) {
    return signals[0];
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}
