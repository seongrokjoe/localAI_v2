const vscode = acquireVsCodeApi();
const tabs = document.getElementById("tabs");
const blocks = document.getElementById("blocks");
const status = document.getElementById("status");
const compare = document.getElementById("compare");
const save = document.getElementById("save");
const discard = document.getElementById("discard");
let state;

compare.addEventListener("click", () => postForActiveFile("compareFile"));
save.addEventListener("click", () => postForActiveFile("saveFile"));
discard.addEventListener("click", () => vscode.postMessage({ type: "discard" }));

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "state") {
    state = message.state;
    render();
  }
  if (message.type === "status" || message.type === "operation" || message.type === "saveResult") {
    setStatus(message.text, message.ok === false);
  }
  if (message.type === "error") setStatus(message.text, true);
});

function render() {
  tabs.textContent = "";
  blocks.textContent = "";
  if (!state) {
    setStatus("진행 중인 작업대 없음");
    compare.disabled = true;
    save.disabled = true;
    return;
  }
  setStatus(state.message || "준비");
  const activeFile = state.files.find((file) => file.id === state.activeFileId);
  for (const file of state.files) {
    const button = document.createElement("button");
    button.textContent = (file.changed ? "● " : "") + file.path;
    button.classList.toggle("active", file.id === state.activeFileId);
    button.title = file.draftPath;
    button.addEventListener("click", () => vscode.postMessage({ type: "selectFile", fileId: file.id }));
    tabs.appendChild(button);
  }
  const unmapped = state.blocks.filter((block) => !block.fileId);
  if (unmapped.length > 0) {
    const button = document.createElement("button");
    button.textContent = `대상 미지정 ${unmapped.length}`;
    button.classList.toggle("active", !activeFile);
    button.addEventListener("click", () => renderBlocks(unmapped));
    tabs.appendChild(button);
  }
  compare.disabled = !activeFile;
  save.disabled = !activeFile || !activeFile.changed;
  renderBlocks(activeFile ? state.blocks.filter((block) => block.fileId === activeFile.id) : unmapped);
}

function renderBlocks(items) {
  blocks.textContent = "";
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "표시할 AI 코드 블록이 없습니다.";
    blocks.appendChild(empty);
    return;
  }
  for (const item of items) blocks.appendChild(blockCard(item));
}

function blockCard(item) {
  const card = document.createElement("section");
  card.className = "block";
  const head = document.createElement("div");
  head.className = "block-head";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = item.selected;
  checkbox.disabled = item.mappingStatus !== "mapped";
  checkbox.title = item.mappingStatus === "mapped" ? "오른쪽 작업 파일에 AI 코드 적용" : "먼저 대상 범위를 연결하세요";
  checkbox.addEventListener("change", () => {
    const checked = checkbox.checked;
    checkbox.disabled = true;
    vscode.postMessage({ type: "toggleBlock", blockId: item.id, checked });
  });
  const title = document.createElement("div");
  title.className = "block-title";
  const description = document.createElement("div");
  description.className = "description";
  description.textContent = item.description || item.pathHint || "AI 코드 제안";
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = item.mappingLabel;
  title.append(description, meta);
  head.append(checkbox, title);

  const code = document.createElement("pre");
  code.textContent = item.proposedText;
  code.tabIndex = 0;

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.appendChild(actionButton("복사", "copyBlock", item.id));
  if (!item.fileId) actions.appendChild(actionButton("대상 파일 선택", "chooseTarget", item.id));
  if (item.fileId && item.mappingStatus !== "mapped") actions.appendChild(actionButton("선택 범위 연결", "mapSelection", item.id));
  if (item.fileId) actions.appendChild(actionButton("오른쪽 파일 열기", "selectFile", undefined, item.fileId));
  card.append(head, code, actions);
  return card;
}

function actionButton(label, type, blockId, fileId) {
  const button = document.createElement("button");
  button.textContent = label;
  button.addEventListener("click", () => vscode.postMessage({ type, blockId, fileId }));
  return button;
}

function postForActiveFile(type) {
  if (!state?.activeFileId) return;
  vscode.postMessage({ type, fileId: state.activeFileId });
}

function setStatus(text, error = false) {
  status.textContent = text || "";
  status.classList.toggle("error", error);
}
