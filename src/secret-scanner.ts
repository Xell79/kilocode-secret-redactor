import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import {
  MAX_SCAN_OUTPUT_CHARS,
  MIN_BETTERLEAKS_VERSION,
  SCAN_ARGS,
  SCANNER_CONFIG_ENV,
} from "./config.js";
import type { Finding } from "./findings.js";

export class SecretScannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretScannerError";
  }
}

export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly input: string;
  readonly timeoutMs: number;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

export interface SecretScanner {
  readonly version: string;
  scan(text: string, disabledRules: ReadonlySet<string>): Promise<Finding[]>;
  /** Release the scanner's neutral working directory. Idempotent. */
  dispose(): Promise<void>;
}

interface JsonFinding {
  readonly RuleID?: unknown;
  readonly Secret?: unknown;
}

export function parseBetterleaksVersion(output: string): string | undefined {
  return output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
}

export function isVersionAtLeast(version: string, minimum: string): boolean {
  const left = version.split(".").map(Number);
  const right = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return true;
}

export function sanitizedScannerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of SCANNER_CONFIG_ENV) delete next[key];
  return next;
}

export async function resolveBetterleaks(
  path: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (path) {
    await assertExecutable(path);
    return path;
  }
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    // A relative PATH entry (".", "./bin") resolves against process.cwd(),
    // which lets the scanned repository supply the scanner binary.
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, "betterleaks");
    try {
      await assertExecutable(candidate);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  throw new SecretScannerError("betterleaks executable was not found");
}

async function assertExecutable(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  // Directories are executable by default, so X_OK alone accepts a directory
  // named "betterleaks" and defers the failure to spawn (EISDIR/EACCES).
  if (!info?.isFile()) throw new SecretScannerError("betterleaks executable is not accessible");
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new SecretScannerError("betterleaks executable is not accessible");
  }
}

export const spawnProcess: ProcessRunner = (request) =>
  new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, request.timeoutMs);

    const finish = (result: ProcessResult | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_SCAN_OUTPUT_CHARS) stdout += chunk;
      if (stdout.length > MAX_SCAN_OUTPUT_CHARS) {
        truncated = true;
        stdout = stdout.slice(0, MAX_SCAN_OUTPUT_CHARS);
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4_096) stderr += chunk;
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      finish({ stdout, stderr, exitCode: code ?? -1, timedOut, truncated });
    });
    // A failed spawn destroys stdin; without this handler the write below
    // emits an unhandled 'error' and crashes the host process.
    child.stdin.on("error", (error) => finish(error));
    child.stdin.end(request.input);
  });

export async function createBetterleaksScanner(
  executable: string,
  timeoutMs: number,
  runner: ProcessRunner = spawnProcess,
  workdirFactory: () => Promise<string> = createNeutralWorkdir,
): Promise<SecretScanner> {
  // One directory for the scanner's whole lifetime. `betterleaks stdin` reads
  // `.gitleaks.toml` and `.gitleaksignore` from its cwd, so the directory must
  // stay empty and private; it is never per-scan and never the repository.
  let cwd = await workdirFactory();
  let disposed = false;
  const release = async () => {
    if (disposed) return;
    disposed = true;
    await rm(cwd, { recursive: true, force: true });
  };
  try {
    const versionResult = await runner({
      command: executable,
      args: ["version"],
      input: "",
      timeoutMs,
      cwd,
      env: sanitizedScannerEnv(process.env),
    });
    if (versionResult.timedOut || versionResult.exitCode !== 0) {
      throw new SecretScannerError("betterleaks health check failed");
    }
    const version = parseBetterleaksVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
    if (!version || !isVersionAtLeast(version, MIN_BETTERLEAKS_VERSION)) {
      throw new SecretScannerError(`betterleaks ${MIN_BETTERLEAKS_VERSION} or newer is required`);
    }
    const runScan = (text: string) =>
      runner({
        command: executable,
        args: SCAN_ARGS,
        input: text,
        timeoutMs,
        cwd,
        env: sanitizedScannerEnv(process.env),
      });
    return {
      version,
      async scan(text, disabledRules) {
        if (disposed) throw new SecretScannerError("betterleaks scanner was disposed");
        let result: ProcessResult;
        try {
          result = await runScan(text);
        } catch (error) {
          // A long-lived session can outlive the temp directory (tmp reaper).
          if (!isMissingPath(error)) throw error;
          cwd = await workdirFactory();
          result = await runScan(text);
        }
        if (result.timedOut) throw new SecretScannerError("betterleaks scan timed out");
        if (result.truncated)
          throw new SecretScannerError("betterleaks output exceeded the size limit");
        if (result.exitCode !== 0) throw new SecretScannerError("betterleaks scan failed");
        return parseFindings(result.stdout, disabledRules);
      },
      dispose: release,
    };
  } catch (error) {
    await release();
    throw error;
  }
}

/**
 * Private empty directory used as the scanner's cwd.
 *
 * `betterleaks stdin` calls `initConfig(".")`, so it loads
 * `(cwd)/.gitleaks.toml` and, with an empty source, `(cwd)/.gitleaksignore`.
 * A repository-controlled cwd could allowlist every finding; `tmpdir()` itself
 * is world-writable, so only a fresh `0700` directory is safe. The directory
 * holds no data: input travels on stdin and the report comes back on stdout.
 */
async function createNeutralWorkdir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kilocode-secret-redactor-"));
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function parseFindings(stdout: string, disabledRules: ReadonlySet<string>): Finding[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new SecretScannerError("betterleaks returned malformed JSON");
  }
  if (!Array.isArray(parsed)) throw new SecretScannerError("betterleaks JSON must be an array");

  const findings: Finding[] = [];
  for (const item of parsed) {
    if (!isFinding(item))
      throw new SecretScannerError("betterleaks finding is missing RuleID or Secret");
    const category = item.RuleID.trim();
    if (!category || disabledRules.has(category.toLowerCase())) continue;
    findings.push({ category, value: item.Secret, source: "betterleaks" });
  }
  return findings;
}

function isFinding(value: unknown): value is { RuleID: string; Secret: string } {
  if (typeof value !== "object" || value === null) return false;
  const finding = value as JsonFinding;
  return typeof finding.RuleID === "string" && typeof finding.Secret === "string";
}
