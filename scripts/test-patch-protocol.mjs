import assert from "node:assert/strict";
import { parsePatchResponse, parseTargetResponse } from "../dist/patchProtocol.js";
import { applyLineRangeChanges, findOriginalTextMatch } from "../dist/patchText.js";

const aliased = parsePatchResponse(
  JSON.stringify({
    message: "변경",
    changes: [{ file: "src/Test.cs", oldText: "int value = 1;", newText: "int value = 2;" }],
  }),
);
assert.equal(aliased.issues.length, 0);
assert.deepEqual(aliased.changes[0], {
  path: "src/Test.cs",
  originalText: "int value = 1;",
  replacementText: "int value = 2;",
  description: undefined,
});

const missingOriginal = parsePatchResponse(
  JSON.stringify({ changes: [{ filePath: "src/Test.cs", modifiedCode: "int value = 2;" }] }),
);
assert.equal(missingOriginal.changes.length, 0);
assert.match(missingOriginal.issues[0], /originalText/);

const expectedPathFallback = parsePatchResponse(
  '```json\n{"changes":[{"search":"old","replace":"new"}]}\n```',
  "src/Test.cs",
);
assert.equal(expectedPathFallback.issues.length, 0);
assert.equal(expectedPathFallback.changes[0].path, "src/Test.cs");

const targets = parseTargetResponse(JSON.stringify({ paths: ["src/Test.cs", "src/Test.cs", "src/New.cs"] }));
assert.deepEqual(targets.targetPaths, ["src/Test.cs", "src/New.cs"]);

const nested = parsePatchResponse(
  JSON.stringify({
    changes: [{ path: "src/Test.cs", edits: [{ originalCode: "old();", modifiedCode: "new();" }] }],
  }),
);
assert.equal(nested.issues.length, 0);
assert.equal(nested.changes[0].originalText, "old();");
assert.equal(nested.changes[0].replacementText, "new();");

const objectTargets = parseTargetResponse(JSON.stringify({ files: [{ filePath: "src/Test.cs" }] }));
assert.deepEqual(objectTargets.targetPaths, ["src/Test.cs"]);

const topLevelEdits = parsePatchResponse(
  JSON.stringify({ edits: [{ path: "src/Test.cs", before: "old", after: "new" }] }),
);
assert.equal(topLevelEdits.issues.length, 0);
assert.equal(topLevelEdits.changes[0].replacementText, "new");

const lineRange = parsePatchResponse(
  JSON.stringify({
    changes: [
      {
        path: "src/Test.cpp",
        startLine: 2,
        endLine: 3,
        startAnchor: "\tint value = 1;",
        endAnchor: "\treturn value;",
        replacementText: "\tint value = 2;\n\treturn value;",
      },
    ],
  }),
);
assert.equal(lineRange.issues.length, 0);
assert.equal(lineRange.changes[0].startLine, 2);
assert.equal(lineRange.changes[0].endLine, 3);

const stringLineNumbers = parsePatchResponse(
  JSON.stringify({
    changes: [{ path: "src/Test.cpp", startLine: "2", endLine: "2", startAnchor: "code", endAnchor: "code", replacementText: "new" }],
  }),
);
assert.equal(stringLineNumbers.issues.length, 0);
assert.equal(stringLineNumbers.changes[0].startLine, 2);

const invalidRange = parsePatchResponse(
  JSON.stringify({ changes: [{ path: "src/Test.cpp", startLine: 3, endLine: 2, replacementText: "x" }] }),
);
assert.equal(invalidRange.changes.length, 0);
assert.match(invalidRange.issues[0], /줄 범위/);

const cpp = "void run() {\r\n\tint value = 1;  \r\n\treturn value;\r\n}\r\n";
const changed = applyLineRangeChanges(cpp, "\r\n", [
  {
    path: "src/Test.cpp",
    startLine: 2,
    endLine: 3,
    startAnchor: " int value = 1; ",
    endAnchor: "return value;",
    replacementText: "\tint value = 2;\n\treturn value;",
  },
]);
assert.equal(changed, "void run() {\r\n\tint value = 2;\r\n\treturn value;\r\n}\r\n");

const multiple = applyLineRangeChanges("one\ntwo\nthree\nfour\n", "\n", [
  { path: "x", startLine: 4, endLine: 4, startAnchor: "four", endAnchor: "four", replacementText: "FOUR" },
  { path: "x", startLine: 2, endLine: 2, startAnchor: "two", endAnchor: "two", replacementText: "TWO" },
]);
assert.equal(multiple, "one\nTWO\nthree\nFOUR\n");

assert.throws(
  () =>
    applyLineRangeChanges(cpp, "\r\n", [
      { path: "x", startLine: 2, endLine: 2, startAnchor: "different", endAnchor: "different", replacementText: "x" },
    ]),
  /startAnchor/,
);

const normalized = findOriginalTextMatch("a\n\tint value = 1;  \nz\n", "int   value = 1;", "\n");
assert.equal(normalized?.occurrences, 1);
assert.equal(normalized?.method, "whitespace-normalized");
assert.equal(normalized?.text, "\tint value = 1;  ");

console.log("patch protocol tests passed");
