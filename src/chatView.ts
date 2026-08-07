import * as vscode from "vscode";
import { CodeAgent } from "./agent";
import { readRuntimeConfig, secretTokenKey, updateSetting } from "./config";
import { ContextManager } from "./context";
import { ModeManager } from "./modeManager";
import { SessionStore } from "./sessionStore";
import { AgentMode, AiChangeBlock, ChangeWorkbenchState } from "./types";
import { ChangeWorkbenchManager } from "./changeWorkbench";

interface WebviewMessage {
  type: string;
  text?: string;
  id?: string;
  mode?: AgentMode;
}

interface SendOptions {
  displayText?: string;
  statusText?: string;
  phaseText?: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private abortController?: AbortController;
  private lastImplementation?: { prompt: string; response: string; blocks: AiChangeBlock[] };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: vscode.SecretStorage,
    private readonly contextManager: ContextManager,
    private readonly modeManager: ModeManager,
    private readonly sessionStore: SessionStore,
    private readonly agent: CodeAgent,
    private readonly changeWorkbench: ChangeWorkbenchManager,
  ) {
    this.contextManager.onDidChange(() => this.postContext());
    this.modeManager.onDidChange(() => this.postState());
    this.changeWorkbench.onDidChangeState((state) => this.postWorkbenchState(state));
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
    void this.changeWorkbench.currentState().then((state) => this.postWorkbenchState(state));
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
      case "initSummary":
        await vscode.commands.executeCommand("companyCodeAI.initProjectSummary");
        break;
      case "implementPlan":
        await this.implementPlan(message.text ?? "");
        break;
      case "openWorkbench":
        await this.runWorkbenchAction(() => this.changeWorkbench.open());
        break;
      case "createManualWorkbench":
        await this.createManualWorkbench();
        break;
      case "discardWorkbench":
        await this.runWorkbenchAction(() => this.changeWorkbench.discard());
        break;
      case "refinePlan":
        this.view?.webview.postMessage({ type: "setInput", text: `이 계획을 더 구체화해줘:\n\n${message.text ?? ""}` });
        break;
      case "remember":
        await this.sessionStore.remember(message.text ?? "");
        vscode.window.showInformationMessage("선택한 내용을 Company Code AI가 기억했습니다.");
        break;
    }
  }

  async clearContextMenu(): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      [
        { label: "추가 컨텍스트만 비우기", description: "추가한 파일과 선택 영역만 제거합니다." },
        { label: "채팅 세션 비우기", description: "최근 대화와 세션 요약을 지웁니다." },
        { label: "프로젝트 메모리 비우기", description: "저장된 프로젝트 메모리를 지웁니다." },
        { label: "모두 비우기", description: "추가 컨텍스트, 채팅 세션, 프로젝트 메모리를 모두 지웁니다." },
      ],
      { title: "Company Code AI: 컨텍스트 비우기" },
    );
    if (!choice) {
      return;
    }
    if (choice.label === "추가 컨텍스트만 비우기") {
      this.contextManager.clear();
    } else if (choice.label === "채팅 세션 비우기") {
      await this.sessionStore.clearAddedSession();
    } else if (choice.label === "프로젝트 메모리 비우기") {
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
      vscode.window.showWarningMessage("AI가 적용한 변경 스냅샷이 없습니다.");
      return;
    }
    this.contextManager.addNote(`AI change ${changeSet.id}`, this.sessionStore.renderChangeSetDiff(changeSet));
    await this.modeManager.set("plan");
    await this.reveal();
    await this.send("마지막으로 AI가 적용한 변경을 리뷰해줘. 회귀 가능성, 놓친 엣지 케이스, 요청한 계획과 구현이 일치하는지를 중심으로 한국어로 검토해줘.");
  }

  private async implementPlan(plan: string): Promise<void> {
    const trimmed = plan.trim();
    if (!trimmed) {
      return;
    }
    await this.modeManager.set("implement");
    await this.send(
      `승인된 아래 계획을 구현해줘. 변경 범위는 최소화해줘. 채팅 텍스트로 패치 적용 여부를 예/아니오로 묻지 마세요. 파일 변경 적용 승인은 확장 UI가 버튼으로 처리합니다. 설명은 한국어로 작성해줘.\n\n${trimmed}`,
      {
        displayText: "선택한 계획 구현을 시작합니다.",
        phaseText: "계획 구현 중",
        statusText: "계획 구현 중",
      },
    );
  }

  private async createManualWorkbench(): Promise<void> {
    if (!this.lastImplementation) {
      vscode.window.showWarningMessage("변경 작업대로 만들 최근 구현 응답이 없습니다.");
      return;
    }
    const implementation = this.lastImplementation;
    await this.runWorkbenchAction(async () => {
      const state = await this.changeWorkbench.createManual(
        implementation.prompt,
        implementation.response,
        this.contextManager.list(),
      );
      this.postWorkbenchState(state);
      this.view?.webview.postMessage({ type: "status", text: "변경 작업대 편집 중" });
    });
  }

  private async runWorkbenchAction(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(text);
      this.view?.webview.postMessage({ type: "assistant", text });
      this.view?.webview.postMessage({ type: "status", text: "변경 작업대 오류" });
    }
  }

  private postWorkbenchState(state: ChangeWorkbenchState | undefined): void {
    this.view?.webview.postMessage({ type: "workbenchState", state });
  }

  private async send(text: string, options: SendOptions = {}): Promise<void> {
    const prompt = text.trim();
    if (!prompt) {
      return;
    }
    if (this.abortController) {
      vscode.window.showWarningMessage("Company Code AI 요청이 이미 실행 중입니다.");
      return;
    }
    const slash = prompt.toLowerCase();
    if (slash === "/init" || slash === "/init refresh" || slash === "/init --refresh") {
      await vscode.commands.executeCommand(slash.includes("refresh") ? "companyCodeAI.refreshProjectSummary" : "companyCodeAI.initProjectSummary");
      return;
    }
    if (slash === "/summary") {
      await vscode.commands.executeCommand("companyCodeAI.openProjectSummary");
      return;
    }

    this.view?.webview.postMessage({ type: "user", text: options.displayText ?? prompt });
    this.view?.webview.postMessage({ type: "assistantStart", text: options.phaseText ?? "실행 중" });
    this.view?.webview.postMessage({ type: "status", text: options.statusText ?? "실행 중" });

    this.abortController = new AbortController();
    try {
      const config = await readRuntimeConfig(this.secrets);
      await this.sessionStore.recordTurn("user", prompt);
      const result = await this.agent.run(
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
      const response = result.content;
      const displayResponse = this.modeManager.current === "implement" && response.trim()
        ? stripTrailingPatchApprovalPrompt(response)
        : response;
      this.view?.webview.postMessage({ type: "assistantReplace", text: displayResponse });
      await this.sessionStore.recordTurn("assistant", displayResponse);
      this.view?.webview.postMessage({ type: "assistantDone" });
      if (this.modeManager.current === "plan" && response.trim()) {
        this.view?.webview.postMessage({ type: "planActions", text: response });
      }
      if (this.modeManager.current === "implement" && displayResponse.trim() && !this.agent.lastRunAppliedChange) {
        this.lastImplementation = { prompt, response: displayResponse, blocks: result.changeBlocks };
        if (result.changeBlocks.length > 0) {
          this.view?.webview.postMessage({ type: "status", text: "변경 작업대 여는 중" });
          const state = await this.changeWorkbench.create(prompt, displayResponse, result.changeBlocks, this.contextManager.list());
          this.postWorkbenchState(state);
          this.view?.webview.postMessage({ type: "assistant", text: `코드 변경 블록 ${result.changeBlocks.length}개를 변경 작업대에 열었습니다.` });
          this.view?.webview.postMessage({ type: "status", text: "변경 작업대 편집 중" });
        } else {
          this.view?.webview.postMessage({ type: "workbenchOffer" });
          this.view?.webview.postMessage({ type: "status", text: "코드 블록 없음" });
        }
      } else {
        this.view?.webview.postMessage({ type: "status", text: "준비" });
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.view?.webview.postMessage({ type: "assistantError", text });
      this.view?.webview.postMessage({ type: "status", text: "오류" });
    } finally {
      this.abortController = undefined;
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = createNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "resources", "chatView.js"));
    return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      color-scheme: light dark;
    }
    html,
    body {
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
    }
    body {
      display: flex;
      flex-direction: column;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }
    .top-controls {
      flex: 0 0 auto;
      min-width: 0;
      background: var(--vscode-sideBar-background);
      z-index: 1;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
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
      max-height: 88px;
      overflow-y: auto;
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
      flex: 1 1 auto;
      min-height: 0;
      padding: 10px 8px;
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
    .message.working {
      opacity: 0.78;
    }
    .plan-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: -6px 0 12px;
      padding: 0 2px;
    }
    .composer {
      flex: 0 0 auto;
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
  <div class="top-controls">
    <div class="toolbar">
      <button id="configure">서버</button>
      <button id="token">토큰</button>
      <button id="addFile">파일</button>
      <button id="initSummary" title="SUMMARY.md 생성 또는 갱신">초기화</button>
      <button id="clearContext">비우기</button>
      <span id="status">준비</span>
    </div>
    <div class="modebar">
      <button id="planMode">계획</button>
      <button id="implementMode">구현</button>
    </div>
    <div id="context"></div>
  </div>
  <div id="messages"></div>
  <div class="composer">
    <textarea id="input" placeholder="이 워크스페이스에 대해 요청하세요"></textarea>
    <div class="composer-actions">
      <button class="primary" id="send">전송</button>
      <button id="stop">중지</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

export async function configureServer(): Promise<void> {
  const current = vscode.workspace.getConfiguration("companyCodeAI");
  const serverUrl = await vscode.window.showInputBox({
    title: "사내 LLM 서버 URL",
    value: current.get<string>("serverUrl", ""),
    ignoreFocusOut: true,
  });
  if (serverUrl !== undefined) {
    await updateSetting("serverUrl", serverUrl.trim());
  }

  const model = await vscode.window.showInputBox({
    title: "사내 모델 이름",
    value: current.get<string>("model", ""),
    ignoreFocusOut: true,
  });
  if (model !== undefined) {
    await updateSetting("model", model.trim());
  }
}

export async function setAuthToken(secrets: vscode.SecretStorage): Promise<void> {
  const token = await vscode.window.showInputBox({
    title: "사내 LLM 인증 토큰",
    password: true,
    ignoreFocusOut: true,
  });
  if (token !== undefined) {
    await secrets.store(secretTokenKey, token.trim());
    vscode.window.showInformationMessage("Company Code AI 토큰을 저장했습니다.");
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

function stripTrailingPatchApprovalPrompt(text: string): string {
  let result = text.trimEnd();
  const approvalPromptPatterns = [
    /(?:\r?\n|^)\s*(?:\*\*)?\s*패치(?:를)?\s*적용하시겠습니까\??\s*(?:\*\*)?\s*(?:\(?\s*(?:예|y|yes)\s*\/\s*(?:아니오|아니요|n|no)\s*\)?)?\s*$/i,
    /(?:\r?\n|^)\s*(?:\*\*)?\s*변경안(?:을)?\s*적용하시겠습니까\??\s*(?:\*\*)?\s*(?:\(?\s*(?:예|y|yes)\s*\/\s*(?:아니오|아니요|n|no)\s*\)?)?\s*$/i,
  ];
  for (const pattern of approvalPromptPatterns) {
    result = result.replace(pattern, "").trimEnd();
  }
  return result;
}
