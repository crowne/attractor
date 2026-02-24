/**
 * Execution Environment Interface & Local Implementation
 * Abstracts where tools run (local, Docker, K8s, etc.)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { glob as globCallback } from "node:fs";

// ── Interface ──────────────────────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out: boolean;
  duration_ms: number;
}

export interface DirEntry {
  name: string;
  is_dir: boolean;
  size?: number;
}

export interface GrepOptions {
  case_insensitive?: boolean;
  max_results?: number;
  glob_filter?: string;
}

export interface ExecutionEnvironment {
  // File operations
  readFile(filePath: string, offset?: number, limit?: number): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  fileExists(filePath: string): Promise<boolean>;
  listDirectory(dirPath: string, depth?: number): Promise<DirEntry[]>;

  // Command execution
  execCommand(
    command: string,
    timeoutMs?: number,
    workingDir?: string,
    envVars?: Record<string, string>
  ): Promise<ExecResult>;

  // Search operations
  grep(pattern: string, searchPath: string, options?: GrepOptions): Promise<string>;
  globFiles(pattern: string, basePath?: string): Promise<string[]>;

  // Lifecycle
  initialize(): Promise<void>;
  cleanup(): Promise<void>;

  // Metadata
  workingDirectory(): string;
  platform(): string;
  osVersion(): string;
}

// ── Sensitive env var filtering ────────────────────────────────────────

const SENSITIVE_PATTERNS = [
  /API_KEY$/i,
  /SECRET/i,
  /TOKEN$/i,
  /PASSWORD/i,
  /PRIVATE_KEY/i,
  /CREDENTIALS/i,
];

function filterEnvVars(
  env: Record<string, string | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value == null) continue;
    const isSensitive = SENSITIVE_PATTERNS.some((p) => p.test(key));
    if (!isSensitive) {
      result[key] = value;
    }
  }
  return result;
}

// ── Local Implementation ───────────────────────────────────────────────

export class LocalExecutionEnvironment implements ExecutionEnvironment {
  private workDir: string;

  constructor(workingDir?: string) {
    this.workDir = workingDir ?? process.cwd();
  }

  async initialize(): Promise<void> {
    if (!fs.existsSync(this.workDir)) {
      fs.mkdirSync(this.workDir, { recursive: true });
    }
  }

  async cleanup(): Promise<void> {
    // No-op for local env
  }

  workingDirectory(): string {
    return this.workDir;
  }

  platform(): string {
    return process.platform;
  }

  osVersion(): string {
    try {
      if (process.platform === "win32") {
        return execSync("ver", { encoding: "utf-8" }).trim();
      }
      return execSync("uname -a", { encoding: "utf-8" }).trim();
    } catch {
      return process.platform;
    }
  }

  async readFile(
    filePath: string,
    offset?: number,
    limit?: number
  ): Promise<string> {
    const resolved = path.resolve(this.workDir, filePath);
    const content = fs.readFileSync(resolved, "utf-8");
    const lines = content.split("\n");

    const startLine = (offset ?? 1) - 1;
    const endLine = limit ? startLine + limit : lines.length;
    const selectedLines = lines.slice(
      Math.max(0, startLine),
      Math.min(lines.length, endLine)
    );

    // Prepend line numbers
    return selectedLines
      .map((line, i) => `${String(startLine + i + 1).padStart(4)} | ${line}`)
      .join("\n");
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const resolved = path.resolve(this.workDir, filePath);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolved, content, "utf-8");
  }

  async fileExists(filePath: string): Promise<boolean> {
    const resolved = path.resolve(this.workDir, filePath);
    return fs.existsSync(resolved);
  }

  async listDirectory(
    dirPath: string,
    depth = 1
  ): Promise<DirEntry[]> {
    const resolved = path.resolve(this.workDir, dirPath);
    if (!fs.existsSync(resolved)) return [];

    const entries: DirEntry[] = [];
    const items = fs.readdirSync(resolved, { withFileTypes: true });

    for (const item of items) {
      const stats = fs.statSync(path.join(resolved, item.name));
      entries.push({
        name: item.name,
        is_dir: item.isDirectory(),
        size: stats.size,
      });

      if (item.isDirectory() && depth > 1) {
        const subEntries = await this.listDirectory(
          path.join(dirPath, item.name),
          depth - 1
        );
        for (const sub of subEntries) {
          entries.push({
            ...sub,
            name: `${item.name}/${sub.name}`,
          });
        }
      }
    }

    return entries;
  }

  async execCommand(
    command: string,
    timeoutMs = 10000,
    workingDir?: string,
    envVars?: Record<string, string>
  ): Promise<ExecResult> {
    const cwd = workingDir
      ? path.resolve(this.workDir, workingDir)
      : this.workDir;

    const env = {
      ...filterEnvVars(process.env as Record<string, string>),
      ...envVars,
    };

    return new Promise<ExecResult>((resolve) => {
      const startTime = Date.now();
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let childProcess: ChildProcess;

      const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
      const shellArg = process.platform === "win32" ? "/c" : "-c";

      childProcess = spawn(shell, [shellArg, command], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      childProcess.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      childProcess.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          childProcess.kill("SIGTERM");
          setTimeout(() => {
            try {
              childProcess.kill("SIGKILL");
            } catch {
              // ignore
            }
          }, 2000);
        } catch {
          // ignore
        }
      }, timeoutMs);

      childProcess.on("close", (code) => {
        clearTimeout(timer);
        const duration = Date.now() - startTime;

        if (timedOut) {
          stderr += `\n[ERROR: Command timed out after ${timeoutMs}ms. Partial output is shown above. You can retry with a longer timeout by setting the timeout_ms parameter.]`;
        }

        resolve({
          stdout,
          stderr,
          exit_code: code ?? 1,
          timed_out: timedOut,
          duration_ms: duration,
        });
      });

      childProcess.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr: stderr + "\n" + err.message,
          exit_code: 1,
          timed_out: false,
          duration_ms: Date.now() - startTime,
        });
      });
    });
  }

  async grep(
    pattern: string,
    searchPath: string,
    options?: GrepOptions
  ): Promise<string> {
    const resolved = path.resolve(this.workDir, searchPath);
    const results: string[] = [];
    const maxResults = options?.max_results ?? 100;
    const caseInsensitive = options?.case_insensitive ?? false;

    const regex = new RegExp(pattern, caseInsensitive ? "i" : "");

    const searchFile = (filePath: string) => {
      if (results.length >= maxResults) return;
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxResults) break;
          if (regex.test(lines[i]!)) {
            const relPath = path.relative(this.workDir, filePath);
            results.push(`${relPath}:${i + 1}: ${lines[i]}`);
          }
        }
      } catch {
        // Skip binary or unreadable files
      }
    };

    const walkDir = (dir: string) => {
      if (results.length >= maxResults) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= maxResults) break;
          const full = path.join(dir, entry.name);

          // Skip common non-code directories
          if (
            entry.isDirectory() &&
            !["node_modules", ".git", "dist", "build", "__pycache__"].includes(
              entry.name
            )
          ) {
            walkDir(full);
          } else if (entry.isFile()) {
            if (options?.glob_filter) {
              const ext = path.extname(entry.name);
              const filterExt = options.glob_filter.replace("*", "");
              if (ext !== filterExt) continue;
            }
            searchFile(full);
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    };

    const stats = fs.statSync(resolved);
    if (stats.isFile()) {
      searchFile(resolved);
    } else {
      walkDir(resolved);
    }

    return results.join("\n");
  }

  async globFiles(pattern: string, basePath?: string): Promise<string[]> {
    const base = basePath
      ? path.resolve(this.workDir, basePath)
      : this.workDir;

    // Simple glob implementation
    const results: string[] = [];

    const walkDir = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          const rel = path.relative(base, full);

          if (entry.isDirectory()) {
            if (
              !["node_modules", ".git", "dist", "build"].includes(entry.name)
            ) {
              walkDir(full);
            }
          } else {
            if (matchGlob(rel, pattern)) {
              results.push(rel);
            }
          }
        }
      } catch {
        // Skip inaccessible
      }
    };

    walkDir(base);

    // Sort by modification time (newest first)
    results.sort((a, b) => {
      try {
        const aTime = fs.statSync(path.join(base, a)).mtimeMs;
        const bTime = fs.statSync(path.join(base, b)).mtimeMs;
        return bTime - aTime;
      } catch {
        return 0;
      }
    });

    return results;
  }
}

// ── Simple glob matcher ────────────────────────────────────────────────

function matchGlob(filepath: string, pattern: string): boolean {
  // Convert glob to regex
  const normalized = filepath.replace(/\\/g, "/");
  let regexStr = pattern
    .replace(/\\/g, "/")
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "##GLOBSTAR##")
    .replace(/\*/g, "[^/]*")
    .replace(/##GLOBSTAR##/g, ".*")
    .replace(/\?/g, ".");

  try {
    return new RegExp(`^${regexStr}$`).test(normalized);
  } catch {
    return false;
  }
}
