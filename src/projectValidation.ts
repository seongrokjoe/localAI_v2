import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { LineMappedChange, SourceSnapshot } from "./types";
import { lineOperationOffsets, replacementForLineChange } from "./lineChangeMapping";
import { discoverProjectGraph, ProjectDescriptor } from "./projectGraph";
import { discoverVisualStudioMsBuild, isMsb4278 } from "./msbuildDiscovery";

export interface ValidationDiagnostic {
  project: string;
  file?: string;
  line?: number;
  column?: number;
  severity: "error" | "warning" | "test-failure" | "tool-error";
  message: string;
}

export interface ValidationRunResult {
  status: "passed" | "failed" | "skipped" | "unavailable";
  failureKind?: "candidate" | "environment";
  summary: string;
  output: string;
  diagnostics: ValidationDiagnostic[];
  projects: ProjectDescriptor[];
  commands: string[];
  changedFiles: string[];
  projectCandidates?: Record<string, string[]>;
}

export interface ValidationRunOptions {
  root: string;
  onStatus?: (text: string) => void | Promise<void>;
  signal?: AbortSignal;
  projectOverrides?: Record<string, string>;
}

interface MaterializedFile {
  path: string;
  text: string;
}

interface CommandSpec {
  executable: string;
  args: string[];
  cwd: string;
  label: string;
  project: ProjectDescriptor;
  kind: "build" | "test";
}

interface CommandResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

interface ResolvedCommands {
  commands: CommandSpec[];
  unavailableReason?: string;
}

const commandTimeoutMs = 180000;
const excludedCopyDirectories = new Set([".git", ".company-code-ai", "bin", "build", "dist", "out"]);

