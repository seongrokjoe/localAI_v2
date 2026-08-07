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
        "SUMMARY.md가 이미 있습니다. 갱신할까요?",
        { modal: true },
        "갱신",
      );
      if (overwrite !== "갱신") {
        return;
      }
    }

    const progressOptions = {
      location: vscode.ProgressLocation.Notification,
      title: "Company Code AI: 프로젝트 요약 초기화 중",
      cancellable: true,
    } satisfies vscode.ProgressOptions;

    await vscode.window.withProgress(progressOptions, async (progress, token) => {
      const config = await readRuntimeConfig(this.secrets);
      const client = new LlmClient(config);
      this.output.appendLine(`프로젝트 요약 초기화 시작: ${folder.uri.fsPath}`);

      progress.report({ message: "솔루션 및 프로젝트 파일 스캔 중" });
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
        progress.report({ message: `${project.path} 요약 중`, increment: projects.length ? 50 / projects.length : 0 });
        const context = await buildProjectContext(project);
        const content = await summarizeProject(client, scan, project, context).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.output.appendLine(`${project.path} 프로젝트 요약 실패: ${message}`);
          return renderFallbackProjectSummary(project, message);
        });
        projectSummaries.push({ path: project.path, content });
        await writeInitCache(`projects/${safeFileName(project.path)}.md`, content);
      }

      if (token.isCancellationRequested) {
        return;
      }
      progress.report({ message: "프로젝트 요약을 SUMMARY.md로 축약 중", increment: 20 });
      const summary = await summarizeSolution(client, scan, projectSummaries).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(`솔루션 요약 실패: ${message}`);
        return renderFallbackSolutionSummary(scan, projectSummaries, message);
      });
      const finalSummary = normalizeSummary(summary, scan);
      await writeInitCache("SUMMARY.preview.md", finalSummary);

      const doc = await vscode.workspace.openTextDocument({ content: finalSummary, language: "markdown" });
      await vscode.window.showTextDocument(doc, { preview: true });

      const apply = await vscode.window.showInformationMessage(
        "생성된 프로젝트 요약을 SUMMARY.md에 저장할까요?",
        { modal: true },
        "SUMMARY.md 저장",
      );
      if (apply !== "SUMMARY.md 저장") {
        return;
      }

      await vscode.workspace.fs.writeFile(summaryUri, Buffer.from(finalSummary, "utf8"));
      const savedDoc = await vscode.workspace.openTextDocument(summaryUri);
      await vscode.window.showTextDocument(savedDoc, { preview: false });
      this.output.appendLine("SUMMARY.md를 생성했습니다.");
      vscode.window.showInformationMessage("SUMMARY.md를 생성했습니다.");
    });
  }

  async openProjectSummary(): Promise<void> {
    const folder = getWorkspaceFolder();
    const uri = vscode.Uri.joinPath(folder.uri, "SUMMARY.md");
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch {
      vscode.window.showWarningMessage("SUMMARY.md가 없습니다. 먼저 Company Code AI: 프로젝트 요약 초기화를 실행하세요.");
    }
  }

  async clearInitCache(): Promise<void> {
    const folder = getWorkspaceFolder();
    const uri = vscode.Uri.joinPath(folder.uri, ".company-code-ai", "init");
    const confirm = await vscode.window.showWarningMessage("Company Code AI 초기화 캐시를 비울까요?", { modal: true }, "비우기");
    if (confirm !== "비우기") {
      return;
    }
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false }).then(
      () => vscode.window.showInformationMessage("Company Code AI 초기화 캐시를 비웠습니다."),
      () => vscode.window.showInformationMessage("Company Code AI 초기화 캐시는 이미 비어 있습니다."),
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
    `프로젝트: ${project.path}`,
    `대상 프레임워크: ${project.targetFrameworks.join(", ") || "알 수 없음"}`,
    `출력 형식: ${project.outputType ?? "알 수 없음"}`,
    `프로젝트 참조:\n${project.projectReferences.join("\n") || "(없음)"}`,
    `패키지 참조:\n${project.packageReferences.join("\n") || "(없음)"}`,
    `후보 파일:\n${files.map((file) => vscode.workspace.asRelativePath(file, false)).join("\n")}`,
    snippets.join("\n\n"),
  ].join("\n\n");
}

