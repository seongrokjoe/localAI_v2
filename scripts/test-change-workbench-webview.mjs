import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

class Element {
  constructor(id = "", tag = "") {
    this.id = id;
    this.tag = tag;
    this.textContent = "";
    this.className = "";
    this.disabled = false;
    this.checked = false;
    this.children = [];
    this.listeners = new Map();
    this.classList = { toggle() {} };
  }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  dispatch(type) { this.listeners.get(type)?.({}); }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
}

const ids = ["tabs", "blocks", "status", "compare", "save", "saveAll", "validate", "discard"];
const elements = new Map(ids.map((id) => [id, new Element(id)]));
const created = [];
const posted = [];
let onMessage;
const document = {
  getElementById: (id) => elements.get(id),
  createElement: (tag) => {
    const element = new Element("", tag);
    created.push(element);
    return element;
  },
};
const window = { addEventListener: (type, handler) => { if (type === "message") onMessage = handler; } };
const acquireVsCodeApi = () => ({ postMessage: (message) => posted.push(message) });

new vm.Script(readFileSync("resources/changeWorkbench.js", "utf8"), { filename: "resources/changeWorkbench.js" })
  .runInNewContext({ acquireVsCodeApi, document, window });

assert.ok(onMessage);
onMessage({ data: { type: "state", state: {
  id: "session-1",
  activeFileId: "file-1",
  message: "준비",
  files: [{ id: "file-1", path: "src/a.cpp", draftPath: "draft/a.cpp", changed: true, saved: false, blockIds: ["block-1"] }],
  blocks: [{
    id: "block-1",
    fileId: "F001",
    targetFileId: "file-1",
    description: "수정",
    code: "int value = 2;",
    mappingStatus: "mapped",
    mappingLabel: "src/a.cpp: 연결됨",
    selected: false,
  }],
} } });

elements.get("compare").dispatch("click");
elements.get("save").dispatch("click");
elements.get("saveAll").dispatch("click");
elements.get("discard").dispatch("click");
const checkbox = created.find((element) => element.tag === "input");
checkbox.checked = true;
checkbox.dispatch("change");
created.find((element) => element.textContent === "복사").dispatch("click");

assert.deepEqual(JSON.parse(JSON.stringify(posted)), [
  { type: "compareFile", fileId: "file-1" },
  { type: "saveFile", fileId: "file-1" },
  { type: "saveAll" },
  { type: "discard" },
  { type: "toggleBlock", blockId: "block-1", checked: true },
  { type: "copyBlock", blockId: "block-1" },
]);

console.log("Change workbench webview tests passed.");