export async function validateLineMappedChanges(
  changes: LineMappedChange[],
  snapshots: SourceSnapshot[],
  options: ValidationRunOptions,
): Promise<ValidationRunResult> {
  let materialized: MaterializedFile[];
  try {
    materialized = materializeChanges(changes, snapshots);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      summary: `Change materialization failed: ${message}`,
      output: "",
      diagnostics: [{ project: "(changes)", severity: "tool-error", message }],
      projects: [],
      commands: [],
      changedFiles: snapshots.map((snapshot) => snapshot.path),
    };
  }
  const graph = await discoverProjectGraph(options.root, materialized.map((file) => file.path), options.projectOverrides);
  const projects = graph.changedProjects;
  if (materialized.length === 0) {
    await options.onStatus?.("[검증] 빌드/테스트 미수행: 적용할 변경 파일이 없습니다.");
    return { status: "skipped", summary: "No materialized changes were found.", output: "", diagnostics: [], projects, commands: [], changedFiles: [] };
  }
  if (graph.ambiguousPaths.length > 0) {
    await options.onStatus?.("[검증] 빌드/테스트 대기: 변경 파일의 소속 프로젝트를 선택해야 합니다.");
    return {
      status: "skipped",
      summary: `Multiple containing projects were found for: ${graph.ambiguousPaths.join(", ")}`,
      output: "",
      diagnostics: graph.ambiguousPaths.map((file) => ({ project: "(ambiguous)", file, severity: "tool-error", message: "Select the containing project before validation." })),
      projects,
      commands: [],
      changedFiles: materialized.map((file) => file.path),
      projectCandidates: graph.ambiguousCandidates,
    };
  }
  if (graph.unresolvedPaths.length > 0) {
    await options.onStatus?.("[검증] 빌드/테스트 미수행: 변경 파일의 소속 프로젝트를 찾지 못했습니다.");
    return {
      status: "skipped",
      summary: `No containing project was found for: ${graph.unresolvedPaths.join(", ")}`,
      output: "",
      diagnostics: graph.unresolvedPaths.map((file) => ({ project: "(unresolved)", file, severity: "tool-error", message: "The changed file is not associated with a project." })),
      projects,
      commands: [],
      changedFiles: materialized.map((file) => file.path),
    };
  }
  if (projects.length === 0) {
    await options.onStatus?.("[검증] 빌드/테스트 미수행: 검증할 프로젝트가 없습니다.");
    return {
      status: "skipped",
      summary: `No project was found for changed files: ${materialized.map((file) => file.path).join(", ")}`,
      output: "",
      diagnostics: materialized.map((file) => ({ project: "(unresolved)", file: file.path, severity: "tool-error", message: "No containing project was found." })),
      projects: graph.projects,
      commands: [],
      changedFiles: materialized.map((file) => file.path),
    };
  }

  const validationRoot = await createValidationWorkspace(options.root);
  const output: string[] = [];
  try {
    await options.onStatus?.(`[검증] 임시 작업공간에 변경안 적용 중: ${materialized.length}개 파일`);
    await applyMaterializedFiles(validationRoot, materialized);
    const resolved = await resolveCommands(validationRoot, projects);
    const commands = resolved.commands;
    if (resolved.unavailableReason) {
      await options.onStatus?.(`[검증] 빌드/테스트 미검증: ${resolved.unavailableReason}`);
      return {
        status: "unavailable",
        failureKind: "environment",
        summary: resolved.unavailableReason,
        output: "",
        diagnostics: [{ project: projects.map((project) => project.path).join(", "), severity: "tool-error", message: resolved.unavailableReason }],
        projects,
        commands: [],
        changedFiles: materialized.map((file) => file.path),
      };
    }
    if (commands.length === 0) {
      await options.onStatus?.("[검증] 빌드/테스트 미수행: 지원되는 검증 명령을 찾지 못했습니다.");
      return { status: "skipped", summary: "No supported build/test command was found for affected projects.", output: "", diagnostics: [], projects, commands: [], changedFiles: materialized.map((file) => file.path) };
    }

    const diagnostics: ValidationDiagnostic[] = [];
    for (const command of commands) {
      if (options.signal?.aborted) throw new Error("Validation cancelled.");
      const operation = command.kind === "build" ? "빌드" : "테스트";
      await options.onStatus?.(`[검증] ${operation} 수행 중: ${command.project.path}`);
      const result = await runCommand(command, options.signal);
      output.push(`$ ${command.label}\n${result.output}`.trim());
      diagnostics.push(...parseDiagnostics(command.project.path, result.output, result.exitCode));
      if (result.exitCode !== 0) {
        if (isMsb4278(result.output) || result.exitCode === -1) {
          const message = isMsb4278(result.output)
            ? "MSB4278: C++ 프로젝트를 빌드할 Visual Studio MSBuild.exe 또는 C++ Build Tools 구성요소를 사용할 수 없습니다. dotnet build로는 .vcxproj를 검증할 수 없습니다."
            : `빌드 실행 파일을 시작할 수 없습니다: ${command.executable}`;
          await options.onStatus?.(`[검증] 빌드 환경 오류: ${message}`);
          return {
            status: "unavailable",
            failureKind: "environment",
            summary: message,
            output: output.join("\n\n").slice(-80000),
            diagnostics: [...diagnostics, { project: command.project.path, severity: "tool-error", message }],
            projects,
            commands: commands.map((item) => item.label),
            changedFiles: materialized.map((file) => file.path),
          };
        }
        await options.onStatus?.(`[검증] ${operation} 실패: ${command.project.path} (exit ${result.exitCode})`);
        return {
          status: "failed",
          failureKind: "candidate",
          summary: `${command.label} failed with exit code ${result.exitCode}${result.timedOut ? " (timeout)" : ""}.`,
          output: output.join("\n\n").slice(-80000),
          diagnostics,
          projects,
          commands: commands.map((item) => item.label),
          changedFiles: materialized.map((file) => file.path),
        };
      }
      await options.onStatus?.(`[검증] ${operation} 완료: ${command.project.path}`);
    }
    const hasTests = commands.some((command) => command.kind === "test");
    await options.onStatus?.(`[검증] 빌드/테스트 검증 완료: ${projects.map((project) => project.path).join(", ")}`);
    return {
      status: "passed",
      summary: hasTests
        ? `Changed project build/test passed: ${graph.changedProjects.length} project(s).`
        : `Changed project build passed; no test command was available: ${graph.changedProjects.length} project(s).`,
      output: output.join("\n\n").slice(-80000),
      diagnostics,
      projects,
      commands: commands.map((item) => item.label),
      changedFiles: materialized.map((file) => file.path),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await options.onStatus?.(`[검증] 빌드/테스트 실패: ${message}`);
    return {
      status: options.signal?.aborted ? "failed" : "failed",
      summary: `Validation could not be completed: ${message}`,
      output: output.join("\n\n").slice(-80000),
      diagnostics: [{ project: "(validation)", severity: "tool-error", message }],
      projects,
      commands: [],
      changedFiles: materialized.map((file) => file.path),
    };
  } finally {
    await fs.rm(validationRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function materializeChanges(changes: LineMappedChange[], snapshots: SourceSnapshot[]): MaterializedFile[] {
  const files = new Map<string, string>();
  for (const snapshot of snapshots) files.set(normalize(snapshot.path), snapshot.text);
  const edits = new Map<string, Array<{ start: number; end: number; replacement: string }>>();

  for (const change of changes) {
    if (change.operation === "create_file") {
      if (!change.path) throw new Error(`create_file change ${change.id} has no path.`);
      files.set(normalize(change.path), change.code);
      continue;
    }
    const snapshot = snapshots.find((candidate) => candidate.id === change.fileId);
    if (!snapshot || snapshot.snapshot !== change.snapshot) throw new Error(`Change ${change.id} does not match its source snapshot.`);
    const sourcePath = normalize(snapshot.path);
    const offsets = lineOperationOffsets(snapshot.text, change.operation, change.startLine, change.endLine);
    if (!offsets) throw new Error(`Change ${change.id} has an invalid line range.`);
    const eol = snapshot.text.match(/\r\n|\r|\n/)?.[0] ?? "\n";
    const original = snapshot.text.slice(offsets.start, offsets.end);
    const replacement = replacementForLineChange(change.operation, change.code, original, offsets.start, snapshot.text, eol);
    const fileEdits = edits.get(sourcePath) ?? [];
    fileEdits.push({ start: offsets.start, end: offsets.end, replacement });
    edits.set(sourcePath, fileEdits);
  }

  for (const [filePath, fileEdits] of edits) {
    let text = files.get(filePath);
    if (text === undefined) throw new Error(`No source text was found for ${filePath}.`);
    const ordered = [...fileEdits].sort((left, right) => right.start - left.start);
    for (let index = 1; index < ordered.length; index++) {
      if (ordered[index].end > ordered[index - 1].start) throw new Error(`Overlapping changes detected in ${filePath}.`);
    }
    for (const edit of ordered) text = `${text.slice(0, edit.start)}${edit.replacement}${text.slice(edit.end)}`;
    files.set(filePath, text);
  }
  return [...files.entries()]
    .filter(([filePath]) => edits.has(filePath) || changes.some((change) => change.operation === "create_file" && normalize(change.path ?? "") === filePath))
    .map(([filePath, text]) => ({ path: filePath, text }));
}

async function createValidationWorkspace(root: string): Promise<string> {
  const parent = path.join(os.tmpdir(), "company-code-ai-validation");
  await fs.mkdir(parent, { recursive: true });
  const destination = await fs.mkdtemp(path.join(parent, "run-"));
  await fs.cp(root, destination, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(root, source);
      if (!relative) return true;
      return !relative.split(path.sep).some((segment) => excludedCopyDirectories.has(segment));
    },
  });
  return destination;
}

async function applyMaterializedFiles(root: string, files: MaterializedFile[]): Promise<void> {
  for (const file of files) {
    const target = path.resolve(root, file.path);
    if (!isInside(root, target)) throw new Error(`Unsafe validation path: ${file.path}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.text, "utf8");
  }
}

async function resolveCommands(root: string, projects: ProjectDescriptor[]): Promise<ResolvedCommands> {
  const commands: CommandSpec[] = [];
  const tasks = await readProcessTasks(root);
  let visualStudioMsBuild: string | undefined;
  for (const project of projects) {
    let buildTask = findTask(tasks, project, "build");
    const testTask = findTask(tasks, project, "test");
    if (project.kind === "vcxproj" && buildTask && !isVcxprojBuildExecutable(buildTask.command)) buildTask = undefined;
    if (project.kind === "vcxproj" && (!buildTask || ["msbuild", "msbuild.exe"].includes(path.basename(buildTask.command).toLowerCase()))) {
      const configured = buildTask ? replaceTaskValue(buildTask.command, root) : undefined;
      if (configured && path.isAbsolute(configured) && path.basename(configured).toLowerCase() === "msbuild.exe") visualStudioMsBuild = configured;
      visualStudioMsBuild ??= await discoverVisualStudioMsBuild();
      if (!visualStudioMsBuild) {
        return { commands: [], unavailableReason: "Visual Studio C++용 MSBuild.exe를 찾지 못했습니다. Visual Studio Installer에서 Desktop development with C++ 또는 C++ Build Tools를 설치해야 합니다." };
      }
    }
    if (buildTask) commands.push(toCommand(buildTask, root, project, "build", visualStudioMsBuild));
    else commands.push(...fallbackCommands(root, project, "build", visualStudioMsBuild));
    if (testTask) commands.push(toCommand(testTask, root, project, "test"));
    else commands.push(...fallbackCommands(root, project, "test", visualStudioMsBuild));
  }
  return { commands: deduplicateCommands(commands) };
}

function fallbackCommands(root: string, project: ProjectDescriptor, kind: "build" | "test", visualStudioMsBuild?: string): CommandSpec[] {
  const projectAbsolute = path.join(root, project.path);
  const projectDirectory = path.join(root, project.directory);
  if (project.kind === "vcxproj" && kind === "build" && visualStudioMsBuild) return [command(visualStudioMsBuild, [projectAbsolute, "/t:Build", "/m", "/p:BuildProjectReferences=false"], projectDirectory, project, kind)];
  if (project.kind === "dotnet") {
    if (kind === "build") return [command("dotnet", ["build", projectAbsolute, "--no-restore", "--no-dependencies"], projectDirectory, project, kind)];
    if (project.testProject) return [command("dotnet", ["test", projectAbsolute, "--no-build", "--no-restore"], projectDirectory, project, kind)];
  }
  if (project.kind === "cmake") {
    if (kind === "build") return [
      command("cmake", ["-S", projectDirectory, "-B", path.join(projectDirectory, "build"), "-DCMAKE_BUILD_TYPE=Debug"], projectDirectory, project, kind),
      command("cmake", ["--build", path.join(projectDirectory, "build"), "--config", "Debug"], projectDirectory, project, kind),
    ];
    return [command("ctest", ["--test-dir", path.join(projectDirectory, "build"), "--output-on-failure"], projectDirectory, project, kind)];
  }
  if (project.kind === "node" && kind === "test") return [command(process.platform === "win32" ? "npm.cmd" : "npm", ["test"], projectDirectory, project, kind)];
  return [];
}

function command(executable: string, args: string[], cwd: string, project: ProjectDescriptor, kind: "build" | "test"): CommandSpec {
  return { executable, args, cwd, project, kind, label: `${executable} ${args.join(" ")}` };
}

function toCommand(task: ProcessTask, root: string, project: ProjectDescriptor, kind: "build" | "test", visualStudioMsBuild?: string): CommandSpec {
  const replace = (value: string): string => replaceTaskValue(value, root);
  const cwd = replace(task.cwd ?? root);
  let executable = replace(task.command);
  if (project.kind === "vcxproj" && ["msbuild", "msbuild.exe"].includes(path.basename(executable).toLowerCase()) && visualStudioMsBuild) executable = visualStudioMsBuild;
  const args = task.args.map(replace);
  const executableName = path.basename(executable).toLowerCase();
  if (kind === "build" && project.kind === "vcxproj" && ["msbuild", "msbuild.exe"].includes(executableName) && !args.some((arg) => /buildprojectreferences\s*=\s*/i.test(arg))) {
    args.push("/p:BuildProjectReferences=false");
  }
  if (kind === "build" && project.kind === "dotnet" && executableName === "dotnet" && !args.includes("--no-dependencies")) {
    args.push("--no-dependencies");
  }
  return command(executable, args, cwd, project, kind);
}

function replaceTaskValue(value: string, root: string): string {
  return value.replace(/\$\{workspaceFolder\}/g, root).replace(/\$\{workspaceFolderBasename\}/g, path.basename(root));
}

export function isVcxprojBuildExecutable(executable: string): boolean {
  return !["dotnet", "dotnet.exe"].includes(path.basename(executable).toLowerCase());
}

interface ProcessTask {
  label: string;
  type: string;
  command: string;
  args: string[];
  cwd?: string;
  group?: string | { kind?: string };
}

async function readProcessTasks(root: string): Promise<ProcessTask[]> {
  const file = path.join(root, ".vscode", "tasks.json");
  try {
    const source = await fs.readFile(file, "utf8");
    const json = JSON.parse(stripJsonComments(source)) as { tasks?: Array<Record<string, unknown>> };
    return (json.tasks ?? []).filter((task) => task.type === "process" && typeof task.command === "string").map((task) => ({
      label: String(task.label ?? task.command),
      type: String(task.type),
      command: String(task.command),
      args: Array.isArray(task.args) ? task.args.map(String) : [],
      cwd: typeof task.options === "object" && task.options && "cwd" in task.options ? String((task.options as { cwd?: unknown }).cwd ?? "") : undefined,
      group: typeof task.group === "string" || typeof task.group === "object" ? task.group as string | { kind?: string } : undefined,
    })).filter((task) => isSafeValidationCommand(task.command, task.args));
  } catch {
    return [];
  }
}

function findTask(tasks: ProcessTask[], project: ProjectDescriptor, kind: "build" | "test"): ProcessTask | undefined {
  const candidates = tasks.filter((task) => {
    const label = task.label.toLowerCase();
    const group = typeof task.group === "string" ? task.group : task.group?.kind;
    return group === kind || label.includes(kind);
  });
  return candidates.find((task) => taskTargetsProject(task.label, task.command, task.args, project.path));
}

export function taskTargetsProject(label: string, commandValue: string, args: string[], projectPathValue: string): boolean {
  const basename = path.basename(projectPathValue).toLowerCase();
  const projectPath = normalize(projectPathValue).toLowerCase();
  void label;
  const values = [commandValue, ...args]
    .map((value) => normalize(value).toLowerCase())
  const targets = values.flatMap((value) => Array.from(value.matchAll(/[^\s"']+\.(?:slnx?|vcxproj|csproj|fsproj|vbproj)/gi), (match) => match[0]));
  if (targets.some((target) => !target.endsWith(projectPath) && path.posix.basename(target) !== basename)) return false;
  return values.some((value) => value.includes(projectPath) || value.includes(basename));
}

export function isSafeValidationCommand(executable: string, args: string[]): boolean {
  const executableName = path.basename(executable).toLowerCase();
  if (["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "bash", "sh", "wsl", "wsl.exe"].includes(executableName)) return false;
  const value = `${executable} ${args.join(" ")}`.toLowerCase();
  return !/(\bgit(?:\.exe)?\b.*\b(push|pull|fetch|clone|remote)\b|\b(gh|scp|curl|wget)\b|invoke-webrequest|npm\s+(install|ci|publish)|(?:dotnet|nuget)\s+(restore|nuget\s+push|push))/i.test(value);
}

function stripJsonComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1").replace(/,\s*([}\]])/g, "$1");
}

function deduplicateCommands(commands: CommandSpec[]): CommandSpec[] {
  const seen = new Set<string>();
  return commands.filter((item) => {
    const key = `${item.kind}|${item.cwd}|${item.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function runCommand(command: CommandSpec, signal?: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Validation cancelled."));
    const child = spawn(command.executable, command.args, { cwd: command.cwd, windowsHide: true, shell: false });
    const chunks: string[] = [];
    let settled = false;
    let timedOut = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = (): void => {
      child.kill();
      finish({ exitCode: -2, output: `${chunks.join("")}\n[validation cancelled]`, timedOut: false });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish({ exitCode: -3, output: `${chunks.join("")}\n[validation timeout]`, timedOut });
    }, commandTimeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (data: Buffer) => chunks.push(data.toString("utf8")));
    child.stderr.on("data", (data: Buffer) => chunks.push(data.toString("utf8")));
    child.on("error", (error) => finish({ exitCode: -1, output: error.message, timedOut }));
    child.on("close", (code) => finish({ exitCode: code ?? -1, output: chunks.join("").slice(-80000), timedOut }));
  });
}

function parseDiagnostics(project: string, output: string, exitCode: number): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = /^(.*)\((\d+),(\d+)\):\s*(error|warning)\b\s*(.*)$/i.exec(trimmed)
      ?? /^(.*?):(\d+)(?::(\d+))?:\s*(error|warning)\b\s*(.*)$/i.exec(trimmed);
    if (match) {
      const severityIndex = match.length === 6 ? 4 : 4;
      diagnostics.push({ project, file: match[1] || undefined, line: match[2] ? Number(match[2]) : undefined, column: match[3] ? Number(match[3]) : undefined, severity: match[severityIndex].toLowerCase() === "error" ? "error" : "warning", message: match[5] });
    }
  }
  if (exitCode !== 0 && diagnostics.length === 0) diagnostics.push({ project, severity: "test-failure", message: output.trim().slice(-4000) || `Command exited with ${exitCode}.` });
  return diagnostics;
}

function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
