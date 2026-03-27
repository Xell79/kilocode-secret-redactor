import { describe, expect, it } from "vitest";
import { redactDeep, redactString, unredactDeep } from "./redactor.js";
import { createVault } from "./vault.js";

describe("redactString", () => {
  it("detects and redacts a JWT in text", () => {
    const vault = createVault();
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = redactString(`token: ${jwt}`, vault);

    expect(result.text).toBe("token: <<REDACTED:jwt_1>>");
    expect(result.labels).toContain("jwt_1");
  });

  it("redacts pre-stored secrets before pattern detection", () => {
    const vault = createVault();
    vault.store("my_secret", "custom-secret-value");

    const result = redactString("using custom-secret-value here", vault);

    expect(result.text).toBe("using <<REDACTED:my_secret>> here");
  });
});

describe("redactDeep", () => {
  it("redacts secrets in nested objects", () => {
    const vault = createVault();
    const input = {
      stdout: "token: glpat-xyzABCDEFGH12345678901234",
      nested: { deep: "ghp_1234567890abcdefghijklmnopqrstuvwxyz1234" },
    };

    const result = redactDeep(input, vault);
    const output = result.value as Record<string, unknown>;

    expect(output.stdout).toBe("token: <<REDACTED:gitlab_pat_1>>");
    expect((output.nested as Record<string, unknown>).deep).toBe("<<REDACTED:github_pat_1>>");
    expect(result.labels).toHaveLength(2);
  });

  it("redacts secrets in arrays", () => {
    const vault = createVault();
    const input = ["glpat-xyzABCDEFGH12345678901234", "no secret here"];

    const result = redactDeep(input, vault);
    const output = result.value as string[];

    expect(output[0]).toBe("<<REDACTED:gitlab_pat_1>>");
    expect(output[1]).toBe("no secret here");
  });

  it("passes through non-string primitives unchanged", () => {
    const vault = createVault();
    const input = { count: 42, active: true, empty: null };

    const result = redactDeep(input, vault);

    expect(result.value).toEqual(input);
    expect(result.labels).toHaveLength(0);
  });
});

describe("unredactDeep", () => {
  it("restores redacted tokens to real values", () => {
    const vault = createVault();
    const secret = "glpat-xyzABCDEFGH12345678901234";
    vault.store("gitlab_pat_1", secret);

    const result = unredactDeep("<<REDACTED:gitlab_pat_1>>", vault);

    expect(result).toBe(secret);
  });

  it("restores nested redacted objects", () => {
    const vault = createVault();
    vault.store("tok", "real-value");

    const input = { cmd: "curl <<REDACTED:tok>>", meta: { x: "<<REDACTED:tok>>" } };
    const result = unredactDeep(input, vault) as Record<string, unknown>;

    expect(result.cmd).toBe("curl real-value");
    expect((result.meta as Record<string, unknown>).x).toBe("real-value");
  });
});

describe("round-trip", () => {
  it("redact then unredact produces original input", () => {
    const vault = createVault();
    const original = {
      stdout: "ya29.a0ARrdaM8abc123def456ghi789jkl012mno345pqr678stu901vwx234yz",
      stderr: "using glpat-xyzABCDEFGH12345678901234 for auth",
    };

    const redacted = redactDeep(original, vault);
    const restored = unredactDeep(redacted.value, vault);

    expect(restored).toEqual(original);
  });
});
