import * as vscode from "vscode";
import { CodeAgent } from "./agent";
import { readRuntimeConfig, secretTokenKey, updateSetting } from "./config";
import { ContextManager } from "./context";
import { ModeManager } from "./modeManager";
import { SessionStore } from "./sessionStore";
import { AgentMode, ProposalSessionState } from "./types";
import { ProposalManager } from "./proposalManager";
import { formatPatchApplyOutcome } from "./tools";

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
  private lastImplementation?: { prompt: string; response: string };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: vscode.SecretStorage,
    private readonly contextManager: ContextManager,
    private readonly modeManager: ModeManager,
    private readonly sessionStore: SessionStore,
    private readonly agent: CodeAgent,
    private readonly proposalManager: ProposalManager,
  ) {
    this.contextManager.onDidChange(() => this.postContext());
    this.modeManager.onDidChange(() => this.postState());
    this.proposalManager.onDidChangeState((state) => this.postProposalState(state));
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
    void this.proposalManager.currentState().then((state) => this.postProposalState(state));
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
      case "createProposal":
        await this.createProposal();
        break;
      case "openProposal":
        await this.runProposalAction(() => this.proposalManager.openDraft());
        break;
      case "reviewProposal":
        await this.runProposalAction(() => this.proposalManager.openFinalDiff());
        break;
      case "applyProposal":
        await this.applyProposal();
        break;
      case "discardProposal":
        await this.runProposalAction(() => this.proposalManager.discard());
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

  private async createProposal(): Promise<void> {
    if (!this.lastImplementation) {
      vscode.window.showWarningMessage("AI 작업본으로 만들 최근 구현 응답이 없습니다.");
      return;
    }
    if (this.abortController) {
      vscode.window.showWarningMessage("Company Code AI 요청이 이미 실행 중입니다.");
      return;
    }
    this.view?.webview.postMessage({ type: "assistantStart", text: "AI 작업본 준비 중" });
    this.view?.webview.postMessage({ type: "status", text: "AI 작업본 준비 중" });
    this.abortController = new AbortController();
    try {
      const config = await readRuntimeConfig(this.secrets);
      const state = await this.proposalManager.create(
        this.lastImplementation.prompt,
        this.lastImplementation.response,
        this.contextManager.list(),
        config,
        async (status) => {
          await this.view?.webview.postMessage({ type: "status", text: status });
        },
        this.abortController.signal,
      );
      this.view?.webview.postMessage({ type: "assistantReplace", text: "AI 작업본을 만들었습니다. 편집기에서 conflict를 해결하고 완성본을 검토하세요." });
      this.view?.webview.postMessage({ type: "assistantDone" });
      this.postProposalState(state);
      this.view?.webview.postMessage({ type: "status", text: "작업본 편집 중" });
    } catch (error) {
      this.view?.webview.postMessage({ type: "assistantError", text: error instanceof Error ? error.message : String(error) });
      this.view?.webview.postMessage({ type: "status", text: "작업본 생성 실패" });
    } finally {
      this.abortController = undefined;
    }
  }

  private async applyProposal(): Promise<void> {
    await this.runProposalAction(async () => {
      const outcome = await this.proposalManager.apply();
      this.view?.webview.postMessage({ type: "assistant", text: formatPatchApplyOutcome(outcome) });
      this.view?.webview.postMessage({ type: "status", text: outcome.status === "applied" ? "파일 변경 완료" : "파일 미변경" });
    });
  }

  private async runProposalAction(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(text);
      this.view?.webview.postMessage({ type: "assistant", text });
      this.view?.webview.postMessage({ type: "status", text: "작업본 오류" });
    }
  }

  private postProposalState(state: ProposalSessionState | undefined): void {
    this.view?.webview.postMessage({ type: "proposalState", state });
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
      const displayResponse =
        this.modeManager.current === "implement" && response.trim() && !this.agent.lastRunAppliedChange
          ? stripTrailingPatchApprovalPrompt(response)
          : response;
      this.view?.webview.postMessage({ type: "assistantReplace", text: displayResponse });
      await this.sessionStore.recordTurn("assistant", displayResponse);
      this.view?.webview.postMessage({ type: "assistantDone" });
      if (this.modeManager.current === "plan" && response.trim()) {
        this.view?.webview.postMessage({ type: "planActions", text: response });
      }
      if (this.modeManager.current === "implement" && displayResponse.trim() && !this.agent.lastRunAppliedChange) {
        this.lastImplementation = { prompt, response: displayResponse };
        this.view?.webview.postMessage({ type: "proposalOffer" });
        this.view?.webview.postMessage({ type: "status", text: "AI 작업본 생성 대기" });
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
    return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const input = document.getElementById('input');
    const context = document.getElementById('context');
    const status = document.getElementById('status');
    const planMode = document.getElementById('planMode');
    const implementMode = document.getElementById('implementMode');
    let currentAssistant;
    let assistantBuffer = '';
    let timerId;
    let activeStartedAt = 0;
    let activePhase = '실행 중';
    let lastPlan = '';
    let activeChangeQuestion;
    let activeChangeActions;

    document.getElementById('send').addEventListener('click', send);
    document.getElementById('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
    document.getElementById('configure').addEventListener('click', () => vscode.postMessage({ type: 'configure' }));
    document.getElementById('token').addEventListener('click', () => vscode.postMessage({ type: 'setToken' }));
    document.getElementById('addFile').addEventListener('click', () => vscode.postMessage({ type: 'addCurrentFile' }));
    document.getElementById('initSummary').addEventListener('click', () => vscode.postMessage({ type: 'initSummary' }));
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
      if (message.type === 'status') setStatus(message.text);
      if (message.type === 'user') appendMessage('user', message.text);
      if (message.type === 'assistant') appendMessage('assistant', message.text);
      if (message.type === 'assistantStart') startAssistant(message.text ?? '실행 중');
      if (message.type === 'assistantDelta' && currentAssistant) {
        assistantBuffer += message.text ?? '';
      }
      if (message.type === 'assistantReplace' && currentAssistant) {
        assistantBuffer = message.text ?? '';
      }
      if (message.type === 'assistantDone') finishAssistant();
      if (message.type === 'planActions') renderPlanActions(message.text ?? '');
      if (message.type === 'changeActions') renderChangeActions(message.text);
      if (message.type === 'clearChangeActions') clearChangeActions();
      if (message.type === 'proposalOffer') renderProposalOffer();
      if (message.type === 'proposalState') renderProposalState(message.state);
      if (message.type === 'assistantError') {
        stopTimer();
        if (currentAssistant) currentAssistant.remove();
        currentAssistant = undefined;
        assistantBuffer = '';
        appendMessage('error', message.text);
      }
    });

    function send() {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      vscode.postMessage({ type: 'send', text });
    }

    function appendMessage(kind, text, followOverride) {
      const shouldFollow = followOverride ?? isNearMessagesBottom();
      const element = document.createElement('div');
      element.className = 'message ' + kind;
      element.textContent = text;
      messages.appendChild(element);
      scrollMessagesToBottom(shouldFollow);
      return element;
    }

    function startAssistant(phase) {
      stopTimer();
      assistantBuffer = '';
      currentAssistant = appendMessage('assistant working', '');
      startTimer(phase);
    }

    function finishAssistant() {
      stopTimer();
      if (currentAssistant) {
        const shouldFollow = isNearMessagesBottom();
        currentAssistant.classList.remove('working');
        currentAssistant.textContent = assistantBuffer.trimEnd() || '완료되었습니다.';
        scrollMessagesToBottom(shouldFollow);
      }
      currentAssistant = undefined;
      assistantBuffer = '';
    }

    function setStatus(text) {
      if (timerId && text && text !== '준비' && text !== '오류') {
        activePhase = text;
        renderTimer();
        return;
      }
      status.textContent = text ?? '';
    }

    function startTimer(phase) {
      activePhase = phase || '실행 중';
      activeStartedAt = Date.now();
      timerId = window.setInterval(renderTimer, 1000);
      renderTimer();
    }

    function stopTimer() {
      if (timerId) {
        window.clearInterval(timerId);
        timerId = undefined;
      }
    }

    function renderTimer() {
      const elapsedSeconds = Math.floor((Date.now() - activeStartedAt) / 1000);
      const elapsed = formatElapsed(elapsedSeconds);
      const text = activePhase + ' ' + elapsed;
      status.textContent = text;
      if (currentAssistant) {
        const shouldFollow = isNearMessagesBottom();
        currentAssistant.textContent = text;
        scrollMessagesToBottom(shouldFollow);
      }
    }

    function isNearMessagesBottom() {
      return messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 24;
    }

    function scrollMessagesToBottom(shouldFollow) {
      if (shouldFollow) {
        messages.scrollTop = messages.scrollHeight;
      }
    }

    function formatElapsed(totalSeconds) {
      const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
      const seconds = (totalSeconds % 60).toString().padStart(2, '0');
      return minutes + ':' + seconds;
    }

    function renderState(state) {
      planMode.classList.toggle('active', state.mode === 'plan');
      implementMode.classList.toggle('active', state.mode === 'implement');
      const scope = state.activeScope ? ' - ' + state.activeScope : '';
      if (timerId) return;
      status.textContent = (state.mode === 'implement' ? '구현' : '계획') + scope;
    }

    function renderChangeActions(text) {
      const shouldFollow = isNearMessagesBottom();
      clearChangeActions();
      activeChangeQuestion = appendMessage('assistant', text || '위 변경안을 실제 파일에 적용하시겠습니까?', shouldFollow);
      const actions = document.createElement('div');
      actions.className = 'plan-actions';
      const apply = actionButton('예, 파일에 적용', () => {
        clearChangeActions();
        vscode.postMessage({ type: 'approveChangeProposal' });
      });
      const discard = actionButton('아니오, 버리기', () => {
        clearChangeActions();
        vscode.postMessage({ type: 'rejectChangeProposal' });
      });
      actions.append(apply, discard);
      messages.appendChild(actions);
      activeChangeActions = actions;
      scrollMessagesToBottom(shouldFollow);
    }

    function renderProposalOffer() {
      const shouldFollow = isNearMessagesBottom();
      clearChangeActions();
      activeChangeQuestion = appendMessage(
        'assistant',
        '원본 파일은 아직 변경되지 않았습니다. 수정할 파일과 코드 범위를 선택해 편집 가능한 AI 작업본을 만드세요.',
        shouldFollow,
      );
      const actions = document.createElement('div');
      actions.className = 'plan-actions';
      actions.append(
        actionButton('AI 작업본 만들기', () => vscode.postMessage({ type: 'createProposal' })),
        actionButton('응답만 유지', () => clearChangeActions()),
      );
      messages.appendChild(actions);
      activeChangeActions = actions;
      scrollMessagesToBottom(shouldFollow);
    }

    function renderProposalState(state) {
      if (!state) {
        clearChangeActions();
        return;
      }
      const shouldFollow = isNearMessagesBottom();
      clearChangeActions();
      const unresolved = (state.files ?? []).reduce((total, file) => total + (file.unresolvedConflicts ?? 0), 0);
      const files = (state.files ?? []).map((file) => file.path + ' (남은 conflict ' + file.unresolvedConflicts + '개)').join('\n');
      activeChangeQuestion = appendMessage(
        'assistant',
        [state.message, files, '작업본의 conflict를 해결한 뒤 완성본을 검토하고 원본에 저장하세요.'].filter(Boolean).join('\n\n'),
        shouldFollow,
      );
      const actions = document.createElement('div');
      actions.className = 'plan-actions';
      actions.appendChild(actionButton('작업본 열기', () => vscode.postMessage({ type: 'openProposal' })));
      if (unresolved === 0) {
        actions.appendChild(actionButton('완성본 검토', () => vscode.postMessage({ type: 'reviewProposal' })));
        if (state.status === 'reviewed') {
          actions.appendChild(actionButton('원본에 저장', () => vscode.postMessage({ type: 'applyProposal' })));
        }
      }
      actions.appendChild(actionButton('작업본 버리기', () => vscode.postMessage({ type: 'discardProposal' })));
      messages.appendChild(actions);
      activeChangeActions = actions;
      scrollMessagesToBottom(shouldFollow);
    }

    function clearChangeActions() {
      if (activeChangeQuestion) {
        activeChangeQuestion.remove();
        activeChangeQuestion = undefined;
      }
      if (activeChangeActions) {
        activeChangeActions.remove();
        activeChangeActions = undefined;
      }
    }

    function renderPlanActions(planText) {
      const shouldFollow = isNearMessagesBottom();
      lastPlan = planText;
      const actions = document.createElement('div');
      actions.className = 'plan-actions';
      const implement = actionButton('계획 구현', () => {
        actions.remove();
        vscode.postMessage({ type: 'implementPlan', text: lastPlan });
      });
      const refine = actionButton('계획 다듬기', () => {
        actions.remove();
        vscode.postMessage({ type: 'refinePlan', text: lastPlan });
      });
      const discard = actionButton('버리기', () => actions.remove());
      const remember = actionButton('기억하기', () => vscode.postMessage({ type: 'remember', text: lastPlan }));
      const clear = actionButton('컨텍스트 비우기', () => vscode.postMessage({ type: 'clearContext' }));
      actions.append(implement, refine, discard, remember, clear);
      messages.appendChild(actions);
      scrollMessagesToBottom(shouldFollow);
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
        remove.title = '제거';
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
