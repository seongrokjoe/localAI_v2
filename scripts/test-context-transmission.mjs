import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildContextTransmissionSection, formatContextTransmissionManifest } = require("../dist/contextTransmission.js");

const complete = buildContextTransmissionSection([{ label: "file: short.cpp", content: "one\ntwo\nthree", source: "explicit", maxTokens: 20000 }], 60000);
assert.equal(complete.entries[0].endLine, 3);
assert.equal(complete.entries[0].totalLines, 3);
assert.equal(complete.entries[0].truncated, false);
assert.match(complete.content, /lines=1-3 totalLines=3/);

const longLines = Array.from({ length: 30000 }, (_, index) => `line_${index}`).join("\n");
const truncated = buildContextTransmissionSection([{ label: "file: long.cpp", content: longLines, source: "explicit", maxTokens: 20000 }], 60000);
assert.equal(truncated.entries[0].truncated, true);
assert.equal(truncated.entries[0].truncationReason, "file-limit");
assert.equal(truncated.content.includes("line_29999"), false);
assert.match(formatContextTransmissionManifest(truncated.entries), /1~\d+ \/ 전체 30000줄/);

const budgeted = buildContextTransmissionSection([
  { label: "file: first.cpp", content: "a\n".repeat(100), source: "explicit", maxTokens: 20000 },
  { label: "file: omitted.cpp", content: "b\n".repeat(100), source: "explicit", maxTokens: 20000 },
], 80);
assert.equal(budgeted.entries[0].omitted, false);
assert.equal(budgeted.entries[1].omitted, true);
assert.match(formatContextTransmissionManifest(budgeted.entries), /omitted\.cpp: 전달 안 됨/);

const oneLine = buildContextTransmissionSection([{ label: "file: generated.cpp", content: "x".repeat(1000), source: "explicit", maxTokens: 20 }], 200);
assert.equal(oneLine.entries[0].partialEndColumn, 40);
assert.match(formatContextTransmissionManifest(oneLine.entries), /1줄 중 열 1~40/);

console.log("Context transmission manifest tests passed.");
