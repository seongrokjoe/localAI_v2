import * as fs from "node:fs/promises";
import * as path from "node:path";

export type ProjectKind = "vcxproj" | "sln" | "cmake" | "dotnet" | "node";

export interface ProjectDescriptor {
  id: string;
  path: string;
  directory: string;
  kind: ProjectKind;
  sourceFiles: string[];
  references: string[];
  testProject: boolean;
}

export interface ProjectGraph {
  projects: ProjectDescriptor[];
  changedProjects: ProjectDescriptor[];
  dependentProjects: ProjectDescriptor[];
  unresolvedPaths: string[];
  ambiguousPaths: string[];
  ambiguousCandidates: Record<string, string[]>;
}

const ignoredDirectories = new Set([".git", ".company-code-ai", "node_modules", "bin", "obj", "dist", "out"]);

export async function discoverProjectGraph(root: string, changedPaths: string[], projectOverrides: Record<string, string> = {}): Promise<ProjectGraph> {
  const files = await listFiles(root);
  const descriptors: ProjectDescriptor[] = [];
  const byPath = new Map<string, ProjectDescriptor>();
  for (const file of files) {
    const lower = file.toLowerCase();
    let descriptor: ProjectDescriptor | undefined;
    if (lower.endsWith(".vcxproj")) descriptor = await parseVcxproj(root, file);
    else if (lower.endsWith(".csproj") || lower.endsWith(".fsproj") || lower.endsWith(".vbproj")) descriptor = await parseDotnetProject(root, file);
    else if (lower.endsWith(".sln") || lower.endsWith(".slnx")) descriptor = await parseSolution(root, file);
    else if (path.basename(lower) === "cmakelists.txt") descriptor = await parseCmake(root, file);
    else if (path.basename(lower) === "package.json") descriptor = parseNodeProject(file);
    if (!descriptor) continue;
    descriptors.push(descriptor);
    byPath.set(normalize(file), descriptor);
  }

  const normalizedChanges = changedPaths.map(normalize).filter(Boolean);
  const changedSet = new Map<string, ProjectDescriptor>();
  const unresolvedPaths: string[] = [];
  const ambiguousPaths: string[] = [];
  const ambiguousCandidates: Record<string, string[]> = {};
  for (const changed of normalizedChanges) {
    const exact = descriptors.filter((project) => projectContains(project, changed));
    const override = projectOverrides[changed];
    const overridden = override ? descriptors.find((project) => project.id === override || project.path === override) : undefined;
    if (overridden && (exact.length === 0 || exact.some((project) => project.id === overridden.id))) {
      changedSet.set(overridden.id, overridden);
      continue;
    }
    if (exact.length === 1) {
      changedSet.set(exact[0].id, exact[0]);
      continue;
    }
    if (exact.length > 1) {
      ambiguousPaths.push(changed);
      ambiguousCandidates[changed] = exact.map((project) => project.path);
      continue;
    }
    if (overridden) {
      changedSet.set(overridden.id, overridden);
      continue;
    }
    const candidates = descriptors
      .filter((project) => project.kind !== "sln" && isWithin(project.directory, changed) && (project.kind !== "node" || /\.(js|jsx|ts|tsx|mjs|cjs|json)$/i.test(changed)))
      .sort((left, right) => right.directory.split("/").length - left.directory.split("/").length);
    const nearestDepth = candidates[0]?.directory.split("/").length ?? -1;
    const nearest = candidates.filter((project) => project.directory.split("/").length === nearestDepth);
    if (nearest.length === 1) changedSet.set(nearest[0].id, nearest[0]);
    else if (nearest.length > 1) {
      ambiguousPaths.push(changed);
      ambiguousCandidates[changed] = nearest.map((project) => project.path);
    }
    else unresolvedPaths.push(changed);
  }
  const changedProjects = [...changedSet.values()];
  const selected = new Set(changedProjects.map((project) => project.id));
  const dependentProjects = descriptors.filter((project) => !selected.has(project.id) && dependsOnSelected(project, selected, byPath));
  return {
    projects: descriptors.sort((left, right) => left.path.localeCompare(right.path)),
    changedProjects,
    dependentProjects,
    unresolvedPaths,
    ambiguousPaths,
    ambiguousCandidates,
  };
}

async function parseVcxproj(root: string, relativePath: string): Promise<ProjectDescriptor> {
  const text = await readText(root, relativePath);
  const directory = path.posix.dirname(relativePath);
  const sourceFiles = extractAttributes(text, /<(?:ClCompile|ClInclude|ResourceCompile|None)\b[^>]*\bInclude="([^"]+)"/gi)
    .map((value) => resolveRelative(directory, value));
  const references = extractAttributes(text, /<ProjectReference\b[^>]*\bInclude="([^"]+)"/gi)
    .map((value) => resolveRelative(directory, value));
  return descriptor(relativePath, "vcxproj", directory, sourceFiles, references);
}

async function parseDotnetProject(root: string, relativePath: string): Promise<ProjectDescriptor> {
  const directory = path.posix.dirname(relativePath);
  const text = await readText(root, relativePath);
  const sourceFiles = extractAttributes(text, /<(?:Compile|None)\b[^>]*\bInclude="([^"]+)"/gi)
    .map((value) => resolveRelative(directory, value));
  return descriptor(relativePath, "dotnet", directory, sourceFiles, extractAttributes(text, /<ProjectReference\b[^>]*\bInclude="([^"]+)"/gi).map((value) => resolveRelative(directory, value)));
}

