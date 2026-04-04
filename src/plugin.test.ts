import { describe, expect, it } from "vitest";
import { SecretRedactor } from "./plugin.js";

describe("SecretRedactor plugin", () => {
  it("initializes and returns hook handlers", async () => {
    const hooks = await SecretRedactor({} as never);

    expect(hooks).toHaveProperty("chat.message");
    expect(hooks).toHaveProperty("tool.execute.before");
    expect(hooks).toHaveProperty("tool.execute.after");
  });

  it("redacts secrets in user chat message text parts", async () => {
    const hooks = await SecretRedactor({} as never);
    const chatHook = hooks["chat.message"] as (
      input: Record<string, unknown>,
      output: { parts: Array<{ type: string; text?: string }> },
    ) => Promise<void>;

    const parts = [
      { type: "text", text: "my token is ghp_abc123def456ghi789jkl012mno345pqr678" },
      { type: "file", mime: "image/png", url: "data:..." },
    ];

    await chatHook({}, { parts } as never);

    expect(parts[0].text).toMatch(/^my token is <<REDACTED:github_pat_\d+>>$/);
    // Non-text parts are untouched
    expect(parts[1]).not.toHaveProperty("text");
  });

  it("redacts JWT in bash tool output", async () => {
    const hooks = await SecretRedactor({} as never);
    const afterHook = hooks["tool.execute.after"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>,
    ) => Promise<void>;

    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const output = { output: `token: ${jwt}` };

    await afterHook({ tool: "bash" }, output);

    expect(output.output).toMatch(/^token: <<REDACTED:jwt_\d+>>$/);
  });

  it("unredacts tokens in bash tool args before execution", async () => {
    const hooks = await SecretRedactor({} as never);
    const afterHook = hooks["tool.execute.after"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>,
    ) => Promise<void>;
    const beforeHook = hooks["tool.execute.before"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>,
    ) => Promise<void>;

    // First redact a JWT via tool output
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const toolOutput = { output: jwt };
    await afterHook({ tool: "bash" }, toolOutput);

    // Extract the redacted label
    const redactedToken = toolOutput.output as string;

    // Then use the redacted token in a command
    const args = { command: `curl -H 'Bearer ${redactedToken}'` };
    await beforeHook({ tool: "bash" }, { args });

    expect(args.command).toBe(`curl -H 'Bearer ${jwt}'`);
  });

  it("skips tools not in scope", async () => {
    const hooks = await SecretRedactor({} as never);
    const afterHook = hooks["tool.execute.after"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>,
    ) => Promise<void>;

    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const output = { output: jwt };

    await afterHook({ tool: "glob" }, output);

    expect(output.output).toBe(jwt);
  });

  it("handles null/undefined output gracefully", async () => {
    const hooks = await SecretRedactor({} as never);
    const afterHook = hooks["tool.execute.after"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>,
    ) => Promise<void>;

    await afterHook({ tool: "bash" }, { output: undefined });
    await afterHook({ tool: "bash" }, { output: null });
    // Should not throw
  });
});
