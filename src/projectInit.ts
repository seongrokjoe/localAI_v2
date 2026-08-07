import * as path from "node:path";
import * as vscode from "vscode";
import { readRuntimeConfig } from "./config";
import { truncateToTokens } from "./context";
import { LlmClient } from "./llmClient";
import { ChatMessage, CompletionResult } from "./types";

interface ProjectInfo {
  path: string;
  name: string;
  targetFrameworks: string[];
  outputType?: string;
  projectReferences: string[];
  packageReferences: string[];
  compileFiles: string[];
}

interface SolutionInfo {
  path: string;
  projects: Array<{ name: string; path: string }>;
}

interface ScanResult {
  rootName: string;
  solutionFiles: SolutionInfo[];
  projects: ProjectInfo[];
  importantFiles: string[];
  topLevelFolders: string[];
  generatedAt: string;
}

interface ProjectSummary {
  path: string;
  content: string;
}

export class ProjectInitializer {
  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly output: vscode.OutputChannel,
  ) {}

  async initProjectSummary(refresh: boolean): Promise<void> {
    const folder = getWorkspaceFolder();
    const summaryUri = vscode.Uri.joinPath(folder.uri, "SUMMARY.md");
    const existing = await tryReadText(summaryUri);
    if (existing && !refresh) {
      const overwrite = await vscode.window.showWarningMessage(
        "SUMMARY.md already exists. Refresh it?",
        { modal: true },
        "Refresh",
      );
      if (overwrite !== "Refresh") {
        return;
      }
    }

    const progressOptions = {
      location: vscode.ProgressLocation.Notification,
      title: "Company Code AI: Initializing project summary",
      cancellable: true,
    } satisfies vscode.ProgressOptions;

    await vscode.window.withProgress(progressOptions, async (progress, token) => {
      const config = await readRuntimeConfig(this.secrets);
      const client = new LlmClient(config);
      this.output.appendLine(`Initializing project summary for ${folder.uri.fsPath}`);

      progress.report({ message: "Scanning solution and project files" });
      const scan = await scanWorkspace(folder.uri);
      await writeInitCache("scan.json", JSON.stringify(scan, null, 2));
      if (token.isCancellationRequested) {
        return;
      }

      const projectSummaries: ProjectSummary[] = [];
      const projects = scan.projects.length > 0 ? scan.projects : createFolderFallbackProjects(scan);
      for (let i = 0; i < projects.length; i++) {
        if (token.isCancellationRequested) {
          return;
        }
        const project = projects[i];
        progress.report({ message: `Summarizing ${project.path}`, increment: projects.length ? 50 / projects.length : 0 });
        const context = await buildProjectContext(project);
        const content = await summarizeProject(client, scan, project, context).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.output.appendLine(`Project summary failed for ${project.path}: ${message}`);
          return renderFallbackProjectSummary(project, message);
        });
        projectSummaries.push({ path: project.path, content });
        await writeInitCache(`projects/${safeFileName(project.path)}.md`, content);
      }

      if (token.isCancellationRequested) {
        return;
      }
      progress.report({ message: "Reducing project summaries into SUMMARY.md", increment: 20 });
      const summary = await summarizeSolution(client, scan, projectSummaries).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(`Solution summary failed: ${message}`);
        return renderFallbackSolutionSummary(scan, projectSummaries, message);
      });
      const finalSummary = normalizeSummary(summary, scan);
      await writeInitCache("SUMMARY.preview.md", finalSummary);

      const doc = await vscode.workspace.openTextDocument({ content: finalSummary, language: "markdown" });
      await vscode.window.showTextDocument(doc, { preview: true });

      const apply = await vscode.window.showInformationMessage(
        "Write this generated project summary to SUMMARY.md?",
        { modal: true },
        "Write SUMMARY.md",
      );
      if (apply !== "Write SUMMARY.md") {
        return;
      }

      await vscode.workspace.fs.writeFile(summaryUri, Buffer.from(finalSummary, "utf8"));
      const savedDoc = await vscode.workspace.openTextDocument(summaryUri);
      await vscode.window.showTextDocument(savedDoc, { preview: false });
      this.output.appendLine("SUMMARY.md generated.");
      vscode.window.showInformationMessage("SUMMARY.md generated.");
    });
  }

  async openProjectSummary(): Promise<void> {
    const folder = getWorkspaceFolder();
    const uri = vscode.Uri.joinPath(folder.uri, "SUMMARY.md");
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch {
      vscode.window.showWarningMessage("SUMMARY.md does not exist. Run Company Code AI: Init Project Summary first.");
    }
  }

  async clearInitCache(): Promise<void> {
    const folder = getWorkspaceFolder();
    const uri = vscode.Uri.joinPath(folder.uri, ".company-code-ai", "init");
    const confirm = await vscode.window.showWarningMessage("Clear Company Code AI init cache?", { modal: true }, "Clear");
    if (confirm !== "Clear") {
      return;
    }
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false }).then(
      () => vscode.window.showInformationMessage("Company Code AI init cache cleared."),
      () => vscode.window.showInformationMessage("Company Code AI init cache was already empty."),
    );
  }
}

