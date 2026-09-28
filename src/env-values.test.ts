import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_ENV_FILE_BYTES, PluginConfigError } from "./config.js";
import { discoverRootEnvFiles, loadEnvFindings } from "./env-values.js";

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), "env-values-"));
}

describe("loadEnvFindings", () => {
  it("reads root env files and skips templates, short, sample, and interpolated values", async () => {
    const root = await fixture();
    await writeFile(
      join(root, ".env"),
      'export API_TOKEN="quoted-secret-value"\nPASSWORD=changeme\nSHORT=abc\nREF=$' +
        "{OTHER}\n# comment\n",
    );
    await writeFile(join(root, ".env.local"), "LOCAL_KEY=local-secret-value\n");
    await writeFile(join(root, ".env.example"), "EXAMPLE_KEY=should-not-load\n");
    await writeFile(join(root, "nested"), "");

    const findings = await loadEnvFindings(root, {
      autoEnvFiles: true,
      envFiles: [],
      minValueLength: 8,
      strict: true,
    });
    expect(findings.map((item) => item.value).sort()).toEqual([
      "local-secret-value",
      "quoted-secret-value",
    ]);
    expect(findings.every((item) => item.source === "env")).toBe(true);
  });

  it("rejects an env path that escapes the worktree", async () => {
    const root = await fixture();
    const outside = await fixture();
    await writeFile(join(outside, "secret.env"), "TOKEN=outside-secret-value\n");
    await expect(
      loadEnvFindings(root, {
        autoEnvFiles: false,
        envFiles: [join(outside, "secret.env")],
        minValueLength: 8,
        strict: true,
      }),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("returns nothing for an unreadable worktree unless strict", async () => {
    const missing = join(await fixture(), "absent");
    await expect(discoverRootEnvFiles(missing, false)).resolves.toEqual([]);
    await expect(discoverRootEnvFiles(missing, true)).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("skips a directory configured as an env file", async () => {
    const root = await fixture();
    await expect(
      loadEnvFindings(root, {
        autoEnvFiles: false,
        envFiles: ["."],
        minValueLength: 8,
        strict: false,
      }),
    ).resolves.toEqual([]);
    await expect(
      loadEnvFindings(root, {
        autoEnvFiles: false,
        envFiles: ["."],
        minValueLength: 8,
        strict: true,
      }),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });

  it("skips an env file above the size limit", async () => {
    const root = await fixture();
    await writeFile(join(root, ".env"), `TOKEN=${"a".repeat(MAX_ENV_FILE_BYTES)}\n`);
    const options = { autoEnvFiles: true, envFiles: [], minValueLength: 8 };
    await expect(loadEnvFindings(root, { ...options, strict: false })).resolves.toEqual([]);
    await expect(loadEnvFindings(root, { ...options, strict: true })).rejects.toBeInstanceOf(
      PluginConfigError,
    );
  });

  it("warns when an env file is readable by group or others", async () => {
    const root = await fixture();
    const path = join(root, ".env");
    await writeFile(path, "TOKEN=group-readable-secret\n");
    await chmod(path, 0o644);
    const warnings: string[] = [];
    const findings = await loadEnvFindings(root, {
      autoEnvFiles: true,
      envFiles: [],
      minValueLength: 8,
      strict: true,
      warn: (message) => warnings.push(message),
    });
    expect(findings.map((item) => item.value)).toEqual(["group-readable-secret"]);
    expect(warnings).toEqual(["env file is readable by group or others"]);
    await chmod(path, 0o600);
    warnings.length = 0;
    await loadEnvFindings(root, {
      autoEnvFiles: true,
      envFiles: [],
      minValueLength: 8,
      strict: true,
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
  });

  it("rejects a symlink that resolves outside the worktree", async () => {
    const root = await fixture();
    const outside = await fixture();
    const target = join(outside, ".env");
    await writeFile(target, "TOKEN=outside-secret-value\n");
    await symlink(target, join(root, "linked.env"));
    await expect(
      loadEnvFindings(root, {
        autoEnvFiles: false,
        envFiles: ["linked.env"],
        minValueLength: 8,
        strict: true,
      }),
    ).rejects.toBeInstanceOf(PluginConfigError);
  });
});
