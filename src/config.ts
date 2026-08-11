import * as vscode from "vscode";
import {
  ExtensionSettings,
  LlmServerProfile,
  LlmServerProfiles,
  RuntimeConfig,
  ServerProfileId,
} from "./types";
import { validateServerUrl } from "./security";
import {
  legacyProfile,
  normalizeServerProfiles,
  parseServerProfileId,
  parseToolCallMode,
  serverProfileLabels,
} from "./serverProfiles";

export { legacyProfile, profileIsComplete, serverProfileLabels } from "./serverProfiles";

export const secretTokenKey = "companyCodeAI.authToken";

export interface ServerProfileState {
  activeId: ServerProfileId;
  profiles: LlmServerProfiles;
  usesLegacyFallback: boolean;
}

export function readSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration("companyCodeAI");
  const toolCallMode = config.get<string>("toolCallMode", "auto");
  const activeServerProfile = parseServerProfileId(config.get<string>("activeServerProfile", "existing"));

  return {
    activeServerProfile,
    serverProfiles: normalizeServerProfiles(config.get<unknown>("serverProfiles")),
    serverUrl: config.get<string>("serverUrl", ""),
    model: config.get<string>("model", ""),
    maxContextTokens: clamp(config.get<number>("maxContextTokens", 200000), 8000, 200000),
    maxOutputTokens: clamp(config.get<number>("maxOutputTokens", 60000), 1024, 60000),
    allowedServerHosts: config.get<string[]>("allowedServerHosts", []),
    toolCallMode: parseToolCallMode(toolCallMode),
    requestTimeoutMs: clamp(config.get<number>("requestTimeoutMs", 120000), 10000, 600000),
    enableCommandRunner: config.get<boolean>("enableCommandRunner", true),
  };
}

export async function readRuntimeConfig(secrets: vscode.SecretStorage): Promise<RuntimeConfig> {
  const settings = readSettings();
  const state = readServerProfileState(settings);
  const profile = state.usesLegacyFallback ? legacyProfile(settings) : state.profiles[state.activeId];
  validateRuntimeProfile(profile, settings.allowedServerHosts, serverProfileLabels[state.activeId]);
  const authToken = await secrets.get(secretTokenKey);
  return {
    ...profile,
    activeServerProfile: state.activeId,
    activeServerLabel: state.usesLegacyFallback ? "현재 단일 설정" : serverProfileLabels[state.activeId],
    allowedServerHosts: settings.allowedServerHosts,
    enableCommandRunner: settings.enableCommandRunner,
    authToken,
  };
}

export function validateRuntimeSettings(settings: ExtensionSettings): void {
  const state = readServerProfileState(settings);
  const profile = state.usesLegacyFallback ? legacyProfile(settings) : state.profiles[state.activeId];
  validateRuntimeProfile(profile, settings.allowedServerHosts, serverProfileLabels[state.activeId]);
}

export function validateRuntimeProfile(profile: LlmServerProfile, allowedHosts: string[], label: string): void {
  try {
    validateServerUrl(profile.serverUrl, allowedHosts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${message}`);
  }
  if (!profile.model.trim()) {
    throw new Error(`${label}: 모델이 설정되지 않았습니다.`);
  }
}

export function readServerProfileState(settings = readSettings()): ServerProfileState {
  const configured = hasConfiguredProfiles();
  return {
    activeId: settings.activeServerProfile,
    profiles: settings.serverProfiles,
    usesLegacyFallback: !configured,
  };
}

export async function updateSetting<T>(key: string, value: T): Promise<void> {
  await vscode.workspace.getConfiguration("companyCodeAI").update(key, value, vscode.ConfigurationTarget.Global);
}

function hasConfiguredProfiles(): boolean {
  const inspected = vscode.workspace.getConfiguration("companyCodeAI").inspect<unknown>("serverProfiles");
  return inspected?.globalValue !== undefined || inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
