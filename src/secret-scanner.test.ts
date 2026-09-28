import { mkdirSync, mkdtempSync } from "node:fs";
import { access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SCAN_ARGS, SCANNER_CONFIG_ENV } from "./config.js";
import {
  createBetterleaksScanner,
  isVersionAtLeast,
  type ProcessRequest,
  type ProcessRunner,
  parseBetterleaksVersion,
  parseFindings,
  resolveBetterleaks,
  SecretScannerError,
  sanitizedScannerEnv,
  spawnProcess,
} from "./secret-scanner.js";

const runner = (result: Partial<Awaited<ReturnType<ProcessRunner>>>): ProcessRunner =>
  vi.fn(async () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    truncated: false,
    ...result,
  }));

describe("betterleaks adapter", () => {
  it("parses and enforces the minimum version", () => {
    expect(parseBetterleaksVersion("betterleaks version 1.8.1")).toBe("1.8.1");
    expect(isVersionAtLeast("1.8.1", "1.8.1")).toBe(true);
    expect(isVersionAtLeast("1.8.0", "1.8.1")).toBe(false);
  });

  it("strips scanner config environment variables", () => {
    const env = sanitizedScannerEnv({
      PATH: "/bin",
      BETTERLEAKS_CONFIG: "/repo/.betterleaks.toml",
      GITLEAKS_CONFIG_TOML: "rules",
    });
    expect(env.PATH).toBe("/bin");
    for (const key of SCANNER_CONFIG_ENV) expect(env[key]).toBeUndefined();
  });

  it("scans with the fixed local contract", async () => {
    const scan = runner({
      stdout: JSON.stringify([{ RuleID: "github-pat", Secret: "ghp_example" }]),
    });
    const calls = vi
      .fn<ProcessRunner>()
      .mockResolvedValueOnce({
        stdout: "1.8.1",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        truncated: false,
      })
      .mockImplementationOnce(scan);
    const scanner = await createBetterleaksScanner("/bin/betterleaks", 1000, calls, async () =>
      mkdtempSync(join(tmpdir(), "scanner-test-")),
    );
    const findings = await scanner.scan("text", new Set(["generic-api-key"]));
    expect(findings).toEqual([
      { category: "github-pat", value: "ghp_example", source: "betterleaks" },
    ]);
    const request = calls.mock.calls[1][0];
    expect(request.args).toEqual(SCAN_ARGS);
    expect(request.args.join(" ")).not.toMatch(/validation|verbose|--redact/);
    expect(request.env.BETTERLEAKS_CONFIG).toBeUndefined();
    expect(request.cwd).not.toBe(process.cwd());
  });

  it("rejects an older binary", async () => {
    const calls = runner({ stdout: "1.7.4" });
    const dir = mkdtempSync(join(tmpdir(), "scanner-old-"));
    mkdirSync(join(dir, "nested"));
    await expect(
      createBetterleaksScanner("/bin/betterleaks", 1000, calls, async () => dir),
    ).rejects.toBeInstanceOf(SecretScannerError);
  });

  it("scans a synthetic token with the installed Betterleaks binary", async () => {
    const executable = process.env.BETTERLEAKS_BIN;
    if (!executable) return;
    const scanner = await createBetterleaksScanner(executable, 20_000);
    const token = ["ghp", "R8z3kL9mN2pQ5tV7wX0yB4dF6hJ1oS3uA8cE"].join("_");
    const findings = await scanner.scan(`token ${token}`, new Set());
    expect(
      findings.some((finding) => finding.value === token && finding.source === "betterleaks"),
    ).toBe(true);
  });

  it("reuses one working directory for every scan and releases it once", async () => {
    const dirs: string[] = [];
    const calls = vi.fn<ProcessRunner>().mockImplementation(async (request: ProcessRequest) => ({
      stdout: request.args[0] === "version" ? "1.8.1" : "[]",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      truncated: false,
    }));
    const scanner = await createBetterleaksScanner("/bin/betterleaks", 1000, calls, async () => {
      const dir = mkdtempSync(join(tmpdir(), "scanner-reuse-"));
      dirs.push(dir);
      return dir;
    });
    await scanner.scan("one", new Set());
    await scanner.scan("two", new Set());
    expect(dirs).toHaveLength(1);
    expect(calls.mock.calls.map((call) => call[0].cwd)).toEqual([dirs[0], dirs[0], dirs[0]]);
    await access(dirs[0]);
    await scanner.dispose();
    await scanner.dispose();
    await expect(access(dirs[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recreates the working directory once when a scan finds it gone", async () => {
    const dirs: string[] = [];
    const missing = Object.assign(new Error("cwd vanished"), { code: "ENOENT" });
    let scans = 0;
    const calls = vi.fn<ProcessRunner>().mockImplementation(async (request: ProcessRequest) => {
      if (request.args[0] !== "version") scans += 1;
      if (scans === 1) throw missing;
      return {
        stdout: request.args[0] === "version" ? "1.8.1" : "[]",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        truncated: false,
      };
    });
    const scanner = await createBetterleaksScanner("/bin/betterleaks", 1000, calls, async () => {
      const dir = mkdtempSync(join(tmpdir(), "scanner-retry-"));
      dirs.push(dir);
      return dir;
    });
    await expect(scanner.scan("text", new Set())).resolves.toEqual([]);
    expect(dirs).toHaveLength(2);

    scans = 0;
    calls.mockImplementation(async () => {
      scans += 1;
      throw missing;
    });
    await expect(scanner.scan("text", new Set())).rejects.toBe(missing);
    await scanner.dispose();
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("rejects a directory even when it is executable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scanner-dir-"));
    await expect(resolveBetterleaks(dir)).rejects.toBeInstanceOf(SecretScannerError);
    await rm(dir, { recursive: true, force: true });
  });

  it("ignores relative PATH entries when resolving the scanner", async () => {
    await expect(resolveBetterleaks(undefined, { PATH: ".:./bin:" })).rejects.toBeInstanceOf(
      SecretScannerError,
    );
  });

  it("reports a spawn failure instead of crashing", async () => {
    const request: ProcessRequest = {
      command: join(tmpdir(), "kilocode-secret-redactor-missing-binary"),
      args: [],
      input: "text",
      timeoutMs: 1000,
      cwd: tmpdir(),
      env: {},
    };
    await expect(spawnProcess(request)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects malformed findings", () => {
    expect(() => parseFindings("{", new Set())).toThrow(SecretScannerError);
    expect(
      parseFindings(JSON.stringify([{ RuleID: "skip", Secret: "x" }]), new Set(["skip"])),
    ).toEqual([]);
  });
});
