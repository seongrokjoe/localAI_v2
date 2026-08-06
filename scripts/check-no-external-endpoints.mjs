import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const denied = [
  "api." + "openai.com",
  "chat" + "gpt.com",
  "platform." + "openai.com",
  "developers." + "openai.com",
];
const ignoredDirs = new Set(["node_modules", "dist", ".git", ".company-code-ai"]);
const ignoredFiles = new Set(["package-lock.json", "pnpm-lock.yaml"]);

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (ignoredDirs.has(name)) {
      continue;
    }
    const file = join(dir, name);
    const stat = statSync(file);
    if (stat.isDirectory()) {
      walk(file, out);
    } else if (!ignoredFiles.has(name)) {
      out.push(file);
    }
  }
}

const files = [];
walk(root, files);

const failures = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const value of denied) {
    if (text.includes(value)) {
      failures.push(`${relative(root, file)} contains forbidden endpoint: ${value}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("No forbidden external endpoints found.");
