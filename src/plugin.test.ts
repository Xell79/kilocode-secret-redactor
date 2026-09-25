import { describe, expect, it, vi } from "vitest";
import { createServer } from "./plugin.js";
import type { SecretScanner } from "./secret-scanner.js";

const github = "ghp_R8z3kL9mN2pQ5tV7wX0yB4dF6hJ1oS3uA8cE";

function client() {
  return { app: { log: vi.fn().mockResolvedValue({}) } };
}

function scanner(): SecretScanner {
  return { version: "1.8.1", scan: vi.fn(async () => []) };
}

async function hooks(options: Record<string, unknown> = {}) {
  const app = client();
  const server = createServer({
    resolveScanner: async () => "/bin/betterleaks",
    createScanner: async () => scanner(),
    loadEnv: async () => [],
    worktree: "/tmp",
    configPath: new URL("../secret-redactor.default.json", import.meta.url).pathname,
  });
  const loaded = await server(
    {
      client: app,
      directory: "/tmp",
      worktree: "/tmp",
      serverUrl: new URL("http://localhost"),
      options: {},
    } as never,
    options,
  );
  return { hooks: loaded, app };
}

describe("kilocode plugin", () => {
  it("exports the canonical descriptor", async () => {
    const plugin = (await import("./plugin.js")).default;
    expect(plugin.id).toBe("kilocode-secret-redactor");
    expect(plugin.server).toBeTypeOf("function");
  });

  it("redacts chat text and restores only approved tool args and final text", async () => {
    const { hooks: loaded, app } = await hooks();
    const parts = [
      { type: "text", text: `token ${github}` },
      { type: "file", url: "data:" },
    ];
    await loaded["chat.message"]?.({ sessionID: "s1" } as never, { parts } as never);
    expect(parts[0].text).toMatch(/^token 🔒github_pat_\d+🔓$/);
    expect(parts[1]).not.toHaveProperty("text");
    expect(app.app.log).toHaveBeenCalled();

    const args = { command: parts[0].text ?? "" };
    await loaded["tool.execute.before"]?.(
      { sessionID: "s1", tool: "bash" } as never,
      { args } as never,
    );
    expect(args.command).toBe(`token ${github}`);

    const web = { url: parts[0].text };
    await loaded["tool.execute.before"]?.(
      { sessionID: "s1", tool: "webfetch" } as never,
      { args: web } as never,
    );
    expect(web.url).toBe(parts[0].text);

    const finalText = { text: parts[0].text ?? "" };
    await loaded["experimental.text.complete"]?.({ sessionID: "s1" } as never, finalText as never);
    expect(finalText.text).toBe(`token ${github}`);
  });

  it("redacts every tool output and outbound history", async () => {
    const { hooks: loaded } = await hooks();
    const output = { output: github };
    await loaded["tool.execute.after"]?.(
      { sessionID: "s1", tool: "glob" } as never,
      output as never,
    );
    expect(output.output).toMatch(/^🔒github_pat_\d+🔓$/);

    const messages = [{ info: { sessionID: "s1" }, parts: [{ type: "text", text: github }] }];
    await loaded["experimental.chat.messages.transform"]?.({} as never, { messages } as never);
    expect(messages[0].parts[0].text).toMatch(/^🔒github_pat_\d+🔓$/);
  });

  it("does not restore a token from another session", async () => {
    const { hooks: loaded } = await hooks();
    const parts = [{ type: "text", text: github }];
    await loaded["chat.message"]?.({ sessionID: "s1" } as never, { parts } as never);
    const args = { command: parts[0].text };
    await loaded["tool.execute.before"]?.(
      { sessionID: "s2", tool: "bash" } as never,
      { args } as never,
    );
    expect(args.command).toBe(parts[0].text);
  });

  it("adds the placeholder instruction once", async () => {
    const { hooks: loaded } = await hooks();
    const output = { system: ["base"] };
    const hook = loaded["experimental.chat.system.transform"];
    await hook?.({} as never, output as never);
    await hook?.({} as never, output as never);
    expect(output.system.filter((line) => line.includes("opaque local tokens"))).toHaveLength(1);
  });

  it("clears mappings when a session is deleted and when the plugin is disposed", async () => {
    const { hooks: loaded } = await hooks();
    const parts = [{ type: "text", text: github }];
    await loaded["chat.message"]?.({ sessionID: "s1" } as never, { parts } as never);
    const token = parts[0].text ?? "";
    await loaded.event?.({
      event: { type: "session.deleted", properties: { info: { id: "s1" } } },
    } as never);
    const args = { command: token };
    await loaded["tool.execute.before"]?.(
      { sessionID: "s1", tool: "bash" } as never,
      { args } as never,
    );
    expect(args.command).toBe(token);

    const again = [{ type: "text", text: github }];
    await loaded["chat.message"]?.({ sessionID: "s2" } as never, { parts: again } as never);
    await loaded.dispose?.();
    const disposed = { text: again[0].text ?? "" };
    await loaded["experimental.text.complete"]?.({ sessionID: "s2" } as never, disposed as never);
    expect(disposed.text).toMatch(/^🔒/);
  });

  it("does not resolve or create a scanner when the mode is disabled", async () => {
    const resolveScanner = vi.fn(async () => "/bin/betterleaks");
    const createScanner = vi.fn(async () => scanner());
    const server = createServer({
      resolveScanner,
      createScanner,
      loadEnv: async () => [{ category: "env_token", value: "env-secret-value", source: "env" }],
      worktree: "/tmp",
      configPath: new URL("../secret-redactor.default.json", import.meta.url).pathname,
    });
    const loaded = await server(
      { client: client(), directory: "/tmp", worktree: "/tmp" } as never,
      { scannerMode: "disabled" },
    );
    expect(resolveScanner).not.toHaveBeenCalled();
    expect(createScanner).not.toHaveBeenCalled();
    const parts = [{ type: "text", text: "keep env-secret-value here" }];
    await loaded["chat.message"]?.({ sessionID: "s1" } as never, { parts } as never);
    expect(parts[0].text).toBe("keep 🔒env_token_1🔓 here");
  });

  it("keeps a whitelisted env value and still redacts another copy", async () => {
    const resolveScanner = vi.fn(async () => "/bin/betterleaks");
    const server = createServer({
      resolveScanner,
      createScanner: async () => scanner(),
      loadEnv: async () => [{ category: "env_token", value: "env-secret-value", source: "env" }],
      worktree: "/tmp",
      configPath: new URL("../secret-redactor.default.json", import.meta.url).pathname,
    });
    const loaded = await server(
      { client: client(), directory: "/tmp", worktree: "/tmp" } as never,
      {
        scannerMode: "disabled",
        whitelist: [
          {
            id: "allow_env",
            label: "allow_env",
            regex: "keep (env-secret-value)",
            flags: "",
            captureGroup: 1,
          },
        ],
      },
    );
    const parts = [{ type: "text", text: "keep env-secret-value and hide env-secret-value" }];
    await loaded["chat.message"]?.({ sessionID: "s1" } as never, { parts } as never);
    expect(parts[0].text).toBe("keep env-secret-value and hide 🔒env_token_1🔓");
    expect(resolveScanner).not.toHaveBeenCalled();
  });

  it("blocks startup when Betterleaks is required and unavailable", async () => {
    const server = createServer({
      resolveScanner: async () => {
        throw new Error("missing");
      },
      loadEnv: async () => [],
    });
    await expect(
      server({ client: client(), directory: "/tmp", worktree: "/tmp" } as never),
    ).rejects.toThrow(/Betterleaks is required/);
  });
});
