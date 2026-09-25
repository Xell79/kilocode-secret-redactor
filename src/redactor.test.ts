import { describe, expect, it, vi } from "vitest";
import { redactDeep, redactString, type ScanContext, unredactDeep } from "./redactor.js";
import type { SecretScanner } from "./secret-scanner.js";
import { createVault } from "./vault.js";

function context(scanner: SecretScanner, mode: "required" | "optional" = "required"): ScanContext {
  return {
    scanner,
    order: ["whitelist", "blacklist", "betterleaks"],
    whitelist: [],
    blacklist: [
      {
        id: "email",
        label: "email",
        regex: String.raw`(?<![:/])[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}`,
        flags: "",
        captureGroup: 0,
      },
    ],
    envValues: [],
    disabledTypes: new Set(["url", "ip_address", "ssh_public_key"]),
    disabledScannerRules: new Set(),
    minValueLength: 8,
    cache: new Map(),
    cacheLimit: 8,
    mode,
    warn: vi.fn(),
  };
}

describe("redactString", () => {
  it("detects and redacts a JWT in text", async () => {
    const vault = createVault();
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = await redactString(`token: ${jwt}`, vault);

    expect(result.text).toBe("token: 🔒jwt_1🔓");
    expect(result.labels).toContain("🔒jwt_1🔓");
  });

  it("redacts pre-stored secrets before pattern detection", async () => {
    const vault = createVault();
    vault.store("my_secret", "custom-secret-value");

    const result = await redactString("using custom-secret-value here", vault);

    expect(result.text).toBe("using 🔒my_secret_1🔓 here");
  });
});

describe("redactDeep", () => {
  it("redacts secrets in nested objects", async () => {
    const vault = createVault();
    const input = {
      stdout: "token: glpat-xyzABCDEFGH12345678901234",
      nested: { deep: "ghp_1234567890abcdefghijklmnopqrstuvwxyz1234" },
    };

    const result = await redactDeep(input, vault);
    const output = result.value as Record<string, unknown>;

    expect(output.stdout).toBe("token: 🔒gitlab_pat_1🔓");
    expect((output.nested as Record<string, unknown>).deep).toBe("🔒github_pat_1🔓");
    expect(result.labels).toHaveLength(2);
  });

  it("redacts secrets in arrays", async () => {
    const vault = createVault();
    const input = ["glpat-xyzABCDEFGH12345678901234", "no secret here"];

    const result = await redactDeep(input, vault);
    const output = result.value as string[];

    expect(output[0]).toBe("🔒gitlab_pat_1🔓");
    expect(output[1]).toBe("no secret here");
  });

  it("passes through non-string primitives unchanged", async () => {
    const vault = createVault();
    const input = { count: 42, active: true, empty: null };

    const result = await redactDeep(input, vault);

    expect(result.value).toEqual(input);
    expect(result.labels).toHaveLength(0);
  });
});

describe("unredactDeep", () => {
  it("restores redacted tokens to real values", () => {
    const vault = createVault();
    const secret = "glpat-xyzABCDEFGH12345678901234";
    vault.store("gitlab_pat", secret);

    const result = unredactDeep("🔒gitlab_pat_1🔓", vault);

    expect(result).toBe(secret);
  });

  it("restores nested redacted objects", () => {
    const vault = createVault();
    const token = vault.store("tok", "real-value");

    const input = { cmd: `curl ${token}`, meta: { x: token } };
    const result = unredactDeep(input, vault) as Record<string, unknown>;

    expect(result.cmd).toBe("curl real-value");
    expect((result.meta as Record<string, unknown>).x).toBe("real-value");
  });
});

describe("round-trip", () => {
  it("redact then unredact produces original input", async () => {
    const vault = createVault();
    const original = {
      stdout: "ya29.a0ARrdaM8abc123def456ghi789jkl012mno345pqr678stu901vwx234yz",
      stderr: "using glpat-xyzABCDEFGH12345678901234 for auth",
    };

    const redacted = await redactDeep(original, vault);
    const restored = unredactDeep(redacted.value, vault);

    expect(restored).toEqual(original);
  });
});

describe("scanner integration", () => {
  it("merges a Betterleaks finding ahead of a generic builtin label", async () => {
    const scanner: SecretScanner = {
      version: "1.8.1",
      scan: vi.fn(async () => [
        { category: "github-pat", value: "ghp_from_scanner_value", source: "betterleaks" as const },
      ]),
    };
    const result = await redactString(
      "token ghp_from_scanner_value",
      createVault(),
      context(scanner),
    );
    expect(result.text).toBe("token 🔒github_pat_1🔓");
  });

  it("continues after scanner failure only in optional mode", async () => {
    const scanner: SecretScanner = {
      version: "1.8.1",
      scan: vi.fn(async () => {
        throw new Error("scanner down");
      }),
    };
    const text = "contact jane.doe@example.com please";
    await expect(redactString(text, createVault(), context(scanner, "required"))).rejects.toThrow(
      "scanner down",
    );
    const optional = await redactString(text, createVault(), context(scanner, "optional"));
    expect(optional.text).toBe("contact 🔒email_1🔓 please");
  });

  it("does not cache an optional scanner failure", async () => {
    let calls = 0;
    const scanner: SecretScanner = {
      version: "1.8.1",
      scan: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("scanner down");
        return [
          { category: "slack-token", value: "xoxb-retry-secret", source: "betterleaks" as const },
        ];
      }),
    };
    const shared = context(scanner, "optional");
    const first = await redactString("contact jane.doe@example.com", createVault(), shared);
    expect(first.text).toBe("contact 🔒email_1🔓");
    const second = await redactString("token xoxb-retry-secret", createVault(), shared);
    expect(second.text).toBe("token 🔒slack_token_1🔓");
    expect(scanner.scan).toHaveBeenCalledTimes(2);
  });
});