async function summarizeProject(client: LlmClient, scan: ScanResult, project: ProjectInfo, context: string): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "당신은 대형 사내 솔루션 안의 프로젝트 하나를 요약하는 코드베이스 도우미입니다.",
        "제공된 결정적 스캔 결과와 코드 조각만 사용하세요.",
        "빌드 명령이나 진입점을 추측하지 마세요. 불확실한 내용은 '확인 필요'에 적으세요.",
        "간결한 한국어 markdown으로 반환하세요. 섹션 제목은 '목적', '핵심 파일', '의존성', '진입점', '위험 요소', '확인 필요'를 사용하세요.",
        "코드 식별자, 파일 경로, 설정 키, 로그 원문은 번역하지 마세요.",
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
        "사내용 코드 에이전트를 위한 리포지터리 수준 SUMMARY.md를 작성하세요.",
        "결정적 스캔 결과와 프로젝트 요약에 근거해서만 설명하세요.",
        "중요한 설명에는 가능한 한 관련 소스 경로를 함께 언급하세요.",
        "추론이거나 누락된 정보는 '확인 필요'에 적으세요.",
        "설명은 한국어로 작성하고, 코드 식별자와 파일 경로는 원문을 유지하세요.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `<deterministicScan>${truncateForInit(JSON.stringify(scan, null, 2), 70000)}</deterministicScan>`,
        `<projectSummaries>${truncateForInit(projectSummaries.map((item) => `## ${item.path}\n${item.content}`).join("\n\n"), 120000)}</projectSummaries>`,
        "SUMMARY.md를 다음 섹션으로 생성하세요: 솔루션 개요, 프로젝트 구성, 의존성 그래프, 진입점, 빌드 및 테스트, 중요 디렉터리, 현재 AI 작업 메모, 확인 필요.",
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
  if (body.startsWith("# 프로젝트 요약") || body.startsWith("# Project Summary")) {
    return `${body}\n\n---\nCompany Code AI 생성 시각: ${scan.generatedAt}\n`;
  }
  return `# 프로젝트 요약\n\n${body}\n\n---\nCompany Code AI 생성 시각: ${scan.generatedAt}\n`;
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
    "## 목적",
    "알 수 없음. 이 프로젝트에 대한 모델 요청이 실패했습니다.",
    "",
    "## 핵심 파일",
    project.compileFiles.length ? project.compileFiles.map((file) => `- ${file}`).join("\n") : "- 알 수 없음",
    "",
    "## 의존성",
    project.projectReferences.length ? project.projectReferences.map((file) => `- ${file}`).join("\n") : "- 감지된 ProjectReference가 없습니다.",
    "",
    "## 진입점",
    project.outputType ? `- OutputType: ${project.outputType}` : "- 알 수 없음",
    "",
    "## 위험 요소",
    "- 모델 요약 실패로 생성한 결정적 fallback 요약입니다.",
    "",
    "## 확인 필요",
    `- 프로젝트 요약 생성 실패: ${error}`,
  ].join("\n");
}

function renderFallbackSolutionSummary(scan: ScanResult, projectSummaries: ProjectSummary[], error: string): string {
  const solutionList = scan.solutionFiles.length
    ? scan.solutionFiles.map((solution) => `- ${solution.path} (${solution.projects.length}개 프로젝트)`).join("\n")
    : "- 감지된 .sln 파일이 없습니다.";
  const projectList = scan.projects.length
    ? scan.projects.map((project) => `- ${project.path}`).join("\n")
    : "- 감지된 프로젝트 파일이 없습니다.";
  return [
    "## 솔루션 개요",
    `${scan.rootName}에는 솔루션 파일 ${scan.solutionFiles.length}개와 프로젝트 파일 ${scan.projects.length}개가 있습니다.`,
    "",
    "## 프로젝트 구성",
    projectList,
    "",
    "## 의존성 그래프",
    solutionList,
    "",
    "## 진입점",
    "- 알 수 없음. 프로젝트 파일과 시작 설정을 확인해야 합니다.",
    "",
    "## 빌드 및 테스트",
    "- 알 수 없음. 빌드 및 테스트 명령은 자동 추론하지 않았습니다.",
    "",
    "## 중요 디렉터리",
    scan.topLevelFolders.length ? scan.topLevelFolders.map((folder) => `- ${folder}`).join("\n") : "- 알 수 없음",
    "",
    "## 현재 AI 작업 메모",
    projectSummaries.length ? projectSummaries.map((item) => `- 캐시된 요약: ${item.path}`).join("\n") : "- 생성된 프로젝트 요약이 없습니다.",
    "",
    "## 확인 필요",
    `- 솔루션 요약 생성 실패: ${error}`,
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
    throw new Error("프로젝트 요약을 초기화하려면 먼저 워크스페이스 폴더를 여세요.");
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
