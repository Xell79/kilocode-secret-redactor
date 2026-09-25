import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { PluginConfigError, type PluginOptions, parseOptions } from "./config.js";
import { assertRuleList, type PatternRule, parseRule, STAGES, type Stage } from "./patterns.js";

export interface UserConfig extends PluginOptions {
  readonly order: readonly Stage[];
  readonly whitelist: readonly PatternRule[];
  readonly blacklist: readonly PatternRule[];
}

function defaultConfigFile(): string {
  return createRequire(`${process.cwd()}/package.json`).resolve("./secret-redactor.default.json");
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

export async function loadUserConfig(
  overrides: Record<string, unknown> | undefined,
  options: { configPath?: string; env?: NodeJS.ProcessEnv; read?: typeof readFile } = {},
): Promise<UserConfig> {
  const read = options.read ?? readFile;
  const defaults = packagedConfig();
  const userPath = options.configPath ?? join(kiloConfigDir(options.env), "secret-redactor.json");
  let user: Partial<UserConfig> = {};
  try {
    user = parseDocument(JSON.parse(await read(userPath, "utf8")));
  } catch (error) {
    if (options.configPath || !isMissing(error))
      throw new PluginConfigError("secret-redactor config is invalid");
  }
  const plugin = parseOptions(overrides);
  const pluginRules = parsePluginRules(overrides);
  return {
    ...defaults,
    ...dropEmpty(user),
    ...dropEmpty(plugin),
    order: arrayOverride(pluginOrder(overrides), user.order, defaults.order),
    whitelist: pluginRules.whitelist ?? user.whitelist ?? defaults.whitelist,
    blacklist: pluginRules.blacklist ?? user.blacklist ?? defaults.blacklist,
    disabledTypes: plugin.disabledTypes.size
      ? plugin.disabledTypes
      : (user.disabledTypes ?? defaults.disabledTypes),
    disabledScannerRules: plugin.disabledScannerRules.size
      ? plugin.disabledScannerRules
      : (user.disabledScannerRules ?? defaults.disabledScannerRules),
  };
}

function parseDocument(value: unknown): UserConfig {
  if (!isRecord(value)) throw new PluginConfigError("secret-redactor config must be an object");
  const options = parseOptions(value);
  const order = parseOrder(value.order);
  const whitelist = parseRules(value.whitelist ?? []);
  const blacklist = parseRules(value.blacklist ?? []);
  assertRuleList([...whitelist, ...blacklist]);
  return { ...options, order, whitelist, blacklist };
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

function pluginOrder(overrides: Record<string, unknown> | undefined): readonly Stage[] | undefined {
  if (!overrides || !("order" in overrides)) return undefined;
  return parseOrder(overrides.order);
}

function parsePluginRules(overrides: Record<string, unknown> | undefined): {
  whitelist?: PatternRule[];
  blacklist?: PatternRule[];
} {
  if (!overrides) return {};
  const whitelist = "whitelist" in overrides ? parseRules(overrides.whitelist ?? []) : undefined;
  const blacklist = "blacklist" in overrides ? parseRules(overrides.blacklist ?? []) : undefined;
  if (whitelist || blacklist) assertRuleList([...(whitelist ?? []), ...(blacklist ?? [])]);
  return { whitelist, blacklist };
}

function dropEmpty<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== ""),
  ) as Partial<T>;
}

function arrayOverride<T>(plugin: T | undefined, user: T | undefined, fallback: T): T {
  return plugin ?? user ?? fallback;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
