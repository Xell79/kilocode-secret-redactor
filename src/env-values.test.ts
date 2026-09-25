import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PluginConfigError } from "./config.js";
import { loadEnvFindings } from "./env-values.js";

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