async function parseSolution(root: string, relativePath: string): Promise<ProjectDescriptor> {
  const directory = path.posix.dirname(relativePath);
  const text = await readText(root, relativePath);
  const references = Array.from(text.matchAll(/Project\("[^"]+"\)\s*=\s*"[^"]+",\s*"([^"]+)"/g))
    .map((match) => resolveRelative(directory, match[1]));
  return descriptor(relativePath, "sln", directory, [], references);
}

async function parseCmake(root: string, relativePath: string): Promise<ProjectDescriptor> {
  const directory = path.posix.dirname(relativePath);
  const text = await readText(root, relativePath);
  const sourceFiles = extractCmakeSources(text).map((value) => resolveRelative(directory, value));
  if (sourceFiles.length === 0) {
    const candidates = (await listFiles(root)).filter((file) => isSourceFile(file) && isWithin(directory, file));
    sourceFiles.push(...candidates);
  }
  return descriptor(relativePath, "cmake", directory, sourceFiles, []);
}

function parseNodeProject(relativePath: string): ProjectDescriptor {
  const directory = path.posix.dirname(relativePath);
  return descriptor(relativePath, "node", directory, [], []);
}

function descriptor(pathValue: string, kind: ProjectKind, directory: string, sourceFiles: string[], references: string[]): ProjectDescriptor {
  return {
    id: normalize(pathValue),
    path: normalize(pathValue),
    directory: normalize(directory === "." ? "" : directory),
    kind,
    sourceFiles: [...new Set(sourceFiles.map(normalize).filter(isSafeRelativePath))],
    references: [...new Set(references.map(normalize).filter(isSafeRelativePath))],
    testProject: /(^|[._-])(test|tests)([._-]|$)/i.test(path.basename(pathValue)) || /test/i.test(pathValue),
  };
}

function projectContains(project: ProjectDescriptor, changed: string): boolean {
  if (project.sourceFiles.some((source) => source === changed || matchesPathPattern(source, changed))) return true;
  if (project.kind === "sln") return false;
  if (project.kind === "node") return isWithin(project.directory, changed) && /\.(js|jsx|ts|tsx|mjs|cjs|json)$/i.test(changed);
  if (project.kind === "dotnet") return isWithin(project.directory, changed) && /\.(cs|fs|vb|resx|xaml|json|config)$/i.test(changed);
  if (project.sourceFiles.length === 0) return isWithin(project.directory, changed) && isSourceFile(changed);
  return false;
}

function matchesPathPattern(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return false;
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`, "i").test(value);
}

function dependsOnSelected(project: ProjectDescriptor, selected: Set<string>, byPath: Map<string, ProjectDescriptor>): boolean {
  return dependsOnSelectedInternal(project, selected, byPath, new Set<string>());
}

function dependsOnSelectedInternal(project: ProjectDescriptor, selected: Set<string>, byPath: Map<string, ProjectDescriptor>, visiting: Set<string>): boolean {
  if (visiting.has(project.id)) return false;
  visiting.add(project.id);
  return project.references.some((reference) => {
    const referenced = byPath.get(reference);
    return Boolean(referenced && (selected.has(referenced.id) || dependsOnSelectedInternal(referenced, selected, byPath, visiting)));
  });
}

function extractAttributes(text: string, expression: RegExp): string[] {
  return Array.from(text.matchAll(expression)).map((match) => match[1]);
}

function extractCmakeSources(text: string): string[] {
  const values: string[] = [];
  for (const match of text.matchAll(/(?:target_sources|add_executable|add_library)\s*\([^)]*\)/gis)) {
    const body = match[0].replace(/^[^(]*\(/, "").replace(/\)\s*$/, "");
    for (const token of body.split(/[\s\r\n]+/).map((value) => value.trim()).filter(Boolean)) {
      if (isSourceFile(token) && !token.startsWith("$")) values.push(token);
    }
  }
  return values;
}

function isSourceFile(value: string): boolean {
  return /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|ixx|m|mm|cs|fs|vb)$/i.test(value);
}

function isWithin(directory: string, file: string): boolean {
  return !directory || file === directory || file.startsWith(`${directory}/`);
}

function resolveRelative(directory: string, value: string): string {
  const cleaned = value.replace(/\$\([^)]*\)/g, "").replace(/\\/g, "/").replace(/^\/+/, "");
  return normalize(path.posix.normalize(path.posix.join(directory, cleaned)));
}

function normalize(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized === "." ? "" : normalized;
}

function isSafeRelativePath(value: string): boolean {
  return Boolean(value) && !path.posix.isAbsolute(value) && value !== ".." && !value.startsWith("../");
}

async function readText(root: string, relativePath: string): Promise<string> {
  try {
    const bytes = await fs.readFile(path.join(root, relativePath));
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return Buffer.from(bytes.subarray(2)).toString("utf16le");
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    return bytes.toString("utf8").replace(/^\uFEFF/, "");
  } catch {
    return "";
  }
}

async function listFiles(root: string, current = ""): Promise<string[]> {
  const directory = path.join(root, current);
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const relative = normalize(path.posix.join(current.replace(/\\/g, "/"), entry.name));
    if (entry.isDirectory()) files.push(...await listFiles(root, relative));
    else files.push(relative);
  }
  return files;
}
