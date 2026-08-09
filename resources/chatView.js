const vscode = acquireVsCodeApi();
const messages = document.getElementById("messages");
const input = document.getElementById("input");
const context = document.getElementById("context");
const status = document.getElementById("status");
const planMode = document.getElementById("planMode");
const implementMode = document.getElementById("implementMode");
let currentAssistant;
let assistantBuffer = "";
let timerId;
let activeStartedAt = 0;
let activePhase = "실행 중";
let lastPlan = "";
let activeChangeQuestion;
let activeChangeActions;

document.getElementById("send").addEventListener("click", send);
document.getElementById("stop").addEventListener("click", () => vscode.postMessage({ type: "stop" }));
document.getElementById("configure").addEventListener("click", () => vscode.postMessage({ type: "configure" }));
document.getElementById("token").addEventListener("click", () => vscode.postMessage({ type: "setToken" }));
document.getElementById("addFile").addEventListener("click", () => vscode.postMessage({ type: "addCurrentFile" }));
document.getElementById("initSummary").addEventListener("click", () => vscode.postMessage({ type: "initSummary" }));
document.getElementById("clearContext").addEventListener("click", () => vscode.postMessage({ type: "clearContext" }));
planMode.addEventListener("click", () => vscode.postMessage({ type: "setMode", mode: "plan" }));
implementMode.addEventListener("click", () => vscode.postMessage({ type: "setMode", mode: "implement" }));
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    send();
  }
});

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "context") renderContext(message.items ?? []);
  if (message.type === "state") renderState(message);
  if (message.type === "setInput") input.value = message.text ?? "";
  if (message.type === "status") setStatus(message.text);
  if (message.type === "user") appendMessage("user", message.text);
  if (message.type === "assistant") appendMessage("assistant", message.text);
  if (message.type === "operation") appendOperation(message.text);
  if (message.type === "assistantStart") startAssistant(message.text ?? "실행 중");
  if (message.type === "assistantDelta" && currentAssistant) {
    assistantBuffer += message.text ?? "";
  }
  if (message.type === "assistantReplace" && currentAssistant) {
    assistantBuffer = message.text ?? "";
  }
  if (message.type === "assistantDone") finishAssistant();
  if (message.type === "planActions") renderPlanActions(message.text ?? "");
  if (message.type === "changeActions") renderChangeActions(message.text);
  if (message.type === "clearChangeActions") clearChangeActions();
  if (message.type === "workbenchOffer") renderWorkbenchOffer();
  if (message.type === "workbenchState") renderWorkbenchState(message.state);
  if (message.type === "assistantError") {
    stopTimer();
    if (currentAssistant) currentAssistant.remove();
    currentAssistant = undefined;
    assistantBuffer = "";
    appendMessage("error", message.text);
  }
});

function send() {
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  vscode.postMessage({ type: "send", text });
}

function appendMessage(kind, text, followOverride) {
  const shouldFollow = followOverride ?? isNearMessagesBottom();
  const element = document.createElement("div");
  element.className = "message " + kind;
  element.textContent = text;
  messages.appendChild(element);
  scrollMessagesToBottom(shouldFollow);
  return element;
}

function appendOperation(text) {
  if (!text) return;
  appendMessage("operation", text);
}

function startAssistant(phase) {
  stopTimer();
  assistantBuffer = "";
  currentAssistant = appendMessage("assistant working", "");
  startTimer(phase);
}

function finishAssistant() {
  stopTimer();
  if (currentAssistant) {
    const shouldFollow = isNearMessagesBottom();
    currentAssistant.classList.remove("working");
    currentAssistant.textContent = assistantBuffer.trimEnd() || "완료되었습니다.";
    scrollMessagesToBottom(shouldFollow);
  }
  currentAssistant = undefined;
  assistantBuffer = "";
}

function setStatus(text) {
  if (timerId && text && text !== "준비" && text !== "오류") {
    activePhase = text;
    renderTimer();
    return;
  }
  status.textContent = text ?? "";
}

function startTimer(phase) {
  activePhase = phase || "실행 중";
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
  const text = activePhase + " " + elapsed;
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
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return minutes + ":" + seconds;
}

