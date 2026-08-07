import * as vscode from "vscode";
import { CodeAgent } from "./agent";
import { readRuntimeConfig, secretTokenKey, updateSetting } from "./config";
import { ContextManager } from "./context";
import { ModeManager } from "./modeManager";
import { SessionStore } from "./sessionStore";
import { AgentMode } from "./types";

interface WebviewMessage {
  type: string;
  text?: string;
  id?: string;
  mode?: AgentMode;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private abortController?: AbortController;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: vscode.SecretStorage,
    private readonly contextManager: ContextManager,
    private readonly modeManager: ModeManager,
    private readonly sessionStore: SessionStore,
    private readonly agent: CodeAgent,
  ) {
    this.contextManager.onDidChange(() => this.postContext());
    this.modeManager.onDidChange(() => this.postState());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => this.handleMessage(message));
    this.postContext();
    this.postState();
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand("companyCodeAI.chatView.focus");
  }

  postContext(): void {
    this.view?.webview.postMessage({
      type: "context",
      items: this.contextManager.list().map((item) => ({ id: item.id, type: item.type, label: item.label })),
    });
  }

  postState(): void {
    this.view?.webview.postMessage({
      type: "state",
      mode: this.modeManager.current,
      activeScope: this.sessionStore.activeScope,
    });
  }

  async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case "send":
        await this.send(message.text ?? "");
        break;
      case "setMode":
        if (message.mode) {
          await this.modeManager.set(message.mode);
          this.postState();
        }
        break;
      case "stop":
        this.abortController?.abort();
        break;
      case "clearContext":
        await this.clearContextMenu();
        break;
      case "removeContext":
        if (message.id) {
          this.contextManager.remove(message.id);
        }
        break;
      case "configure":
        await vscode.commands.executeCommand("companyCodeAI.configureServer");
        break;
      case "setToken":
        await vscode.commands.executeCommand("companyCodeAI.setAuthToken");
        break;
      case "addCurrentFile":
        await vscode.commands.executeCommand("companyCodeAI.addCurrentFileToChat");
        break;
      case "implementPlan":
        await this.implementPlan(message.text ?? "");
        break;
      case "refinePlan":
        this.view?.webview.postMessage({ type: "setInput", text: `Refine this plan:\n\n${message.text ?? ""}` });
        break;
      case "remember":
        await this.sessionStore.remember(message.text ?? "");
        vscode.window.showInformationMessage("Company Code AI remembered the selected content.");
        break;
    }
  }

  async clearContextMenu(): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      [
        { label: "Clear Added Context", description: "Remove added files and selections only." },
        { label: "Clear Chat Session", description: "Clear recent turns and session summary." },
        { label: "Clear Project Memory", description: "Clear persisted project memory." },
        { label: "Clear All", description: "Clear added context, chat session, and project memory." },
      ],
      { title: "Company Code AI: Clear Context" },
    );
    if (!choice) {
      return;
    }
    if (choice.label === "Clear Added Context") {
      this.contextManager.clear();
    } else if (choice.label === "Clear Chat Session") {
      await this.sessionStore.clearAddedSession();
    } else if (choice.label === "Clear Project Memory") {
      await this.sessionStore.clearProjectMemory();
    } else {
      this.contextManager.clear();
      await this.sessionStore.clearAll();
    }
    this.postContext();
    this.postState();
  }

  async reviewLastAIChange(): Promise<void> {
    const changeSet = await this.sessionStore.getLastChangeSet();
    if (!changeSet) {
      vscode.window.showWarningMessage("No AI-applied change snapshot is available.");
      return;
    }
    this.contextManager.addNote(`AI change ${changeSet.id}`, this.sessionStore.renderChangeSetDiff(changeSet));
    await this.modeManager.set("plan");
    await this.reveal();
    await this.send("Review the last AI-applied change. Focus on regressions, missed edge cases, and whether the implementation matches the requested plan.");
  }

  private async implementPlan(plan: string): Promise<void> {
    const trimmed = plan.trim();
    if (!trimmed) {
      return;
    }
    await this.modeManager.set("implement");
    await this.send(`Implement this approved plan. Keep edits minimal and ask for file-change approval before applying patches.\n\n${trimmed}`);
  }

  private async send(text: string): Promise<void> {
    const prompt = text.trim();
    if (!prompt) {
      return;
    }
    if (this.abortController) {
      vscode.window.showWarningMessage("A Company Code AI request is already running.");
      return;
    }

    this.view?.webview.postMessage({ type: "user", text: prompt });
    this.view?.webview.postMessage({ type: "assistantStart" });
    this.view?.webview.postMessage({ type: "status", text: "Running" });

    this.abortController = new AbortController();
    try {
      const config = await readRuntimeConfig(this.secrets);
      await this.sessionStore.recordTurn("user", prompt);
      const response = await this.agent.run(
        prompt,
        this.contextManager.list(),
        config,
        {
          mode: this.modeManager.current,
          memory: this.sessionStore.memoryContext(),
        },
        (delta) => this.view?.webview.postMessage({ type: "assistantDelta", text: delta }),
        this.abortController.signal,
      );
      await this.sessionStore.recordTurn("assistant", response);
      this.view?.webview.postMessage({ type: "assistantDone" });
      if (this.modeManager.current === "plan" && response.trim()) {
        this.view?.webview.postMessage({ type: "planActions", text: response });
      }
      this.view?.webview.postMessage({ type: "status", text: "Ready" });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.view?.webview.postMessage({ type: "assistantError", text });
      this.view?.webview.postMessage({ type: "status", text: "Error" });
    } finally {
      this.abortController = undefined;
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = createNonce();
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 0;
      padding: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }
    .toolbar {
      display: flex;
      gap: 6px;
      align-items: center;
      padding: 8px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
    }
    .modebar {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      padding: 8px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
    }
    .modebar button.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      padding: 4px 8px;
      border-radius: 4px;
      cursor: pointer;
      white-space: nowrap;
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    #status {
      margin-left: auto;
      opacity: 0.78;
      min-width: 42px;
      text-align: right;
    }
    #context {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 8px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
    }
    .chip {
      display: inline-flex;
      gap: 6px;
      align-items: center;
      max-width: 100%;
      padding: 2px 6px;
      border: 1px solid var(--vscode-badge-background);
      border-radius: 4px;
      overflow: hidden;
    }
    .chip span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chip button {
      padding: 0 4px;
      border: 0;
      background: transparent;
      color: var(--vscode-foreground);
    }
    #messages {
      padding: 10px 8px 96px;
      overflow-y: auto;
    }
    .message {
      margin: 0 0 12px;
      padding: 8px;
      border-radius: 6px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-sideBarSectionHeader-border);
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.45;
    }
    .message.user {
      border-color: var(--vscode-focusBorder);
    }
    .message.error {
      border-color: var(--vscode-errorForeground);
      color: var(--vscode-errorForeground);
    }
    .plan-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: -6px 0 12px;
      padding: 0 2px;
    }
    .composer {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      padding: 8px;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
      background: var(--vscode-sideBar-background);
    }
    textarea {
      min-height: 48px;
      max-height: 160px;
      resize: vertical;
      padding: 6px;
      border-radius: 4px;
      border: 1px solid var(--vscode-input-border);
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font-family: var(--vscode-font-family);
    }
    .composer-actions {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="configure">Server</button>
    <button id="token">Token</button>
    <button id="addFile">File</button>
    <button id="clearContext">Clear</button>
    <span id="status">Ready</span>
  </div>
  <div class="modebar">
    <button id="planMode">Plan</button>
    <button id="implementMode">Implement</button>
  </div>
  <div id="context"></div>
  <div id="messages"></div>
  <div class="composer">
    <textarea id="input" placeholder="Ask about this workspace"></textarea>
    <div class="composer-actions">
      <button class="primary" id="send">Send</button>
      <button id="stop">Stop</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const input = document.getElementById('input');
    const context = document.getElementById('context');
    const status = document.getElementById('status');
    const planMode = document.getElementById('planMode');
    const implementMode = document.getElementById('implementMode');
    let currentAssistant;
    let lastPlan = '';

    document.getElementById('send').addEventListener('click', send);
    document.getElementById('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
    document.getElementById('configure').addEventListener('click', () => vscode.postMessage({ type: 'configure' }));
    document.getElementById('token').addEventListener('click', () => vscode.postMessage({ type: 'setToken' }));
    document.getElementById('addFile').addEventListener('click', () => vscode.postMessage({ type: 'addCurrentFile' }));
    document.getElementById('clearContext').addEventListener('click', () => vscode.postMessage({ type: 'clearContext' }));
    planMode.addEventListener('click', () => vscode.postMessage({ type: 'setMode', mode: 'plan' }));
    implementMode.addEventListener('click', () => vscode.postMessage({ type: 'setMode', mode: 'implement' }));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        send();
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'context') renderContext(message.items ?? []);
      if (message.type === 'state') renderState(message);
      if (message.type === 'setInput') input.value = message.text ?? '';
      if (message.type === 'status') status.textContent = message.text;
      if (message.type === 'user') appendMessage('user', message.text);
      if (message.type === 'assistantStart') currentAssistant = appendMessage('assistant', '');
      if (message.type === 'assistantDelta' && currentAssistant) {
        currentAssistant.textContent += message.text;
        messages.scrollTop = messages.scrollHeight;
      }
      if (message.type === 'assistantDone') currentAssistant = undefined;
      if (message.type === 'planActions') renderPlanActions(message.text ?? '');
      if (message.type === 'assistantError') {
        if (currentAssistant) currentAssistant.remove();
        currentAssistant = undefined;
        appendMessage('error', message.text);
      }
    });

    function send() {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      vscode.postMessage({ type: 'send', text });
    }

    function appendMessage(kind, text) {
      const element = document.createElement('div');
      element.className = 'message ' + kind;
      element.textContent = text;
      messages.appendChild(element);
      messages.scrollTop = messages.scrollHeight;
      return element;
    }

    function renderState(state) {
      planMode.classList.toggle('active', state.mode === 'plan');
      implementMode.classList.toggle('active', state.mode === 'implement');
      const scope = state.activeScope ? ' · ' + state.activeScope : '';
      status.textContent = (state.mode === 'implement' ? 'Implement' : 'Plan') + scope;
    }

    function renderPlanActions(planText) {
      lastPlan = planText;
      const actions = document.createElement('div');
      actions.className = 'plan-actions';
      const implement = actionButton('Implement Plan', () => vscode.postMessage({ type: 'implementPlan', text: lastPlan }));
      const refine = actionButton('Refine Plan', () => vscode.postMessage({ type: 'refinePlan', text: lastPlan }));
      const discard = actionButton('Discard', () => actions.remove());
      const remember = actionButton('Remember', () => vscode.postMessage({ type: 'remember', text: lastPlan }));
      const clear = actionButton('Clear Context', () => vscode.postMessage({ type: 'clearContext' }));
      actions.append(implement, refine, discard, remember, clear);
      messages.appendChild(actions);
      messages.scrollTop = messages.scrollHeight;
    }

    function actionButton(label, handler) {
      const button = document.createElement('button');
      button.textContent = label;
      button.addEventListener('click', handler);
      return button;
    }

    function renderContext(items) {
      context.textContent = '';
      for (const item of items) {
        const chip = document.createElement('div');
        chip.className = 'chip';
        const label = document.createElement('span');
        label.textContent = item.label;
        const remove = document.createElement('button');
        remove.textContent = 'x';
        remove.title = 'Remove';
        remove.addEventListener('click', () => vscode.postMessage({ type: 'removeContext', id: item.id }));
        chip.append(label, remove);
        context.appendChild(chip);
      }
    }
  </script>
</body>
</html>`;
  }
}

export async function configureServer(): Promise<void> {
  const current = vscode.workspace.getConfiguration("companyCodeAI");
  const serverUrl = await vscode.window.showInputBox({
    title: "Internal LLM server URL",
    value: current.get<string>("serverUrl", ""),
    ignoreFocusOut: true,
  });
  if (serverUrl !== undefined) {
    await updateSetting("serverUrl", serverUrl.trim());
  }

  const model = await vscode.window.showInputBox({
    title: "Internal model",
    value: current.get<string>("model", ""),
    ignoreFocusOut: true,
  });
  if (model !== undefined) {
    await updateSetting("model", model.trim());
  }
}

export async function setAuthToken(secrets: vscode.SecretStorage): Promise<void> {
  const token = await vscode.window.showInputBox({
    title: "Internal LLM auth token",
    password: true,
    ignoreFocusOut: true,
  });
  if (token !== undefined) {
    await secrets.store(secretTokenKey, token.trim());
    vscode.window.showInformationMessage("Company Code AI token saved.");
  }
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
