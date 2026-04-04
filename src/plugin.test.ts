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

    expect(hooks).toHaveProperty("chat.message");
    expect(hooks).toHaveProperty("tool.execute.before");
    expect(hooks).toHaveProperty("tool.execute.after");
  });

  it("redacts secrets in user chat message text parts", async () => {
    const client = createMockClient();
    const hooks = await SecretRedactor({ client } as never);
    const chatHook = hooks["chat.message"] as (
      input: Record<string, unknown>,
      output: { parts: Array<{ type: string; text?: string }> },
    ) => Promise<void>;

    const parts = [
      { type: "text", text: "my token is ghp_R8z3kL9mN2pQ5tV7wX0yB4dF6hJ1oS3uA8cE" },
      { type: "file", mime: "image/png", url: "data:..." },
    ];

    await chatHook({}, { parts } as never);

    expect(parts[0].text).toMatch(/^my token is <<REDACTED:github_pat_\d+>>$/);
    expect(parts[1]).not.toHaveProperty("text");
  });

  it("fires a toast when secrets are redacted in chat messages", async () => {
    const client = createMockClient();
    const hooks = await SecretRedactor({ client } as never);
    const chatHook = hooks["chat.message"] as (
      input: Record<string, unknown>,
      output: { parts: Array<{ type: string; text?: string }> },
    ) => Promise<void>;

    const parts = [{ type: "text", text: "my token is ghp_R8z3kL9mN2pQ5tV7wX0yB4dF6hJ1oS3uA8cE" }];

    await chatHook({}, { parts } as never);

    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: {
        message: expect.stringContaining("Redacted 1 secret(s) from chat"),
        variant: "warning",
      },
    });
  });

  it("redacts JWT in bash tool output", async () => {
    const client = createMockClient();
    const hooks = await SecretRedactor({ client } as never);
    const afterHook = hooks["tool.execute.after"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>,
    ) => Promise<void>;

    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyIjoiZmFrZSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const output = { output: `token: ${jwt}` };

    await afterHook({ tool: "bash" }, output);

    expect(output.output).toMatch(/^token: <<REDACTED:jwt_\d+>>$/);
  });

  it("fires a toast when secrets are redacted in tool output", async () => {
    const client = createMockClient();
    const hooks = await SecretRedactor({ client } as never);
    const afterHook = hooks["tool.execute.after"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>,
    ) => Promise<void>;

    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyIjoiZmFrZSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    await afterHook({ tool: "bash" }, { output: jwt });

    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: {
        message: expect.stringContaining("Redacted 1 secret(s) from bash"),
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

    // First redact a JWT via tool output
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyIjoiZmFrZSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
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
    const client = createMockClient();
    const hooks = await SecretRedactor({ client } as never);
    const afterHook = hooks["tool.execute.after"] as (
      input: Record<string, unknown>,
      output: Record<string, unknown>,
    ) => Promise<void>;

    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyIjoiZmFrZSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const output = { output: jwt };

    await afterHook({ tool: "glob" }, output);

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
