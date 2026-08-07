import assert from "node:assert/strict";
import { parsePatchResponse, parseTargetResponse } from "../dist/patchProtocol.js";

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

console.log("patch protocol tests passed");
