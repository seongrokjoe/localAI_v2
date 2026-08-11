import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  extractDirectReferenceSpecifiers,
  resolveImplementationReference,
} from "../dist/implementationReferences.js";

assert.deepEqual(
  extractDirectReferenceSpecifiers("src/main.cpp", '#include "main.h"\n#include <vector>\n'),
  ["main.h"],
);
assert.deepEqual(
  extractDirectReferenceSpecifiers(
    "src/main.ts",
    'import helper from "./helper";\nexport { value } from "../shared/value";\nimport lodash from "lodash";\n',
  ),
  ["./helper", "../shared/value"],
);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "company-code-ai-references-"));
try {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "shared"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "main.ts"), "", "utf8");
  await fs.writeFile(path.join(root, "src", "helper.ts"), "", "utf8");
  await fs.writeFile(path.join(root, "shared", "value.ts"), "", "utf8");
  assert.equal(await resolveImplementationReference(root, "src/main.ts", "./helper"), "src/helper.ts");
  assert.equal(await resolveImplementationReference(root, "src/main.ts", "../shared/value"), "shared/value.ts");
  assert.equal(await resolveImplementationReference(root, "src/main.ts", "../../outside"), undefined);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("Implementation reference tests passed.");
