// Executable lookup without a shell. On Windows only real executables count:
// `.cmd`/`.bat`/`.ps1` npm shims would run through cmd.exe / PowerShell.

import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, extname, join } from "node:path";

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isShellShim(p: string): boolean {
  const ext = extname(p).toLowerCase();
  return ext === ".cmd" || ext === ".bat" || ext === ".ps1";
}

/** VS Code ships a `copilot.exe` shim that only prints "GitHub Copilot CLI was not found". */
export function isVsCodeCopilotShim(p: string): boolean {
  const lower = p.replace(/\//g, "\\").toLowerCase();
  return lower.includes("\\copilot-shim\\") || /\\microsoft vs code[^\\]*\\/.test(lower);
}

export function which(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const pathVar = env.PATH ?? env.Path ?? "";
  const exts = platform === "win32" ? [".exe", ".com"] : [""];
  for (const dir of pathVar.split(platform === "win32" ? ";" : delimiter)) {
    const d = dir.trim().replace(/^"|"$/g, "");
    if (!d) continue;
    for (const ext of exts) {
      const candidate = join(d, name.toLowerCase().endsWith(ext) ? name : name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** First non-empty line of `<exe> <args>` (e.g. `--version`), if it answers within 15 s. */
export function versionOf(exe: string, args: string[] = ["--version"]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout: 15_000, windowsHide: true, shell: false }, (err, stdout) => {
      if (err && !stdout) return resolve(undefined);
      const line = String(stdout)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      resolve(line ? line.slice(0, 80) : undefined);
    });
  });
}
