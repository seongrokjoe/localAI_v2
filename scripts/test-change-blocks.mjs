import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { extractChangeBlocks, parseChangeBlockArguments } = require("../dist/changeBlockParser.js");

const toolBlocks = parseChangeBlockArguments(JSON.stringify({
  changes: [{
    path: "src/sample.cpp",
    description: "메서드 수정",
    originalText: "int value = 1;",
    proposedText: "int value = 2;",
  }],
}));
assert.equal(toolBlocks.length, 1);
assert.equal(toolBlocks[0].pathHint, "src/sample.cpp");
assert.equal(toolBlocks[0].source, "tool");

const jsonBlocks = extractChangeBlocks([
  "```company-code-ai",
  JSON.stringify({ changes: [{ filePath: "src/a.cs", before: "return 1;", after: "return 2;" }] }),
  "```",
].join("\n"));
assert.equal(jsonBlocks.length, 1);
assert.equal(jsonBlocks[0].originalText, "return 1;");
assert.equal(jsonBlocks[0].proposedText, "return 2;");

const pairedBlocks = extractChangeBlocks([
  "### src/driver.cpp",
  "원본:",
  "```original",
  "void run() {}",
  "```",
  "수정:",
  "```replacement",
  "void run() { start(); }",
  "```",
].join("\n"));
assert.equal(pairedBlocks.length, 1);
assert.equal(pairedBlocks[0].pathHint, "src/driver.cpp");
assert.equal(pairedBlocks[0].originalText, "void run() {}");

const fallbackBlocks = extractChangeBlocks("파일: src/view.ts\n```ts\nexport const value = 2;\n```");
assert.equal(fallbackBlocks.length, 1);
assert.equal(fallbackBlocks[0].pathHint, "src/view.ts");
assert.equal(fallbackBlocks[0].source, "markdown");

console.log("Change block parser tests passed.");
