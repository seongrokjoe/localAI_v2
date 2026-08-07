import * as vscode from "vscode";
import { ChatViewProvider, configureServer, setAuthToken } from "./chatView";
import { secretTokenKey } from "./config";
import { ContextManager } from "./context";
import { CodeAgent } from "./agent";
import { WorkspaceTools, ensureCacheDirectory } from "./tools";
import { ModeManager } from "./modeManager";
import { SessionStore } from "./sessionStore";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Company Code AI");
  const contextManager = new ContextManager();
  const modeManager = new ModeManager(context.workspaceState);
  const sessionStore = new SessionStore();
  await sessionStore.initialize().catch((error) => output.appendLine(`Session initialization skipped: ${error}`));
  const tools = new WorkspaceTools(async (mode, changes) => {
    await sessionStore.recordChangeSet(mode, changes);
  });
  tools.setActiveScope(sessionStore.activeScope);
  const agent = new CodeAgent(tools, output);
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
      vscode.window.showInformationMessage(scope ? `Company Code AI scope set to ${scope}.` : "Company Code AI scope cleared.");
    }),
    vscode.commands.registerCommand("companyCodeAI.clearActiveScope", async () => {
      await sessionStore.setActiveScope(undefined);
      tools.setActiveScope(undefined);
      chatView.postState();
      vscode.window.showInformationMessage("Company Code AI active scope cleared.");
    }),
    vscode.commands.registerCommand("companyCodeAI.reviewLastAIChange", () => chatView.reviewLastAIChange()),
    vscode.commands.registerCommand("companyCodeAI.configureServer", () => configureServer()),
    vscode.commands.registerCommand("companyCodeAI.setAuthToken", () => setAuthToken(context.secrets)),
    vscode.commands.registerCommand("companyCodeAI.clearAuthToken", async () => {
      await context.secrets.delete(secretTokenKey);
      vscode.window.showInformationMessage("Company Code AI token cleared.");
    }),
    vscode.commands.registerCommand("companyCodeAI.addSelectionToChat", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("Open a file before adding a selection.");
        return;
      }
      const selection = editor.selection;
      if (selection.isEmpty) {
        vscode.window.showWarningMessage("Select code before adding it to chat.");
        return;
      }
      const item = contextManager.addSelection(editor.document, selection, editor.document.getText(selection));
      vscode.window.showInformationMessage(`Added context: ${item.label}`);
      await chatView.reveal();
    }),
    vscode.commands.registerCommand("companyCodeAI.addCurrentFileToChat", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("Open a file before adding it to chat.");
        return;
      }
      const item = contextManager.addFile(editor.document);
      vscode.window.showInformationMessage(`Added context: ${item.label}`);
      await chatView.reveal();
    }),
  );
}

export function deactivate(): void {}

async function pickActiveScope(): Promise<string | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage("Open a workspace folder before setting an active scope.");
    return undefined;
  }

  const items: Array<{ label: string; description: string; value: string }> = [
    { label: "Repository Root", description: "Use the entire opened workspace.", value: "" },
  ];

  try {
    const entries = await vscode.workspace.fs.readDirectory(folder.uri);
    for (const [name, type] of entries) {
      if (type === vscode.FileType.Directory && !name.startsWith(".") && !["bin", "obj", "node_modules", "dist", "build"].includes(name)) {
        items.push({ label: name, description: "Top-level folder", value: name });
      }
    }
  } catch {
    // Ignore directory enumeration failures; solution/project files below may still work.
  }

  const projectFiles = await vscode.workspace.findFiles("**/*.{sln,csproj}", "**/{.git,node_modules,bin,obj,dist,build}/**", 100);
  for (const uri of projectFiles) {
    const relative = vscode.workspace.asRelativePath(uri, false);
    items.push({ label: relative, description: relative.endsWith(".sln") ? "Solution" : "Project", value: relative });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: "Company Code AI: Set Active Scope",
    placeHolder: "Choose the solution, project, or folder to prioritize for context.",
  });
  return picked?.value;
}
