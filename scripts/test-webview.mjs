import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...values) {
    for (const value of values) this.values.add(value);
  }

  remove(...values) {
    for (const value of values) this.values.delete(value);
  }

  toggle(value, force) {
    if (force === true) this.values.add(value);
    else if (force === false) this.values.delete(value);
    else if (this.values.has(value)) this.values.delete(value);
    else this.values.add(value);
  }
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.value = "";
    this.textContent = "";
    this.className = "";
    this.title = "";
    this.children = [];
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.clientHeight = 0;
    this.removed = false;
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  append(...children) {
    this.children.push(...children);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  remove() {
    this.removed = true;
  }
}

const requiredIds = [
  "messages",
  "input",
  "context",
  "status",
  "planMode",
  "implementMode",
  "send",
  "stop",
  "configure",
  "token",
  "addFile",
  "initSummary",
  "clearContext",
];
const elements = new Map(requiredIds.map((id) => [id, new FakeElement(id)]));
const createdElements = [];
const windowListeners = new Map();
const postedMessages = [];

const document = {
  getElementById(id) {
    return elements.get(id) ?? null;
  },
  createElement() {
    const element = new FakeElement();
    createdElements.push(element);
    return element;
  },
};
const window = {
  addEventListener(type, handler) {
    windowListeners.set(type, handler);
  },
  setInterval() {
    return 1;
  },
  clearInterval() {},
};
const acquireVsCodeApi = () => ({
  postMessage(message) {
    postedMessages.push(message);
  },
});

const source = readFileSync("resources/chatView.js", "utf8");
const script = new vm.Script(source, { filename: "resources/chatView.js" });
script.runInNewContext({ acquireVsCodeApi, document, window, Date });

function click(id) {
  const element = elements.get(id);
  assert.ok(element, `${id} element must exist`);
  assert.equal(element.listeners.get("click")?.length, 1, `${id} click listener must be registered`);
  element.dispatch("click");
}

function clickCreatedButton(label) {
  const button = createdElements.find((element) => !element.removed && element.textContent === label);
  assert.ok(button, `${label} button must be rendered`);
  button.dispatch("click");
}

click("configure");
click("token");
click("addFile");
click("initSummary");
click("clearContext");
click("planMode");
click("implementMode");
click("stop");

elements.get("input").value = "테스트 요청";
click("send");

const onMessage = windowListeners.get("message");
assert.ok(onMessage, "window message listener must be registered");
onMessage({ data: { type: "planActions", text: "계획 내용" } });
clickCreatedButton("계획 구현");
onMessage({ data: { type: "workbenchOffer" } });
clickCreatedButton("빈 변경 작업대 열기");
onMessage({
  data: {
    type: "workbenchState",
    state: {
      id: "session-1",
      message: "작업대 준비",
      files: [{ id: "file-1", path: "src/sample.cpp", changed: true }],
      blocks: [{ id: "block-1", mappingStatus: "mapped" }],
    },
  },
});
clickCreatedButton("변경 작업대 열기");

assert.deepEqual(
  JSON.parse(JSON.stringify(postedMessages)),
  [
    { type: "configure" },
    { type: "setToken" },
    { type: "addCurrentFile" },
    { type: "initSummary" },
    { type: "clearContext" },
    { type: "setMode", mode: "plan" },
    { type: "setMode", mode: "implement" },
    { type: "stop" },
    { type: "send", text: "테스트 요청" },
    { type: "implementPlan", text: "계획 내용" },
    { type: "createManualWorkbench" },
    { type: "openWorkbench" },
  ],
  "webview controls must post the expected extension messages",
);

console.log("Webview script syntax and control wiring tests passed.");
