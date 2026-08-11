import * as vscode from "vscode";
import * as path from "node:path";
import { ChatViewProvider, configureServer, configureServerProfiles, selectServerProfile, setAuthToken } from "./chatView";
import { readSettings, secretTokenKey } from "./config";
import { ContextManager } from "./context";
import { CodeAgent } from "./agent";
import { WorkspaceTools, ensureCacheDirectory } from "./tools";
import { ModeManager } from "./modeManager";
import { SessionStore } from "./sessionStore";
import { ProjectInitializer } from "./projectInit";
import { ChangeWorkbenchManager } from "./changeWorkbench";

interface ActiveScopeSelection {
  scope: string | undefined;
  wholeWorkspace: boolean;
}

type ScopeQuickPickItem = vscode.QuickPickItem & {
  scopeKind: "root" | "scope" | "browse";
  value?: string;
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Company Code AI");
  const contextManager = new ContextManager();
  const modeManager = new ModeManager(context.workspaceState);
  const sessionStore = new SessionStore();
  await sessionStore.initialize().catch((error) => output.appendLine(`세션 초기화를 건너뛰었습니다: ${error}`));
  const tools = new WorkspaceTools(output, async (mode, changes) => {
    await sessionStore.recordChangeSet(mode, changes);
  });
  tools.setCommandRunnerEnabled(readSettings().enableCommandRunner);
  tools.setActiveScope(sessionStore.activeScope);
  const agent = new CodeAgent(tools, output);
  const changeWorkbench = new ChangeWorkbenchManager(context.extensionUri, context.storageUri ?? context.globalStorageUri, tools, output);
  await changeWorkbench.initialize().catch((error) => output.appendLine(`변경 작업대 복원을 건너뛰었습니다: ${error}`));
  const projectInitializer = new ProjectInitializer(context.secrets, output);
  const chatView = new ChatViewProvider(context.extensionUri, context.secrets, contextManager, modeManager, sessionStore, agent, changeWorkbench);

  await ensureCacheDirectory().catch(() => undefined);

  context.subscriptions.push(
    output,
    contextManager,
    modeManager,
    changeWorkbench,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("companyCodeAI.enableCommandRunner")) {
        tools.setCommandRunnerEnabled(readSettings().enableCommandRunner);
      }
      if (
        event.affectsConfiguration("companyCodeAI.activeServerProfile") ||
        event.affectsConfiguration("companyCodeAI.serverProfiles") ||
        event.affectsConfiguration("companyCodeAI.serverUrl") ||
        event.affectsConfiguration("companyCodeAI.model") ||
        event.affectsConfiguration("companyCodeAI.toolCallMode")
      ) {
        chatView.postState();
      }
    }),
    vscode.window.registerWebviewViewProvider("companyCodeAI.chatView", chatView),
    vscode.commands.registerCommand("companyCodeAI.openChat", () => chatView.reveal()),
    vscode.commands.registerCommand("companyCodeAI.openChangeWorkbench", () => changeWorkbench.open()),
    vscode.commands.registerCommand("companyCodeAI.setPlanMode", async () => {
      await modeManager.set("plan");
      chatView.postState();
    }),
    vscode.commands.registerCommand("companyCodeAI.setImplementMode", async () => {
      await modeManager.set("implement");
      chatView.postState();
    }),
    vscode.commands.registerCommand("companyCodeAI.toggleMode", async () => {
      await modeManager.toggle();
      chatView.postState();
    }),
    vscode.commands.registerCommand("companyCodeAI.clearContext", async () => chatView.clearContextMenu()),
    vscode.commands.registerCommand("companyCodeAI.setActiveScope", async () => {
      const selection = await pickActiveScope(sessionStore.activeScope);
      if (!selection) {
        return;
      }
      await sessionStore.setActiveScope(selection.scope);
      tools.setActiveScope(selection.scope);
      chatView.postState();
      vscode.window.showInformationMessage(
        selection.wholeWorkspace
          ? "Company Code AI가 전체 워크스페이스를 사용합니다."
          : `Company Code AI 활성 스코프를 ${selection.scope}로 설정했습니다.`,
      );
    }),
    vscode.commands.registerCommand("companyCodeAI.clearActiveScope", async () => {
      await sessionStore.setActiveScope(undefined);
      tools.setActiveScope(undefined);
      chatView.postState();
      vscode.window.showInformationMessage("Company Code AI 활성 스코프를 해제했습니다.");
    }),
    vscode.commands.registerCommand("companyCodeAI.reviewLastAIChange", () => chatView.reviewLastAIChange()),
    vscode.commands.registerCommand("companyCodeAI.showLastPatchDiagnostics", () => tools.showLastPatchDiagnostics()),
    vscode.commands.registerCommand("companyCodeAI.validateWorkspace", async () => {
      tools.setCommandRunnerEnabled(readSettings().enableCommandRunner);
      const result = await tools.validateWorkspace();
      output.appendLine(`[Workspace validation] ${result.summary}`);
      if (result.output) output.appendLine(result.output);
      output.show(true);
      if (result.status === "passed") vscode.window.showInformationMessage(result.summary);
      else if (result.status === "failed") vscode.window.showErrorMessage(result.summary);
      else vscode.window.showWarningMessage(result.summary);
      return result;
    }),
    vscode.commands.registerCommand("companyCodeAI.initProjectSummary", async () => {
      await modeManager.set("plan");
      chatView.postState();
      await projectInitializer.initProjectSummary(false);
    }),
    vscode.commands.registerCommand("companyCodeAI.refreshProjectSummary", async () => {
      await modeManager.set("plan");
      chatView.postState();
      await projectInitializer.initProjectSummary(true);
    }),
    vscode.commands.registerCommand("companyCodeAI.openProjectSummary", () => projectInitializer.openProjectSummary()),
    vscode.commands.registerCommand("companyCodeAI.clearInitCache", () => projectInitializer.clearInitCache()),
    vscode.commands.registerCommand("companyCodeAI.configureServer", async () => {
      await configureServer();
      chatView.postState();
    }),
    vscode.commands.registerCommand("companyCodeAI.selectServerProfile", async () => {
      await selectServerProfile();
      chatView.postState();
    }),
    vscode.commands.registerCommand("companyCodeAI.configureServerProfiles", async () => {
      await configureServerProfiles();
      chatView.postState();
    }),
    vscode.commands.registerCommand("companyCodeAI.setAuthToken", () => setAuthToken(context.secrets)),
    vscode.commands.registerCommand("companyCodeAI.clearAuthToken", async () => {
      await context.secrets.delete(secretTokenKey);
      vscode.window.showInformationMessage("Company Code AI 토큰을 삭제했습니다.");
    }),
    vscode.commands.registerCommand("companyCodeAI.addSelectionToChat", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("선택 영역을 추가하려면 먼저 파일을 여세요.");
        return;
      }
      const selection = editor.selection;
      if (selection.isEmpty) {
        vscode.window.showWarningMessage("채팅에 추가할 코드를 먼저 선택하세요.");
        return;
      }
      const item = contextManager.addSelection(editor.document, selection, editor.document.getText(selection));
      vscode.window.showInformationMessage(`컨텍스트를 추가했습니다: ${item.label}`);
      await chatView.reveal();
    }),
    vscode.commands.registerCommand("companyCodeAI.addCurrentFileToChat", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("채팅에 추가할 파일을 먼저 여세요.");
        return;
      }
      const item = contextManager.addFile(editor.document);
      vscode.window.showInformationMessage(`컨텍스트를 추가했습니다: ${item.label}`);
      await chatView.reveal();
    }),
  );
}

