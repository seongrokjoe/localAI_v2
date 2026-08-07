import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parseLineChangeResponse, renderNumberedFile } = require("../dist/lineChangeProtocol.js");
const { lineOperationOffsets, replacementForLineChange } = require("../dist/lineChangeMapping.js");

const protocolId = "PABC123";
const response = [
  "변경 설명입니다.",
  `<<<CCA_CHANGE_BEGIN:${protocolId}>>>`,
  "id=C001",
  "file=F001",
  "snapshot=sha256-one",
  "operation=replace",
  "startLine=10",
  "endLine=12",
  `<<<CCA_DESCRIPTION_BEGIN:${protocolId}>>>`,
  "메서드 반환값을 수정합니다.",
  `<<<CCA_DESCRIPTION_END:${protocolId}>>>`,
  `<<<CCA_CODE_BEGIN:${protocolId}>>>`,
  "int value = 2;",
  "return value;",
  `<<<CCA_CODE_END:${protocolId}>>>`,
  `<<<CCA_CHANGE_END:${protocolId}>>>`,
  `<<<CCA_CHANGE_BEGIN:${protocolId}>>>`,
  "id=C002",
  "file=NEW",
  "snapshot=NEW",
  "operation=create_file",
  "startLine=0",
  "endLine=0",
  "path=src/new-file.ts",
  `<<<CCA_CODE_BEGIN:${protocolId}>>>`,
  "export const created = true;",
  `<<<CCA_CODE_END:${protocolId}>>>`,
  `<<<CCA_CHANGE_END:${protocolId}>>>`,
].join("\n");

const parsed = parseLineChangeResponse(response, protocolId);
assert.equal(parsed.issues.length, 0);
assert.equal(parsed.changes.length, 2);
assert.equal(parsed.changes[0].fileId, "F001");
assert.equal(parsed.changes[0].startLine, 10);
assert.equal(parsed.changes[0].code, "int value = 2;\nreturn value;");
assert.equal(parsed.changes[1].operation, "create_file");
assert.equal(parsed.changes[1].path, "src/new-file.ts");

const wrongProtocol = parseLineChangeResponse(response, "POTHER");
assert.equal(wrongProtocol.changes.length, 0);
assert.match(wrongProtocol.issues[0], /protocolId/);

const fallback = parseLineChangeResponse([
  `<<<CCA_CODE_BEGIN:${protocolId}>>>`,
  "onlyCode();",
  `<<<CCA_CODE_END:${protocolId}>>>`,
].join("\n"), protocolId);
assert.equal(fallback.changes.length, 1);
assert.equal(fallback.changes[0].code, "onlyCode();");
assert.ok(fallback.changes[0].mappingError);

const numbered = renderNumberedFile({
  id: "F007",
  path: "src/sample.cpp",
  snapshot: "hash",
  text: "first\r\n\r\nthird",
  lineCount: 3,
}, 2, 3);
assert.match(numbered, /startLine="2" endLine="3"/);
assert.match(numbered, /000002\|\n000003\|third/);

const crlfSource = "one\r\ntwo\r\nthree";
assert.deepEqual(lineOperationOffsets(crlfSource, "replace", 2, 2), { start: 5, end: 10 });
assert.deepEqual(lineOperationOffsets(crlfSource, "insert_before", 2, 2), { start: 5, end: 5 });
assert.deepEqual(lineOperationOffsets(crlfSource, "insert_after", 2, 2), { start: 10, end: 10 });
assert.equal(lineOperationOffsets(crlfSource, "replace", 4, 4), undefined);
assert.equal(replacementForLineChange("replace", "TWO", "two\r\n", 5, crlfSource, "\r\n"), "TWO\r\n");
assert.equal(replacementForLineChange("insert_before", "added", "", 5, crlfSource, "\r\n"), "added\r\n");
assert.equal(replacementForLineChange("insert_after", "added", "", crlfSource.length, crlfSource, "\r\n"), "\r\nadded");

console.log("Line change protocol tests passed.");
