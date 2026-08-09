import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

export interface MsBuildDiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => Promise<boolean>;
  runVswhere?: (executable: string, args: string[]) => Promise<string[]>;
}

export async function discoverVisualStudioMsBuild(options: MsBuildDiscoveryOptions = {}): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return undefined;
  const env = options.env ?? process.env;
  const exists = options.exists ?? fileExists;
  const directCandidates = [
    env.MSBUILD_EXE_PATH,
    env.VSINSTALLDIR ? path.join(env.VSINSTALLDIR, "MSBuild", "Current", "Bin", "MSBuild.exe") : undefined,
  ].filter((value): value is string => Boolean(value));
  const direct = await firstExisting(directCandidates, exists);
  if (direct) return direct;

  const programFilesX86 = env["ProgramFiles(x86)"] ?? env.ProgramFiles;
  const vswhere = programFilesX86 ? path.join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe") : undefined;
  if (vswhere && await exists(vswhere)) {
    const runVswhere = options.runVswhere ?? runVswhereProcess;
    const found = await runVswhere(vswhere, [
      "-latest", "-products", "*", "-requires", "Microsoft.Component.MSBuild", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-find", "MSBuild\\**\\Bin\\MSBuild.exe",
    ]).catch(() => []);
    const located = await firstExisting(found, exists);
    if (located) return located;
  }

  const roots = [...new Set([env.ProgramFiles, programFilesX86].filter((value): value is string => Boolean(value)))];
  const candidates: string[] = [];
  for (const root of roots) {
    for (const year of ["2022", "2019", "2017"]) {
      for (const edition of ["BuildTools", "Enterprise", "Professional", "Community"]) {
        candidates.push(path.join(root, "Microsoft Visual Studio", year, edition, "MSBuild", "Current", "Bin", "MSBuild.exe"));
      }
    }
  }
  return await firstExisting(candidates, exists);
}

export function isMsb4278(output: string): boolean {
  return /\bMSB4278\b/i.test(output);
}

async function firstExisting(candidates: string[], exists: (file: string) => Promise<boolean>): Promise<string | undefined> {
  for (const candidate of candidates.map((value) => value.trim()).filter(Boolean)) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

function runVswhereProcess(executable: string, args: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false });
    const output: string[] = [];
    child.stdout.on("data", (data: Buffer) => output.push(data.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output.join("").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) : resolve([]));
  });
}