export async function readSummaryForContext(maxTokens: number): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return "";
  }
  const uri = vscode.Uri.joinPath(folder.uri, "SUMMARY.md");
  const text = await tryReadText(uri);
  return text ? truncateToTokens(text, maxTokens) : "";
}

async function scanWorkspace(root: vscode.Uri): Promise<ScanResult> {
  const solutionUris = await vscode.workspace.findFiles("**/*.sln", "**/{.git,node_modules,bin,obj,dist,build,.company-code-ai}/**", 20);
  const projectUris = await vscode.workspace.findFiles("**/*.{csproj,vbproj,fsproj,vcxproj,sqlproj,esproj}", "**/{.git,node_modules,bin,obj,dist,build,.company-code-ai}/**", 400);
  const importantUris = await vscode.workspace.findFiles(
    "{README*,*.props,*.targets,Directory.Build.*,global.json,appsettings*.json,*.config}",
    "**/{.git,node_modules,bin,obj,dist,build,.company-code-ai}/**",
    100,
  );

  const solutionFiles: SolutionInfo[] = [];
  for (const uri of solutionUris) {
    const text = await readText(uri);
    solutionFiles.push(parseSolution(vscode.workspace.asRelativePath(uri, false), text));
  }

  const projects: ProjectInfo[] = [];
  for (const uri of projectUris) {
    const text = await readText(uri);
    projects.push(parseProject(vscode.workspace.asRelativePath(uri, false), text));
  }

  let entries: [string, vscode.FileType][] = [];
  try {
    entries = await vscode.workspace.fs.readDirectory(root);
  } catch {
    entries = [];
  }
  const topLevelFolders = entries
    .filter(([, type]) => type === vscode.FileType.Directory)
    .map(([name]) => name)
    .filter((name) => !name.startsWith(".") && !["bin", "obj", "node_modules", "dist", "build"].includes(name))
    .sort();

  return {
    rootName: path.basename(root.fsPath),
    solutionFiles,
    projects: projects.sort((a, b) => a.path.localeCompare(b.path)),
    importantFiles: importantUris.map((uri) => vscode.workspace.asRelativePath(uri, false)).sort(),
    topLevelFolders,
    generatedAt: new Date().toISOString(),
  };
}

function parseSolution(relativePath: string, text: string): SolutionInfo {
  const projects = Array.from(text.matchAll(/Project\("[^"]+"\)\s*=\s*"([^"]+)",\s*"([^"]+)"/g)).map((match) => ({
    name: match[1],
    path: match[2].replace(/\\/g, "/"),
  }));
  return { path: relativePath, projects };
}

function parseProject(relativePath: string, text: string): ProjectInfo {
  return {
    path: relativePath,
    name: path.basename(relativePath, path.extname(relativePath)),
    targetFrameworks: unique([
      ...tagValues(text, "TargetFramework"),
      ...tagValues(text, "TargetFrameworks").flatMap((value) => value.split(";")),
      ...tagValues(text, "TargetFrameworkVersion"),
      ...tagValues(text, "PlatformToolset"),
    ]),
    outputType: tagValues(text, "OutputType")[0],
    projectReferences: includeValues(text, "ProjectReference").map(normalizeRel),
    packageReferences: includeValues(text, "PackageReference"),
    compileFiles: unique([
      ...includeValues(text, "Compile"),
      ...includeValues(text, "ClCompile"),
      ...includeValues(text, "Page"),
      ...includeValues(text, "ApplicationDefinition"),
    ]).map(normalizeRel),
  };
}

