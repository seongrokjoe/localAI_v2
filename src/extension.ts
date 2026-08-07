import * as vscode from "vscode";
import { ChatViewProvider, configureServer, setAuthToken } from "./chatView";
import { secretTokenKey } from "./config";
import { ContextManager } from "./context";
import { CodeAgent } from "./agent";
import { WorkspaceTools, ensureCacheDirectory } from "./tools";
import { ModeManager } from "./modeManager";
import { SessionStore } from "./sessionStore";
import { ProjectInitializer } from "./projectInit";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Company Code AI");
  const contextManager = new ContextManager();
  const modeManager = new ModeManager(context.workspaceState);
  const sessionStore = new SessionStore();
  await sessionStore.initialize().catch((error) => output.appendLine(`세션 초기화를 건너뛰었습니다: ${error}`));
  const tools = new WorkspaceTools(async (mode, changes) => {
    await sessionStore.recordChangeSet(mode, changes);
  });
  tools.setActiveScope(sessionStore.activeScope);
  const agent = new CodeAgent(tools, output);
  const projectInitializer = new ProjectInitializer(context.secrets, output);
  const chatView = new ChatViewProvider(context.extensionUri, context.secrets, contextManager, modeManager, sessionStore, agent);

  await ensureCacheDirectory().catch(() => undefined);

  context.subscriptions.push(
    output,
    contextManager,
    modeManager,
    vscode.window.registerWebviewViewProvider("companyCodeAI.chatView", chatView),
    vscode.commands.registerCommand("companyCodeAI.openChat", () => chatView.reveal()),
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
      const scope = await pickActiveScope();
      if (scope === undefined) {
        return;
      }
      await sessionStore.setActiveScope(scope || undefined);
      tools.setActiveScope(scope || undefined);
      chatView.postState();
      vscode.window.showInformationMessage(scope ? `Company Code AI 활성 스코프를 ${scope}로 설정했습니다.` : "Company Code AI 활성 스코프를 해제했습니다.");
    }),
    vscode.commands.registerCommand("companyCodeAI.clearActiveScope", async () => {
      await sessionStore.setActiveScope(undefined);
      tools.setActiveScope(undefined);
      chatView.postState();
      vscode.window.showInformationMessage("Company Code AI 활성 스코프를 해제했습니다.");
    }),
    vscode.commands.registerCommand("companyCodeAI.reviewLastAIChange", () => chatView.reviewLastAIChange()),
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
    vscode.commands.registerCommand("companyCodeAI.configureServer", () => configureServer()),
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

async function pickActiveScope(): Promise<string | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage("활성 스코프를 설정하려면 먼저 워크스페이스 폴더를 여세요.");
    return undefined;
  }

  const items: Array<{ label: string; description: string; value: string }> = [
    { label: "리포지터리 루트", description: "열려 있는 전체 워크스페이스를 사용합니다.", value: "" },
  ];

  try {
    const entries = await vscode.workspace.fs.readDirectory(folder.uri);
    for (const [name, type] of entries) {
      if (type === vscode.FileType.Directory && !name.startsWith(".") && !["bin", "obj", "node_modules", "dist", "build"].includes(name)) {
        items.push({ label: name, description: "최상위 폴더", value: name });
      }
    }
  } catch {
    // Ignore directory enumeration failures; solution/project files below may still work.
  }

  const projectFiles = await vscode.workspace.findFiles("**/*.{sln,csproj}", "**/{.git,node_modules,bin,obj,dist,build}/**", 100);
  for (const uri of projectFiles) {
    const relative = vscode.workspace.asRelativePath(uri, false);
    items.push({ label: relative, description: relative.endsWith(".sln") ? "솔루션" : "프로젝트", value: relative });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: "Company Code AI: 활성 스코프 설정",
    placeHolder: "컨텍스트에서 우선할 솔루션, 프로젝트, 폴더를 선택하세요.",
  });
  return picked?.value;
}
