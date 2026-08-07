import * as vscode from "vscode";
import { ExtensionSettings, RuntimeConfig, ToolCallMode } from "./types";
import { validateServerUrl } from "./security";

export const secretTokenKey = "companyCodeAI.authToken";

export function readSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration("companyCodeAI");
  const toolCallMode = config.get<string>("toolCallMode", "auto");

  return {
    serverUrl: config.get<string>("serverUrl", ""),
    model: config.get<string>("model", ""),
    maxContextTokens: clamp(config.get<number>("maxContextTokens", 200000), 8000, 200000),
    maxOutputTokens: clamp(config.get<number>("maxOutputTokens", 60000), 1024, 60000),
    allowedServerHosts: config.get<string[]>("allowedServerHosts", []),
    toolCallMode: parseToolCallMode(toolCallMode),
    requestTimeoutMs: clamp(config.get<number>("requestTimeoutMs", 120000), 10000, 600000),
    enableCommandRunner: config.get<boolean>("enableCommandRunner", false),
  };
}

export async function readRuntimeConfig(secrets: vscode.SecretStorage): Promise<RuntimeConfig> {
  const settings = readSettings();
  validateRuntimeSettings(settings);
  const authToken = await secrets.get(secretTokenKey);
  return { ...settings, authToken };
}

export function validateRuntimeSettings(settings: ExtensionSettings): void {
  validateServerUrl(settings.serverUrl, settings.allowedServerHosts);
  if (!settings.model.trim()) {
    throw new Error("모델이 설정되지 않았습니다.");
  }
  if (settings.enableCommandRunner) {
    throw new Error("명령 실행기는 향후 검토용 기능이며 v1에서는 비활성화되어 있습니다.");
  }
}

export async function updateSetting<T>(key: string, value: T): Promise<void> {
  await vscode.workspace.getConfiguration("companyCodeAI").update(key, value, vscode.ConfigurationTarget.Global);
}

function parseToolCallMode(value: string): ToolCallMode {
  if (value === "native" || value === "json" || value === "disabled") {
    return value;
  }
  return "auto";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