async function buildProjectContext(project: ProjectInfo): Promise<string> {
  const projectDir = project.path.includes("/") ? project.path.slice(0, project.path.lastIndexOf("/")) : "";
  const glob = projectDir ? `${projectDir}/**/*.{cs,vb,fs,cpp,c,h,hpp,xaml,json,config,md,xml,props,targets}` : "**/*.{cs,vb,fs,cpp,c,h,hpp,xaml,json,config,md,xml,props,targets}";
  const files = await vscode.workspace.findFiles(glob, "**/{.git,node_modules,bin,obj,dist,build,.company-code-ai}/**", 80);
  const snippets: string[] = [];
  for (const file of files.slice(0, 30)) {
    const relative = vscode.workspace.asRelativePath(file, false);
    const text = await tryReadText(file);
    if (!text || text.includes("\0")) {
      continue;
    }
    snippets.push(`--- ${relative} ---\n${truncateForInit(text, 12000)}`);
  }
  return [
    `Project: ${project.path}`,
    `Target frameworks: ${project.targetFrameworks.join(", ") || "unknown"}`,
    `Output type: ${project.outputType ?? "unknown"}`,
    `Project references:\n${project.projectReferences.join("\n") || "(none)"}`,
    `Package references:\n${project.packageReferences.join("\n") || "(none)"}`,
    `Candidate files:\n${files.map((file) => vscode.workspace.asRelativePath(file, false)).join("\n")}`,
    snippets.join("\n\n"),
  ].join("\n\n");
}

async function summarizeProject(client: LlmClient, scan: ScanResult, project: ProjectInfo, context: string): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You summarize one project inside a large internal solution.",
        "Use only supplied deterministic scan and snippets.",
        "Do not invent build commands or entry points. Put uncertainty under Unknown.",
        "Return concise markdown with headings: Purpose, Key Files, Dependencies, Entry Points, Risks, Unknown.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `<scan>${truncateForInit(JSON.stringify({ solutions: scan.solutionFiles, importantFiles: scan.importantFiles }, null, 2), 30000)}</scan>`,
        `<project>${truncateForInit(JSON.stringify(project, null, 2), 20000)}</project>`,
        `<projectContext>${truncateForInit(context, 140000)}</projectContext>`,
      ].join("\n\n"),
    },
  ];
  return (await completePlain(client, messages)).content;
}

async function summarizeSolution(client: LlmClient, scan: ScanResult, projectSummaries: ProjectSummary[]): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "Create a repository-level SUMMARY.md for an internal coding agent.",
        "Base claims on deterministic scan and project summaries.",
        "Every important claim should mention source paths when possible.",
        "If something is inferred or missing, put it under Unknown / Needs Confirmation.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `<deterministicScan>${truncateForInit(JSON.stringify(scan, null, 2), 70000)}</deterministicScan>`,
        `<projectSummaries>${truncateForInit(projectSummaries.map((item) => `## ${item.path}\n${item.content}`).join("\n\n"), 120000)}</projectSummaries>`,
        "Generate SUMMARY.md with sections: Solution Overview, Projects, Dependency Graph, Entry Points, Build and Test, Important Directories, Current AI Working Notes, Unknown / Needs Confirmation.",
      ].join("\n\n"),
    },
  ];
  return (await completePlain(client, messages)).content;
}

async function completePlain(client: LlmClient, messages: ChatMessage[]): Promise<CompletionResult> {
  let content = "";
  return await client.complete({
    messages,
    onDelta: (delta) => {
      content += delta;
    },
  }).then((result) => ({ ...result, content: result.content || content }));
}

function normalizeSummary(summary: string, scan: ScanResult): string {
  const body = stripMarkdownFence(summary.trim());
  if (body.startsWith("# Project Summary")) {
    return `${body}\n\n---\nGenerated by Company Code AI at ${scan.generatedAt}.\n`;
  }
  return `# Project Summary\n\n${body}\n\n---\nGenerated by Company Code AI at ${scan.generatedAt}.\n`;
}

