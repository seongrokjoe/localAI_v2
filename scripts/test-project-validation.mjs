import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { discoverProjectGraph } = require("../dist/projectGraph.js");
const { materializeChanges, isSafeValidationCommand, taskTargetsProject, validateLineMappedChanges } = require("../dist/projectValidation.js");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "company-code-ai-project-test-"));
try {
  await write(root, "lib/src/core.cpp", "int core() { return 1; }\n");
  await write(root, "lib/include/core.h", "int core();\n");
  await write(root, "lib/lib.vcxproj", `<Project><ItemGroup><ClCompile Include="src\\core.cpp" /><ClInclude Include="include\\core.h" /></ItemGroup></Project>`);
  await write(root, "app/src/main.cpp", "int main() { return core(); }\n");
  await write(root, "app/app.vcxproj", `<Project><ItemGroup><ClCompile Include="src\\main.cpp" /><ProjectReference Include="..\\lib\\lib.vcxproj" /></ItemGroup></Project>`);

  const graph = await discoverProjectGraph(root, ["lib/src/core.cpp"]);
  assert.deepEqual(graph.changedProjects.map((project) => project.path), ["lib/lib.vcxproj"]);
  assert.deepEqual(graph.dependentProjects.map((project) => project.path), ["app/app.vcxproj"]);
  assert.deepEqual(graph.unresolvedPaths, []);

  const unresolved = await discoverProjectGraph(root, ["unknown/new.cpp"]);
  assert.deepEqual(unresolved.unresolvedPaths, ["unknown/new.cpp"]);
  const inferred = await discoverProjectGraph(root, ["lib/src/new.cpp"]);
  assert.deepEqual(inferred.changedProjects.map((project) => project.path), ["lib/lib.vcxproj"]);

  await write(root, "shared/common.cpp", "int shared() { return 1; }\n");
  await write(root, "shared/one.vcxproj", `<Project><ItemGroup><ClCompile Include="common.cpp" /></ItemGroup></Project>`);
  await write(root, "shared/two.vcxproj", `<Project><ItemGroup><ClCompile Include="common.cpp" /></ItemGroup></Project>`);
  const shared = await discoverProjectGraph(root, ["shared/common.cpp"]);
  assert.deepEqual(shared.ambiguousPaths, ["shared/common.cpp"]);
  assert.deepEqual(shared.ambiguousCandidates["shared/common.cpp"], ["shared/one.vcxproj", "shared/two.vcxproj"]);
  const selectedShared = await discoverProjectGraph(root, ["shared/common.cpp"], { "shared/common.cpp": "shared/two.vcxproj" });
  assert.deepEqual(selectedShared.changedProjects.map((project) => project.path), ["shared/two.vcxproj"]);

  const source = "void run() {\n    old();\n}\n";
  const snapshot = { id: "F001", path: "lib/src/core.cpp", snapshot: hash(source), languageId: "cpp", text: source, lineCount: 4 };
  const files = materializeChanges([{
    id: "C001",
    protocolId: "P001",
    fileId: "F001",
    snapshot: snapshot.snapshot,
    operation: "replace",
    startLine: 2,
    endLine: 2,
    code: "newCore();",
  }], [snapshot]);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "lib/src/core.cpp");
  assert.match(files[0].text, /    newCore\(\);/);
  assert.equal(isSafeValidationCommand("msbuild", ["app.vcxproj", "/t:Build"]), true);
  assert.equal(isSafeValidationCommand("git", ["push", "origin", "main"]), false);
  assert.equal(isSafeValidationCommand("git.exe", ["-C", "repo", "push"]), false);
  assert.equal(isSafeValidationCommand("npm", ["install"]), false);
  assert.equal(isSafeValidationCommand("powershell.exe", ["-Command", "git push"]), false);
  assert.equal(taskTargetsProject("Build solution", "msbuild", ["unrelated/app.vcxproj"], "lib/lib.vcxproj"), false);
  assert.equal(taskTargetsProject("Build lib.vcxproj", process.execPath, ["-e", "process.exit(0)"], "lib/lib.vcxproj"), true);
  assert.equal(taskTargetsProject("Build selected", "msbuild", ["${workspaceFolder}\\lib\\lib.vcxproj"], "lib/lib.vcxproj"), true);

  await write(root, ".vscode/tasks.json", JSON.stringify({ version: "2.0.0", tasks: [
    { label: "Build lib.vcxproj", type: "process", command: process.execPath, args: ["-e", "if (require('fs').existsSync('.git') || !require('fs').readFileSync('lib/src/core.cpp','utf8').includes('newCore')) process.exit(2)"], group: "build" },
    { label: "Test lib.vcxproj", type: "process", command: process.execPath, args: ["-e", "process.exit(0)"], group: "test" },
    { label: "Build app.vcxproj", type: "process", command: process.execPath, args: ["-e", "process.exit(9)"], group: "build" },
  ] }));
  const validation = await validateLineMappedChanges([{
    id: "C001",
    protocolId: "P001",
    fileId: "F001",
    snapshot: snapshot.snapshot,
    operation: "replace",
    startLine: 2,
    endLine: 2,
    code: "newCore();",
  }], [snapshot], { root });
  assert.equal(validation.status, "passed");
  assert.deepEqual(validation.projects.map((project) => project.path), ["lib/lib.vcxproj"]);
  assert.equal(validation.commands.some((command) => command.includes("app.vcxproj")), false);
  assert.equal((await fs.readFile(path.join(root, "lib/src/core.cpp"), "utf8")).includes("newCore"), false);

  await write(root, ".vscode/tasks.json", JSON.stringify({ version: "2.0.0", tasks: [
    { label: "Build lib.vcxproj", type: "process", command: process.execPath, args: ["-e", "process.stderr.write('core.cpp(2,4): error C0001: broken') ; process.exit(1)"], group: "build" },
  ] }));
  const failed = await validateLineMappedChanges([{
    id: "C001",
    protocolId: "P001",
    fileId: "F001",
    snapshot: snapshot.snapshot,
    operation: "replace",
    startLine: 2,
    endLine: 2,
    code: "newCore();",
  }], [snapshot], { root });
  assert.equal(failed.status, "failed");
  assert.match(failed.output, /core\.cpp/);

  console.log("Project graph and validation materialization tests passed.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

async function write(root, relative, content) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

function hash(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}
