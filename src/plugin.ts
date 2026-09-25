import type { Hooks, PluginModule } from "@kilocode/plugin";
import { PLACEHOLDER_INSTRUCTION, PluginConfigError } from "./config.js";
import { loadEnvFindings } from "./env-values.js";
import type { RedactResult } from "./redactor.js";
import {
  createBetterleaksScanner,
  resolveBetterleaks,
  type SecretScanner,
} from "./secret-scanner.js";
import { loadUserConfig } from "./user-config.js";
import { createVault, type SecretVault } from "./vault.js";

interface TextPart {
  type: string;
  text?: string;
}

interface SessionState {
  vault: SecretVault;
  cache: Map<string, import("./findings.js").Finding[]>;
  warned: boolean;
}

export interface ServerOptions {
  resolveScanner?: (path: string | undefined) => Promise<string>;
  createScanner?: (executable: string, timeoutMs: number) => Promise<SecretScanner>;
  loadEnv?: typeof loadEnvFindings;
  worktree?: string;
  configPath?: string;
}

function isTextPart(part: unknown): part is TextPart & { text: string } {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as TextPart).type === "text" &&
    typeof (part as TextPart).text === "string"
  );
}

function log(client: PluginInputClient, message: string): void {
  void client.app
    .log({ body: { service: "kilocode-secret-redactor", level: "warn", message } })
    .catch(() => {});
}

type PluginInputClient = Parameters<PluginModule["server"]>[0]["client"];

export function createServer(serverOptions: ServerOptions = {}) {
  const server: PluginModule["server"] = async (input, rawOptions) => {
    const options = await loadUserConfig(rawOptions, { configPath: serverOptions.configPath });
    const worktree = serverOptions.worktree ?? input.directory;
    let scanner: SecretScanner | undefined;
    if (options.scannerMode !== "disabled")
      try {
        const executable = await (serverOptions.resolveScanner ?? resolveBetterleaks)(
          options.betterleaksPath,
        );
        scanner = await (serverOptions.createScanner ?? createBetterleaksScanner)(
          executable,
          options.scannerTimeoutMs,
        );
      } catch {
        if (options.scannerMode === "required") {
          throw new PluginConfigError("Betterleaks is required but unavailable");
        }
        log(input.client, "Betterleaks unavailable; continuing with built-in and env detection");
      }

    const envFindings = await (serverOptions.loadEnv ?? loadEnvFindings)(worktree, {
      autoEnvFiles: options.autoEnvFiles,
      envFiles: options.envFiles,
      minValueLength: options.minValueLength,
      strict: options.scannerMode === "required",
    });
    const sessions = new Map<string, SessionState>();
    const envValues = envFindings.map((finding) => ({
      category: finding.category,
      value: finding.value,
    }));

    const stateFor = (sessionID: string): SessionState => {
      const existing = sessions.get(sessionID);
      if (existing) return existing;
      const vault = createVault(options.maxMappings);
      const created = { vault, cache: new Map(), warned: false };
      sessions.set(sessionID, created);
      return created;
    };

    const contextFor = (sessionID: string) => {
      const state = stateFor(sessionID);
      return {
        scanner,
        order: options.order,
        whitelist: options.whitelist,
        blacklist: options.blacklist,
        envValues,
        disabledTypes: options.disabledTypes,
        disabledScannerRules: options.disabledScannerRules,
        minValueLength: options.minValueLength,
        cache: state.cache,
        cacheLimit: options.scanCacheSize,
        mode: options.scannerMode,
        warn(message: string) {
          if (state.warned) return;
          state.warned = true;
          log(input.client, message);
        },
      };
    };

    const redactParts = async (parts: TextPart[], sessionID: string): Promise<number> => {
      const { redactDeep } = await import("./redactor.js");
      const state = stateFor(sessionID);
      let count = 0;
      for (const part of parts) {
        if (!isTextPart(part)) continue;
        const result = await redactDeep(part.text, state.vault, contextFor(sessionID));
        part.text = result.value as string;
        count += result.labels.length;
      }
      return count;
    };

    const hooks: Hooks = {
      "chat.message": async (hookInput, output) => {
        const count = await redactParts(output.parts, hookInput.sessionID);
        if (count > 0) log(input.client, `Redacted ${count} value(s) from chat`);
      },
      "experimental.chat.messages.transform": async (_hookInput, output) => {
        let count = 0;
        for (const message of output.messages) {
          count += await redactParts(message.parts as TextPart[], message.info.sessionID);
        }
        if (count > 0) log(input.client, `Redacted ${count} value(s) from model context`);
      },
      "experimental.chat.system.transform": async (_hookInput, output) => {
        if (!output.system.includes(PLACEHOLDER_INSTRUCTION))
          output.system.push(PLACEHOLDER_INSTRUCTION);
      },
      "tool.execute.before": async (hookInput, output) => {
        if (!options.unredactTools.has(hookInput.tool)) return;
        const { unredactDeep } = await import("./redactor.js");
        const state = sessions.get(hookInput.sessionID);
        if (!state) return;
        for (const key of Object.keys(output.args)) {
          output.args[key] = unredactDeep(output.args[key], state.vault);
        }
      },
      "tool.execute.after": async (hookInput, output) => {
        if (output.output === undefined || output.output === null) return;
        const { redactDeep } = await import("./redactor.js");
        const state = stateFor(hookInput.sessionID);
        const result: RedactResult = await redactDeep(
          output.output,
          state.vault,
          contextFor(hookInput.sessionID),
        );
        output.output = result.value as string;
        if (result.labels.length > 0) {
          log(input.client, `Redacted ${result.labels.length} value(s) from tool output`);
        }
      },
      "experimental.text.complete": async (hookInput, output) => {
        const state = sessions.get(hookInput.sessionID);
        if (!state) return;
        output.text = state.vault.unscrubText(output.text);
      },
      event: async ({ event }) => {
        if (event.type === "session.deleted") clearSession(event.properties.info.id);
      },
      dispose: async () => {
        for (const sessionID of [...sessions.keys()]) clearSession(sessionID);
      },
    };

    function clearSession(sessionID: string): void {
      const state = sessions.get(sessionID);
      state?.vault.clear();
      state?.cache.clear();
      sessions.delete(sessionID);
    }
    return hooks;
  };
  return server;
}

export const server = createServer();

const plugin: PluginModule = {
  id: "kilocode-secret-redactor",
  server,
};

export default plugin;
