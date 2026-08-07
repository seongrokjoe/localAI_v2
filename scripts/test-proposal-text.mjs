import assert from "node:assert/strict";
import {
  buildProposalDraft,
  extractReplacementContent,
  hashProposalText,
  parseProposalConflicts,
  resolveProposalConflict,
  unresolvedProposalConflictCount,
} from "../dist/proposalText.js";

const base = "void run() {\r\n\told();\r\n}\r\n";
const original = "\told();\r\n";
const startOffset = base.indexOf(original);
const id = "11111111-1111-4111-8111-111111111111";
const draft = buildProposalDraft(
  base,
  [{ id, startOffset, endOffset: startOffset + original.length, originalText: original, replacementText: "\tnew();" }],
  "\r\n",
);

assert.match(draft, /<<<<<<< ORIGINAL/);
assert.equal(unresolvedProposalConflictCount(draft), 1);
const conflict = parseProposalConflicts(draft)[0];
assert.equal(conflict.id, id);
assert.equal(conflict.originalText, original);
assert.equal(conflict.replacementText, "\tnew();\r\n");

const useOriginal = resolveProposalConflict(draft, id, "original", "\r\n");
assert.equal(useOriginal, base);
assert.equal(unresolvedProposalConflictCount(useOriginal), 0);

const useProposal = resolveProposalConflict(draft, id, "proposal", "\r\n");
assert.equal(useProposal, "void run() {\r\n\tnew();\r\n}\r\n");

const useBoth = resolveProposalConflict(draft, id, "both", "\r\n");
assert.equal(useBoth, "void run() {\r\n\told();\r\n\tnew();\r\n}\r\n");

const dangling = draft.replace(`>>>>>>> AI (Company Code AI: ${id})`, "");
assert.equal(unresolvedProposalConflictCount(dangling), 1);

assert.throws(
  () =>
    buildProposalDraft(
      "abcdef",
      [
        { id, startOffset: 1, endOffset: 4, originalText: "bcd", replacementText: "x" },
        { id: "22222222-2222-4222-8222-222222222222", startOffset: 3, endOffset: 5, originalText: "de", replacementText: "y" },
      ],
      "\n",
    ),
  /겹칩니다/,
);

assert.deepEqual(extractReplacementContent("```cpp\nint value = 1;\n```"), { text: "int value = 1;", source: "fence" });
assert.deepEqual(extractReplacementContent("설명\n코드"), { text: "설명\n코드", source: "raw" });
assert.equal(hashProposalText("same"), hashProposalText("same"));
assert.notEqual(hashProposalText("same"), hashProposalText("different"));

const noFinalEolBase = "first\nlast";
const noFinalEolId = "33333333-3333-4333-8333-333333333333";
const noFinalEolDraft = buildProposalDraft(
  noFinalEolBase,
  [{ id: noFinalEolId, startOffset: 6, endOffset: 10, originalText: "last", replacementText: "LAST" }],
  "\n",
);
assert.equal(resolveProposalConflict(noFinalEolDraft, noFinalEolId, "original", "\n"), noFinalEolBase);
assert.equal(resolveProposalConflict(noFinalEolDraft, noFinalEolId, "proposal", "\n"), "first\nLAST");

console.log("proposal text tests passed");
