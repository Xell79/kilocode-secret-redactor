import { describe, expect, it, vi } from "vitest";
import { SecretRedactor } from "./plugin.js";

function createMockClient() {
  return {
    tui: {
      showToast: vi.fn().mockResolvedValue(true),
    },
  };
}

describe("SecretRedactor plugin", () => {
  it("initializes and returns hook handlers", async () => {
    const client = createMockClient();
    const hooks = await SecretRedactor({ client } as never);

    expect(hooks).toHaveProperty("tool.execute.before");
    expect(hooks).toHaveProperty("tool.execute.after");
  });

  it("redacts JWT in bash tool output", async () => {
    const client = createMockClient();
    const hooks = await SecretRedactor({ client } as never);
    const afterHook = hooks["tool.execute.after"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>,
    ) => Promise<void>;

    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const output = { output: `token: ${jwt}` };

    await afterHook({ tool: "bash" }, output);

    expect(output.output).toBe("token: <<REDACTED:jwt_1>>");
  });

  it("fires a toast when secrets are redacted", async () => {
    const client = createMockClient();
    const hooks = await SecretRedactor({ client } as never);
    const afterHook = hooks["tool.execute.after"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>,
    ) => Promise<void>;

    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    await afterHook({ tool: "bash" }, { output: jwt });

    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: {
        message: expect.stringContaining("Redacted 1 secret(s)"),
        variant: "warning",
      },
    });
  });

  it("unredacts tokens in bash tool args before execution", async () => {
    const client = createMockClient();
    const hooks = await SecretRedactor({ client } as never);
    const afterHook = hooks["tool.execute.after"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>,
    ) => Promise<void>;
    const beforeHook = hooks["tool.execute.before"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>,
    ) => Promise<void>;

    // First redact a JWT
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    await afterHook({ tool: "bash" }, { output: jwt });

    // Then use the redacted token in a command
    const args = { command: "curl -H 'Bearer <<REDACTED:jwt_1>>'" };
    await beforeHook({ tool: "bash" }, { args });

    expect(args.command).toBe(`curl -H 'Bearer ${jwt}'`);
  });

  it("skips tools not in scope", async () => {
    const client = createMockClient();
    const hooks = await SecretRedactor({ client } as never);
    const afterHook = hooks["tool.execute.after"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>,
    ) => Promise<void>;

    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const output = { output: jwt };

    await afterHook({ tool: "glob" }, output);

    // Should not be redacted since glob is not in scope
    expect(output.output).toBe(jwt);
  });

  it("handles null/undefined output gracefully", async () => {
    const client = createMockClient();
    const hooks = await SecretRedactor({ client } as never);
    const afterHook = hooks["tool.execute.after"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>,
    ) => Promise<void>;

    await afterHook({ tool: "bash" }, { output: undefined });
    await afterHook({ tool: "bash" }, { output: null });

    // Should not throw
    expect(client.tui.showToast).not.toHaveBeenCalled();
  });
});
