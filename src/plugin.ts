import type { Plugin } from "@opencode-ai/plugin";
import { REDACT_OUTPUT_TOOLS, UNREDACT_ARGS_TOOLS } from "./config.js";
import { redactDeep, unredactDeep } from "./redactor.js";
import { createVault } from "./vault.js";

interface ToastClient {
  tui: {
    showToast: (opts: { body: { message: string; variant: string } }) => Promise<unknown>;
  };
}

function toast(client: ToastClient, message: string, variant: string): void {
  client.tui.showToast({ body: { message, variant } }).catch(() => {});
}

function isToolInScope(tool: string, tools: ReadonlyArray<string>): boolean {
  return tools.includes(tool);
}

function uniqueTypes(labels: ReadonlyArray<string>): string[] {
  const types = new Set<string>();
  for (const label of labels) {
    types.add(label.replace(/_\d+$/, ""));
  }
  return Array.from(types);
}

export const SecretRedactor: Plugin = async ({ client }) => {
  const vault = createVault();

  return {
    "tool.execute.before": async (input, output) => {
      if (!isToolInScope(input.tool, UNREDACT_ARGS_TOOLS)) return;

      for (const key of Object.keys(output.args)) {
        output.args[key] = unredactDeep(output.args[key], vault);
      }
    },

    "tool.execute.after": async (input, output) => {
      if (!isToolInScope(input.tool, REDACT_OUTPUT_TOOLS)) return;
      if (output.output === undefined || output.output === null) return;

      const result = redactDeep(output.output, vault);
      output.output = result.value as string;

      if (result.labels.length > 0) {
        const count = result.labels.length;
        const types = uniqueTypes(result.labels);
        toast(
          client as unknown as ToastClient,
          `Redacted ${count} secret(s) from ${input.tool}: ${types.join(", ")}`,
          "warning",
        );
      }
    },
  };
};
