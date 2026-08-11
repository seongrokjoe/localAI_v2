import {
  ExtensionSettings,
  LlmServerProfile,
  LlmServerProfiles,
  ServerProfileId,
  ToolCallMode,
} from "./types";

export const serverProfileLabels: Record<ServerProfileId, string> = {
  existing: "기존 서버",
  new: "변경 서버",
};

export function parseToolCallMode(value: string): ToolCallMode {
  if (value === "native" || value === "required" || value === "json" || value === "disabled") {
    return value;
  }
  return "auto";
}

export function parseServerProfileId(value: string): ServerProfileId {
  return value === "new" ? "new" : "existing";
}

export function normalizeServerProfiles(value: unknown): LlmServerProfiles {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    existing: normalizeServerProfile(raw.existing, "auto"),
    new: normalizeServerProfile(raw.new, "required"),
  };
}

export function profileIsComplete(profile: LlmServerProfile): boolean {
  return Boolean(profile.serverUrl.trim() && profile.model.trim());
}

export function legacyProfile(settings: ExtensionSettings): LlmServerProfile {
  return {
    serverUrl: settings.serverUrl,
    model: settings.model,
    toolCallMode: settings.toolCallMode,
    maxContextTokens: settings.maxContextTokens,
    maxOutputTokens: settings.maxOutputTokens,
    requestTimeoutMs: settings.requestTimeoutMs,
  };
}

function normalizeServerProfile(value: unknown, defaultToolMode: ToolCallMode): LlmServerProfile {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    serverUrl: typeof raw.serverUrl === "string" ? raw.serverUrl.trim() : "",
    model: typeof raw.model === "string" ? raw.model.trim() : "",
    toolCallMode: parseToolCallMode(typeof raw.toolCallMode === "string" ? raw.toolCallMode : defaultToolMode),
    maxContextTokens: clamp(numberOr(raw.maxContextTokens, 200000), 8000, 200000),
    maxOutputTokens: clamp(numberOr(raw.maxOutputTokens, 60000), 1024, 60000),
    requestTimeoutMs: clamp(numberOr(raw.requestTimeoutMs, 120000), 10000, 600000),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
