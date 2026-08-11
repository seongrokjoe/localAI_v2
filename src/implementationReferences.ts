import * as fs from "node:fs/promises";
import * as path from "node:path";

export function extractDirectReferenceSpecifiers(sourcePath: string, content: string): string[] {
  const references = new Set<string>();
  for (const match of content.matchAll(/^\s*#\s*include\s*"([^"]+)"/gm)) references.add(match[1]);
  if (/\.(?:[cm]?[jt]sx?|mjs|cjs)$/i.test(sourcePath)) {
    const patterns = [
      /(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g,
      /require\s*\(\s*["']([^"']+)["']\s*\)/g,
      /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    ];
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        if (match[1].startsWith("./") || match[1].startsWith("../")) references.add(match[1]);
      }
    }
  }
  return [...references];
}

export async function resolveImplementationReference(root: string, sourcePath: string, specifier: string): Promise<string | undefined> {
  const sourceDirectory = path.dirname(path.join(root, sourcePath));
  const bases = [path.resolve(sourceDirectory, specifier), path.resolve(root, specifier)];
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".h", ".hpp", ".hh", ".hxx"];
  const candidates = new Set<string>();
  for (const base of bases) {
    for (const extension of extensions) candidates.add(base + extension);
    for (const extension of extensions.slice(1)) candidates.add(path.join(base, "index" + extension));
  }
  for (const candidate of candidates) {
    const relative = path.relative(root, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return relative.replace(/\\/g, "/");
    } catch {
      // Try the next local resolution candidate.
    }
  }
  return undefined;
}
