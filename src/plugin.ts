import type { Plugin } from "@opencode-ai/plugin";

interface TextPart {
  type: "text";
  text: string;
}

function isTextPart(part: unknown): part is TextPart {
  return typeof part === "object" && part !== null && (part as TextPart).type === "text";
}

function isToolInScope(tool: string, tools: ReadonlyArray<string>): boolean {
  return tools.includes(tool);
}

// Named export for programmatic consumers
export const SecretRedactor: Plugin = async () => {
  const [
    { REDACT_OUTPUT_TOOLS, UNREDACT_ARGS_TOOLS },
    { redactDeep, unredactDeep },
    { createVault },
  ] = await Promise.all([import("./config.js"), import("./redactor.js"), import("./vault.js")]);

  const vault = createVault();

  return {
    "chat.message": async (_input, output) => {
      for (const part of output.parts) {
        if (!isTextPart(part)) continue;
        const result = redactDeep(part.text, vault);
        part.text = result.value as string;
      }
    },

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
    },
  };
};

// OpenCode resolves npm plugins via the default export
export default SecretRedactor;
