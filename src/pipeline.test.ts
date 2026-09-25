import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MAX_REGEX_LENGTH, matcherFor, PatternConfigError, parseRule } from "./patterns.js";
import { redactString, type ScanContext } from "./redactor.js";
import type { SecretScanner } from "./secret-scanner.js";
import { kiloConfigDir, loadUserConfig } from "./user-config.js";
import { createVault } from "./vault.js";

const email = {
  id: "email",
  label: "email",
  regex: String.raw`[a-z.]+@[a-z]+\.[a-z]+`,
  flags: "",
  captureGroup: 0,
};
const allowExample = {
  id: "example_mail",
  label: "example_mail",
  regex: String.raw`[a-z.]+@example\.com`,
  flags: "",
  captureGroup: 0,
};

function context(overrides: Partial<ScanContext> = {}): ScanContext {
  return {
    order: ["whitelist", "blacklist", "betterleaks"],
    whitelist: [allowExample],
    blacklist: [email],
    envValues: [],
    disabledTypes: new Set(),
    disabledScannerRules: new Set(),
    minValueLength: 8,
    cache: new Map(),
    cacheLimit: 4,
    mode: "required",
    warn: vi.fn(),
    ...overrides,
  };
}

describe("stage order", () => {
  it("keeps a whitelisted span and redacts another match of the same shape", async () => {
    const result = await redactString(
      "keep jane.doe@example.com and hide jane.doe@corp.test",
      createVault(),
      context(),
    );
    expect(result.text).toContain("jane.doe@example.com");
    expect(result.text).not.toContain("jane.doe@corp.test");
    expect(result.text).toMatch(/🔒email_1🔓/);
  });

  it("lets an earlier blacklist stage beat a later whitelist overlap", async () => {
    const result = await redactString(
      "hide jane.doe@example.com",
      createVault(),
      context({ order: ["blacklist", "whitelist", "betterleaks"] }),
    );
    expect(result.text).toBe("hide 🔒email_1🔓");
  });

  it("masks earlier spans before Betterleaks sees the text", async () => {
    const scan = vi.fn(async (text: string) => {
      expect(text).not.toContain("jane.doe@example.com");
      expect(text).not.toContain("ghp_R8z3kL9mN2pQ5tV7wX0yB4dF6hJ1oS3uA8cE");
      return [
        {
          category: "slack-token",
          value: "xoxb-other-secret-value",
          source: "betterleaks" as const,
        },
      ];
    });
    const scanner: SecretScanner = { version: "1.8.1", scan };
    const text =
      "keep jane.doe@example.com token ghp_R8z3kL9mN2pQ5tV7wX0yB4dF6hJ1oS3uA8cE tail xoxb-other-secret-value";
    const result = await redactString(
      text,
      createVault(),
      context({
        scanner,
        blacklist: [
          email,
          {
            id: "github_pat",
            label: "github_pat",
            regex: "ghp_[A-Za-z0-9]{36,}",
            flags: "",
            captureGroup: 0,
          },
        ],
      }),
    );
    expect(scan).toHaveBeenCalledOnce();
    expect(result.text).toContain("jane.doe@example.com");
    expect(result.text).toContain("🔒github_pat_1🔓");
    expect(result.text).toContain("🔒slack_token_1🔓");
  });

  it("redacts two copies of one value and only the captured group", async () => {
    const result = await redactString(
      "one same-value-secret and two same-value-secret",
      createVault(),
      context({
        whitelist: [],
        blacklist: [
          {
            id: "pair",
            label: "pair",
            regex: "same-value-secret",
            flags: "",
            captureGroup: 0,
          },
        ],
      }),
    );
    expect(result.text).toBe("one 🔒pair_1🔓 and two 🔒pair_1🔓");
    const captured = await redactString(
      "keep token=captured-secret tail",
      createVault(),
      context({
        whitelist: [],
        blacklist: [
          {
            id: "pair",
            label: "pair",
            regex: "token=([A-Za-z-]{8,})",
            flags: "",
            captureGroup: 1,
          },
        ],
      }),
    );
    expect(captured.text).toBe("keep token=🔒pair_1🔓 tail");
  });

  it("matches across a newline and does not split lines", async () => {
    const result = await redactString(
      "alpha\nbeta@example.org",
      createVault(),
      context({
        whitelist: [],
        blacklist: [
          {
            id: "cross",
            label: "cross",
            regex: "alpha\\s+beta@example\\.org",
            flags: "",
            captureGroup: 0,
          },
        ],
      }),
    );
    expect(result.text).toBe("🔒cross_1🔓");
  });

  it("keeps one copy and redacts another identical copy", async () => {
    const result = await redactString(
      "allow public-token-value and hide public-token-value",
      createVault(),
      context({
        whitelist: [
          {
            id: "first_only",
            label: "first_only",
            regex: "^allow (public-token-value)",
            flags: "",
            captureGroup: 1,
          },
        ],
        blacklist: [
          {
            id: "token",
            label: "token",
            regex: "public-token-value",
            flags: "",
            captureGroup: 0,
          },
        ],
      }),
    );
    expect(result.text).toBe("allow public-token-value and hide 🔒token_1🔓");
  });

  it("keeps a non-overlapping later finding", async () => {
    const scan = vi.fn(async () => [
      { category: "slack-token", value: "xoxb-later-secret-value", source: "betterleaks" as const },
    ]);
    const result = await redactString(
      "keep jane.doe@example.com then xoxb-later-secret-value",
      createVault(),
      context({ scanner: { version: "1.8.1", scan } }),
    );
    expect(result.text).toContain("jane.doe@example.com");
    expect(result.text).toContain("🔒slack_token_1🔓");
    const seen = scan.mock.calls[0]?.[0] ?? "";
    expect(seen.indexOf("xoxb-later-secret-value")).toBe(
      "keep jane.doe@example.com then xoxb-later-secret-value".indexOf("xoxb-later-secret-value"),
    );
  });

  it("changes the scan cache key when masked text or rule settings change", async () => {
    const scan = vi.fn(async () => []);
    const cache = new Map();
    const scanner = { version: "1.8.1", scan };
    await redactString("plain text value", createVault(), context({ scanner, cache }));
    await redactString("plain text value", createVault(), context({ scanner, cache }));
    await redactString(
      "plain text value",
      createVault(),
      context({ scanner, cache, disabledScannerRules: new Set(["generic-api-key"]) }),
    );
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("aborts a required scan when a finding is only inside an occupied span", async () => {
    await expect(
      redactString(
        "keep jane.doe@example.com",
        createVault(),
        context({
          scanner: {
            version: "1.8.1",
            scan: async () => [
              { category: "email", value: "jane.doe@example.com", source: "betterleaks" },
            ],
          },
        }),
      ),
    ).rejects.toThrow(/could not be mapped/);
  });
});

describe("user config", () => {
  it("resolves the kilo config directory and falls back when the user file is missing", async () => {
    expect(kiloConfigDir({ KILO_CONFIG_DIR: "/tmp/kilo-a" })).toBe("/tmp/kilo-a");
    expect(kiloConfigDir({ XDG_CONFIG_HOME: "/tmp/xdg" })).toBe("/tmp/xdg/kilo");
    const missing = join(tmpdir(), "missing-secret-redactor-dir");
    const loaded = await loadUserConfig(undefined, {
      env: { KILO_CONFIG_DIR: missing },
      read: async () => {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
    });
    expect(loaded.blacklist.some((rule) => rule.id === "gitlab_pat")).toBe(true);
  });

  it("rejects malformed explicit config, duplicates, flags, groups, and order", async () => {
    const base = {
      order: ["whitelist", "blacklist", "betterleaks"],
      whitelist: [],
      blacklist: [email],
    };
    await expect(
      loadUserConfig(undefined, { configPath: "/cfg", read: async () => "{" }),
    ).rejects.toThrow(/invalid/);
    await expect(
      loadUserConfig(undefined, {
        configPath: "/cfg",
        read: async () => JSON.stringify({ ...base, blacklist: [email, email] }),
      }),
    ).rejects.toThrow(/invalid/);
    expect(() => parseRule({ ...email, flags: "g" }, 0)).toThrow(PatternConfigError);
    expect(() => parseRule({ ...email, captureGroup: 3 }, 0)).toThrow(/capture group/);
    expect(() => parseRule({ ...email, extra: true }, 0)).toThrow(/unknown field/);
    expect(() => parseRule({ ...email, regex: "a".repeat(MAX_REGEX_LENGTH + 1) }, 0)).toThrow(
      /invalid regular expression/,
    );
    await expect(
      loadUserConfig(undefined, {
        configPath: "/cfg",
        read: async () => JSON.stringify({ ...base, order: ["whitelist", "blacklist"] }),
      }),
    ).rejects.toThrow(/invalid/);
    await expect(
      loadUserConfig(undefined, {
        configPath: "/cfg",
        read: async () =>
          JSON.stringify({
            ...base,
            blacklist: Array.from({ length: 501 }, (_, index) => ({
              ...email,
              id: `rule_${index}`,
            })),
          }),
      }),
    ).rejects.toThrow(/invalid/);
  });

  it("lets tuple options override the user file", async () => {
    const loaded = await loadUserConfig(
      { scannerMode: "optional", order: ["betterleaks", "blacklist", "whitelist"] },
      {
        configPath: "/cfg",
        read: async () =>
          JSON.stringify({
            scannerMode: "required",
            order: ["whitelist", "blacklist", "betterleaks"],
            whitelist: [],
            blacklist: [email],
          }),
      },
    );
    expect(loaded.scannerMode).toBe("optional");
    expect(loaded.order).toEqual(["betterleaks", "blacklist", "whitelist"]);
    const rules = await loadUserConfig(
      { whitelist: [allowExample] },
      {
        configPath: "/cfg",
        read: async () =>
          JSON.stringify({
            order: ["whitelist", "blacklist", "betterleaks"],
            whitelist: [],
            blacklist: [email],
          }),
      },
    );
    expect(rules.whitelist.map((rule) => rule.id)).toEqual(["example_mail"]);
    expect(rules.blacklist.map((rule) => rule.id)).toEqual(["email"]);
  });

  it("reuses a compiled matcher for the same parsed rule object", () => {
    const rule = parseRule(email, 0);
    const first = matcherFor(rule);
    first.lastIndex = 4;
    const second = matcherFor(rule);
    expect(second).toBe(first);
    expect(second.lastIndex).toBe(4);
    const edited = parseRule({ ...email, id: "email_copy" }, 0);
    expect(matcherFor(edited)).not.toBe(first);
  });

  it("uses the user file without rebuilding and rejects a bad regex", async () => {
    const dir = await mkdtemp(join(tmpdir(), "redactor-config-"));
    const path = join(dir, "secret-redactor.json");
    await writeFile(
      path,
      JSON.stringify({
        order: ["whitelist", "blacklist", "betterleaks"],
        whitelist: [allowExample],
        blacklist: [email],
      }),
    );
    const loaded = await loadUserConfig(undefined, { configPath: path });
    expect(loaded.whitelist[0]?.id).toBe("example_mail");
    await expect(
      loadUserConfig(undefined, {
        configPath: path,
        read: async () => "{",
      }),
    ).rejects.toThrow(/invalid/);
  });
});
