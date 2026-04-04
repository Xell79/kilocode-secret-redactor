import type { Plugin } from "@opencode-ai/plugin";

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

// Named export for programmatic consumers
export const SecretRedactor: Plugin = async ({ client }) => {
  const [
    { REDACT_OUTPUT_TOOLS, UNREDACT_ARGS_TOOLS },
    { redactDeep, unredactDeep },
    { createVault },
  ] = await Promise.all([import("./config.js"), import("./redactor.js"), import("./vault.js")]);

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

// OpenCode resolves npm plugins via the default export
export default SecretRedactor;