function renderState(state) {
  planMode.classList.toggle("active", state.mode === "plan");
  implementMode.classList.toggle("active", state.mode === "implement");
  const scope = state.activeScope ? " - " + state.activeScope : "";
  if (timerId) return;
  status.textContent = (state.mode === "implement" ? "구현" : "계획") + scope;
}

function renderChangeActions(text) {
  const shouldFollow = isNearMessagesBottom();
  clearChangeActions();
  activeChangeQuestion = appendMessage("assistant", text || "위 변경안을 실제 파일에 적용하시겠습니까?", shouldFollow);
  const actions = document.createElement("div");
  actions.className = "plan-actions";
  const apply = actionButton("예, 파일에 적용", () => {
    clearChangeActions();
    vscode.postMessage({ type: "approveChangeProposal" });
  });
  const discard = actionButton("아니오, 버리기", () => {
    clearChangeActions();
    vscode.postMessage({ type: "rejectChangeProposal" });
  });
  actions.append(apply, discard);
  messages.appendChild(actions);
  activeChangeActions = actions;
  scrollMessagesToBottom(shouldFollow);
}

function renderWorkbenchOffer() {
  const shouldFollow = isNearMessagesBottom();
  clearChangeActions();
  activeChangeQuestion = appendMessage(
    "assistant",
    "응답에서 코드 블록을 자동으로 찾지 못했습니다. 수동 변경 작업대를 열 수 있습니다.",
    shouldFollow,
  );
  const actions = document.createElement("div");
  actions.className = "plan-actions";
  actions.append(
    actionButton("빈 변경 작업대 열기", () => vscode.postMessage({ type: "createManualWorkbench" })),
    actionButton("응답만 유지", () => clearChangeActions()),
  );
  messages.appendChild(actions);
  activeChangeActions = actions;
  scrollMessagesToBottom(shouldFollow);
}

function renderWorkbenchState(state) {
  if (!state) {
    clearChangeActions();
    return;
  }
  const shouldFollow = isNearMessagesBottom();
  clearChangeActions();
  const mapped = (state.blocks ?? []).filter((block) => block.mappingStatus === "mapped").length;
  const changed = (state.files ?? []).filter((file) => file.changed).length;
  const summary = `AI 블록 ${state.blocks?.length ?? 0}개 · 매핑 ${mapped}개 · 변경 파일 ${changed}개`;
  activeChangeQuestion = appendMessage(
    "assistant",
    [state.message, summary].filter(Boolean).join("\n\n"),
    shouldFollow,
  );
  const actions = document.createElement("div");
  actions.className = "plan-actions";
  actions.appendChild(actionButton("변경 작업대 열기", () => vscode.postMessage({ type: "openWorkbench" })));
  actions.appendChild(actionButton("작업대 버리기", () => vscode.postMessage({ type: "discardWorkbench" })));
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
  const actions = document.createElement("div");
  actions.className = "plan-actions";
  const implement = actionButton("계획 구현", () => {
    actions.remove();
    vscode.postMessage({ type: "implementPlan", text: lastPlan });
  });
  const refine = actionButton("계획 다듬기", () => {
    actions.remove();
    vscode.postMessage({ type: "refinePlan", text: lastPlan });
  });
  const discard = actionButton("버리기", () => actions.remove());
  const remember = actionButton("기억하기", () => vscode.postMessage({ type: "remember", text: lastPlan }));
  const clear = actionButton("컨텍스트 비우기", () => vscode.postMessage({ type: "clearContext" }));
  actions.append(implement, refine, discard, remember, clear);
  messages.appendChild(actions);
  scrollMessagesToBottom(shouldFollow);
}

function actionButton(label, handler) {
  const button = document.createElement("button");
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function renderContext(items) {
  context.textContent = "";
  for (const item of items) {
    const chip = document.createElement("div");
    chip.className = "chip";
    const label = document.createElement("span");
    label.textContent = item.label;
    const remove = document.createElement("button");
    remove.textContent = "x";
    remove.title = "제거";
    remove.addEventListener("click", () => vscode.postMessage({ type: "removeContext", id: item.id }));
    chip.append(label, remove);
    context.appendChild(chip);
  }
}