export function deactivate(): void {}

async function pickActiveScope(currentScope: string | undefined): Promise<ActiveScopeSelection | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage("활성 스코프를 설정하려면 먼저 워크스페이스 폴더를 여세요.");
    return undefined;
  }
  const normalizedCurrentScope = currentScope?.replace(/\\/g, "/");

  const items: ScopeQuickPickItem[] = [
    {
      label: "전체 워크스페이스 사용 (스코프 없음)",
      description: normalizedCurrentScope ? "현재 스코프를 해제하고 전체를 사용합니다." : "현재 선택됨",
      scopeKind: "root",
    },
  ];
  const seenScopes = new Set<string>();

  try {
    const entries = await vscode.workspace.fs.readDirectory(folder.uri);
    const topLevelFolders = entries
      .filter(([name, type]) => type === vscode.FileType.Directory && !name.startsWith(".") && !["bin", "obj", "node_modules", "dist", "build"].includes(name))
      .map(([name]) => name)
      .sort((left, right) => left.localeCompare(right));
    for (const name of topLevelFolders) {
      addScopeItem(items, seenScopes, name, "최상위 폴더", name, normalizedCurrentScope);
    }
  } catch {
    // Ignore directory enumeration failures; solution/project files below may still work.
  }

  const projectFiles = await vscode.workspace.findFiles(
    "**/*.{sln,slnx,csproj,vcxproj,vbproj,fsproj,sqlproj,wixproj,proj}",
    "**/{.git,node_modules,bin,obj,dist,build}/**",
    200,
  );
  for (const uri of projectFiles.map((item) => vscode.workspace.asRelativePath(item, false)).sort((left, right) => left.localeCompare(right))) {
    addScopeItem(items, seenScopes, uri, projectDescription(uri), uri, normalizedCurrentScope);
  }

  items.push({
    label: "폴더/파일 직접 선택...",
    description: "목록에 없는 하위 폴더나 프로젝트 파일을 선택합니다.",
    scopeKind: "browse",
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: "Company Code AI: 활성 스코프 설정",
    placeHolder: "컨텍스트에서 우선할 솔루션, 프로젝트, 폴더를 선택하세요.",
  });
  if (!picked) {
    return undefined;
  }
  if (picked.scopeKind === "root") {
    return { scope: undefined, wholeWorkspace: true };
  }
  if (picked.scopeKind === "browse") {
    return await browseActiveScope(folder);
  }
  if (!picked.value) {
    return undefined;
  }
  return { scope: picked.value, wholeWorkspace: false };
}