function createFolderFallbackProjects(scan: ScanResult): ProjectInfo[] {
  return scan.topLevelFolders.map((folder) => ({
    path: folder,
    name: folder,
    targetFrameworks: [],
    projectReferences: [],
    packageReferences: [],
    compileFiles: [],
  }));
}

function renderFallbackProjectSummary(project: ProjectInfo, error: string): string {
  return [
    `# ${project.path}`,
    "",
    "## Purpose",
    "Unknown. The model request for this project failed.",
    "",
    "## Key Files",
    project.compileFiles.length ? project.compileFiles.map((file) => `- ${file}`).join("\n") : "- Unknown",
    "",
    "## Dependencies",
    project.projectReferences.length ? project.projectReferences.map((file) => `- ${file}`).join("\n") : "- No project references detected.",
    "",
    "## Entry Points",
    project.outputType ? `- OutputType: ${project.outputType}` : "- Unknown",
    "",
    "## Risks",
    "- This is a deterministic fallback summary.",
    "",
    "## Unknown",
    `- Project summary generation failed: ${error}`,
  ].join("\n");
}

function renderFallbackSolutionSummary(scan: ScanResult, projectSummaries: ProjectSummary[], error: string): string {
  const solutionList = scan.solutionFiles.length
    ? scan.solutionFiles.map((solution) => `- ${solution.path} (${solution.projects.length} projects)`).join("\n")
    : "- No .sln file detected.";
  const projectList = scan.projects.length
    ? scan.projects.map((project) => `- ${project.path}`).join("\n")
    : "- No project files detected.";
  return [
    "## Solution Overview",
    `${scan.rootName} contains ${scan.solutionFiles.length} solution file(s) and ${scan.projects.length} project file(s).`,
    "",
    "## Projects",
    projectList,
    "",
    "## Dependency Graph",
    solutionList,
    "",
    "## Entry Points",
    "- Unknown. Review project files and startup configuration.",
    "",
    "## Build and Test",
    "- Unknown. Build and test commands were not inferred automatically.",
    "",
    "## Important Directories",
    scan.topLevelFolders.length ? scan.topLevelFolders.map((folder) => `- ${folder}`).join("\n") : "- Unknown",
    "",
    "## Current AI Working Notes",
    projectSummaries.length ? projectSummaries.map((item) => `- Cached summary: ${item.path}`).join("\n") : "- No project summaries were generated.",
    "",
    "## Unknown / Needs Confirmation",
    `- Solution summary generation failed: ${error}`,
  ].join("\n");
}

async function writeInitCache(relativePath: string, content: string): Promise<void> {
  const folder = getWorkspaceFolder();
  const target = vscode.Uri.joinPath(folder.uri, ".company-code-ai", "init", ...relativePath.split("/").filter(Boolean));
  await ensureParent(target);
  await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
}

async function ensureParent(uri: vscode.Uri): Promise<void> {
  const parent = vscode.Uri.file(path.dirname(uri.fsPath));
  await vscode.workspace.fs.createDirectory(parent);
}

function getWorkspaceFolder(): vscode.WorkspaceFolder {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("Open a workspace folder before initializing a project summary.");
  }
  return folder;
}

async function readText(uri: vscode.Uri): Promise<string> {
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
}

async function tryReadText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return await readText(uri);
  } catch {
    return undefined;
  }
}

function tagValues(text: string, tag: string): string[] {
  return Array.from(text.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))).map((match) => cleanXml(match[1]));
}

function includeValues(text: string, tag: string): string[] {
  return Array.from(text.matchAll(new RegExp(`<${tag}[^>]*Include=["']([^"']+)["'][^>]*>`, "gi"))).map((match) => match[1]);
}

function cleanXml(value: string): string {
  return value.replace(/<[^>]+>/g, "").trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function normalizeRel(value: string): string {
  return value.replace(/\\/g, "/");
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function truncateForInit(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[truncated]`;
}

function stripMarkdownFence(text: string): string {
  const match = text.match(/^```(?:markdown|md)?\s*([\s\S]*?)```$/i);
  return match ? match[1].trim() : text;
}
