import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
    child.stdin.end(request.input);
  });

export async function createBetterleaksScanner(
  executable: string,
  timeoutMs: number,
  runner: ProcessRunner = spawnProcess,
  workdirFactory: () => Promise<string> = createNeutralWorkdir,
): Promise<SecretScanner> {
  const cwd = await workdirFactory();
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
    return {
      version,
      async scan(text, disabledRules) {
        const scanDir = await workdirFactory();
        try {
          const result = await runner({
            command: executable,
            args: SCAN_ARGS,
            input: text,
            timeoutMs,
            cwd: scanDir,
            env: sanitizedScannerEnv(process.env),
          });
          if (result.timedOut) throw new SecretScannerError("betterleaks scan timed out");
          if (result.truncated)
            throw new SecretScannerError("betterleaks output exceeded the size limit");
          if (result.exitCode !== 0) throw new SecretScannerError("betterleaks scan failed");
          return parseFindings(result.stdout, disabledRules);
        } finally {
          await rm(scanDir, { recursive: true, force: true });
        }
      },
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function createNeutralWorkdir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kilocode-secret-redactor-"));
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