function addScopeItem(
  items: ScopeQuickPickItem[],
  seenScopes: Set<string>,
  label: string,
  description: string,
  value: string,
  currentScope: string | undefined,
): void {
  const normalized = value.replace(/\\/g, "/");
  const key = normalized.toLowerCase();
  if (seenScopes.has(key)) {
    return;
  }
  seenScopes.add(key);
  items.push({
    label,
    description: normalized === currentScope ? `현재 선택됨 - ${description}` : description,
    value: normalized,
    scopeKind: "scope",
  });
}

async function browseActiveScope(folder: vscode.WorkspaceFolder): Promise<ActiveScopeSelection | undefined> {
  const picked = await vscode.window.showOpenDialog({
    title: "Company Code AI: 활성 스코프 직접 선택",
    defaultUri: folder.uri,
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "스코프 선택",
  });
  const uri = picked?.[0];
  if (!uri) {
    return undefined;
  }

  const relative = path.relative(folder.uri.fsPath, uri.fsPath);
  if (!relative) {
    return { scope: undefined, wholeWorkspace: true };
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    vscode.window.showWarningMessage("활성 스코프는 현재 워크스페이스 안의 폴더나 파일만 선택할 수 있습니다.");
    return undefined;
  }
  return { scope: relative.replace(/\\/g, "/"), wholeWorkspace: false };
}

function projectDescription(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  return lower.endsWith(".sln") || lower.endsWith(".slnx") ? "솔루션" : "프로젝트";
}
