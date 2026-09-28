import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mergeOptions,
  type PartialPluginOptions,
  PluginConfigError,
  type PluginOptions,
  parseOptions,
  parsePartialOptions,
} from "./config.js";
import { assertRuleList, type PatternRule, parseRule, STAGES, type Stage } from "./patterns.js";

export interface UserConfig extends PluginOptions {
  readonly order: readonly Stage[];
  readonly whitelist: readonly PatternRule[];
  readonly blacklist: readonly PatternRule[];
}

function defaultConfigFile(): string {
  return fileURLToPath(new URL("../secret-redactor.default.json", import.meta.url));
}

let packaged: UserConfig | undefined;

export function packagedConfig(): UserConfig {
  if (packaged) return packaged;
  packaged = parseDocument(JSON.parse(readFileSync(defaultConfigFile(), "utf8")));
  return packaged;
}

export function kiloConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KILO_CONFIG_DIR) return env.KILO_CONFIG_DIR;
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "kilo");
}

interface ConfigLayer extends PartialPluginOptions {
  readonly order?: readonly Stage[];
  readonly whitelist?: readonly PatternRule[];
  readonly blacklist?: readonly PatternRule[];
}

export async function loadUserConfig(
  overrides: Record<string, unknown> | undefined,
  options: { configPath?: string; env?: NodeJS.ProcessEnv; read?: typeof readFile } = {},
): Promise<UserConfig> {
  const read = options.read ?? readFile;
  const defaults = packagedConfig();
  const userPath = options.configPath ?? join(kiloConfigDir(options.env), "secret-redactor.json");
  let user: ConfigLayer = {};
  try {
    user = parseLayer(JSON.parse(await read(userPath, "utf8")));
  } catch (error) {
    if (options.configPath || !isMissing(error))
      throw new PluginConfigError("secret-redactor config is invalid");
  }
  const plugin = overrides ? parseLayer(overrides) : {};
  assertRuleList([
    ...(plugin.whitelist ?? user.whitelist ?? []),
    ...(plugin.blacklist ?? user.blacklist ?? []),
  ]);
  return {
    ...mergeOptions(defaults, user, plugin),
    order: plugin.order ?? user.order ?? defaults.order,
    whitelist: plugin.whitelist ?? user.whitelist ?? defaults.whitelist,
    blacklist: plugin.blacklist ?? user.blacklist ?? defaults.blacklist,
  };
}

/** Full defaults plus rules. Only the packaged file is a complete document. */
function parseDocument(value: unknown): UserConfig {
  const layer = parseLayer(value);
  return {
    ...mergeOptions(packagedDefaults(), layer),
    order: layer.order ?? ["whitelist", "blacklist", "betterleaks"],
    whitelist: layer.whitelist ?? [],
    blacklist: layer.blacklist ?? [],
  };
}

function packagedDefaults(): PluginOptions {
  return parseOptions(undefined);
}

function parseLayer(value: unknown): ConfigLayer {
  if (!isRecord(value)) throw new PluginConfigError("secret-redactor config must be an object");
  const order = "order" in value ? parseOrder(value.order) : undefined;
  const whitelist = "whitelist" in value ? parseRules(value.whitelist ?? []) : undefined;
  const blacklist = "blacklist" in value ? parseRules(value.blacklist ?? []) : undefined;
  if (whitelist || blacklist) assertRuleList([...(whitelist ?? []), ...(blacklist ?? [])]);
  return { ...parsePartialOptions(value), order, whitelist, blacklist };
}

function parseOrder(value: unknown): readonly Stage[] {
  if (value === undefined) return ["whitelist", "blacklist", "betterleaks"];
  if (!Array.isArray(value) || value.length !== STAGES.length) {
    throw new PluginConfigError("order must list whitelist, blacklist, and betterleaks");
  }
  const order = value.map((item) => {
    if (item !== "whitelist" && item !== "blacklist" && item !== "betterleaks") {
      throw new PluginConfigError("order contains an unknown stage");
    }
    return item;
  });
  if (new Set(order).size !== order.length)
    throw new PluginConfigError("order contains a duplicate stage");
  return order;
}

function parseRules(value: unknown): PatternRule[] {
  if (!Array.isArray(value)) throw new PluginConfigError("pattern rules must be an array");
  return value.map((item, index) => parseRule(item, index));
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
