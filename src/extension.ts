import * as vscode from "vscode";
import { ChatViewProvider, configureServer, setAuthToken } from "./chatView";
import { secretTokenKey } from "./config";
import { ContextManager } from "./context";
import { CodeAgent } from "./agent";
import { WorkspaceTools, ensureCacheDirectory } from "./tools";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Company Code AI");
  const contextManager = new ContextManager();
  const tools = new WorkspaceTools();
  const agent = new CodeAgent(tools, output);
  const chatView = new ChatViewProvider(context.extensionUri, context.secrets, contextManager, agent);

  await ensureCacheDirectory().catch(() => undefined);

  context.subscriptions.push(
    output,
    contextManager,
    vscode.window.registerWebviewViewProvider("companyCodeAI.chatView", chatView),
    vscode.commands.registerCommand("companyCodeAI.openChat", () => chatView.reveal()),
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
