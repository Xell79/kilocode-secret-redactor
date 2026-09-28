export const REDACTED_PREFIX = "🔒";
export const REDACTED_SUFFIX = "🔓";
export const MIN_SECRET_LENGTH = 8;
export const DEFAULT_SCANNER_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_MAPPINGS = 10_000;
export const DEFAULT_SCAN_CACHE_SIZE = 256;
export const MAX_SCAN_INPUT_CHARS = 1_000_000;
export const MAX_SCAN_OUTPUT_CHARS = 2_000_000;
export const MAX_ENV_FILE_BYTES = 512 * 1024;
export const MIN_BETTERLEAKS_VERSION = "1.8.1";
export const UNREDACT_ARGS_TOOLS = ["bash", "write", "edit"] as const;
export const DEFAULT_DISABLED_TYPES = ["url", "ip_address", "ssh_public_key"] as const;
export const ENV_TEMPLATE_NAMES = new Set([".env.example", ".env.sample", ".env.template"]);
export const SCANNER_CONFIG_ENV = [
  "BETTERLEAKS_CONFIG",
  "BETTERLEAKS_CONFIG_TOML",
  "GITLEAKS_CONFIG",
  "GITLEAKS_CONFIG_TOML",
] as const;
export const SCAN_ARGS = [
  "stdin",
  "--report-path",
  "-",
  "--report-format",
  "json",
  "--no-banner",
  "--no-color",
  "--exit-code",
  "0",
  "--max-decode-depth",
  "0",
  "--max-archive-depth",
  "0",
] as const;
export const SAMPLE_VALUE_PATTERN =
  /^(?:changeme|change-me|change_me|example|placeholder|replace-me|replace_me|your[-_].*|xxx+|todo|password|secret)$/i;

export const PLACEHOLDER_INSTRUCTION =
  "Redaction placeholders such as 🔒category_1🔓 are opaque local tokens. Preserve each placeholder exactly, including its category, number, and surrounding markers. Do not invent, translate, split, or explain them.";

export interface PluginOptions {
  readonly scannerMode: "required" | "optional" | "disabled";
  readonly betterleaksPath?: string;
  readonly scannerTimeoutMs: number;
  readonly envFiles: readonly string[];
  readonly autoEnvFiles: boolean;
  readonly minValueLength: number;
  readonly disabledTypes: ReadonlySet<string>;
  readonly disabledScannerRules: ReadonlySet<string>;
  readonly unredactTools: ReadonlySet<string>;
  readonly maxMappings: number;
  readonly scanCacheSize: number;
}

export class PluginConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginConfigError";
  }
}

export type PartialPluginOptions = {
  -readonly [K in keyof PluginOptions]?: PluginOptions[K];
};

const OPTION_KEYS = [
  "scannerMode",
  "betterleaksPath",
  "scannerTimeoutMs",
  "envFiles",
  "autoEnvFiles",
  "minValueLength",
  "disabledTypes",
  "disabledScannerRules",
  "unredactTools",
  "maxMappings",
  "scanCacheSize",
] as const satisfies readonly (keyof PluginOptions)[];

/**
 * Validate only the keys a layer actually sets. Absent keys stay absent so a
 * higher layer (user file, Kilo tuple) cannot reset a lower layer to defaults.
 */
export function parsePartialOptions(
  raw: Record<string, unknown> | undefined,
): PartialPluginOptions {
  if (!raw) return {};
  const partial: PartialPluginOptions = {};
  if ("scannerMode" in raw) partial.scannerMode = readMode(raw.scannerMode, false);
  if ("betterleaksPath" in raw)
    partial.betterleaksPath = readOptionalString(raw.betterleaksPath, "betterleaksPath");
  if ("scannerTimeoutMs" in raw) {
    partial.scannerTimeoutMs = readPositiveInt(raw.scannerTimeoutMs, 0, "scannerTimeoutMs");
  }
  if ("envFiles" in raw) partial.envFiles = readStringArray(raw.envFiles, "envFiles");
  if ("autoEnvFiles" in raw)
    partial.autoEnvFiles = readBoolean(raw.autoEnvFiles, false, "autoEnvFiles");
  if ("minValueLength" in raw)
    partial.minValueLength = readPositiveInt(raw.minValueLength, 0, "minValueLength");
  if ("disabledTypes" in raw)
    partial.disabledTypes = normalizeSet(readStringArray(raw.disabledTypes, "disabledTypes"));
  if ("disabledScannerRules" in raw) {
    partial.disabledScannerRules = normalizeSet(
      readStringArray(raw.disabledScannerRules, "disabledScannerRules"),
    );
  }
  if ("unredactTools" in raw)
    partial.unredactTools = new Set(readStringArray(raw.unredactTools, "unredactTools"));
  if ("maxMappings" in raw)
    partial.maxMappings = readPositiveInt(raw.maxMappings, 0, "maxMappings");
  if ("scanCacheSize" in raw)
    partial.scanCacheSize = readPositiveInt(raw.scanCacheSize, 0, "scanCacheSize");
  return partial;
}

export function parseOptions(raw: Record<string, unknown> | undefined): PluginOptions {
  const input = raw ?? {};
  return {
    scannerMode: readMode(input.scannerMode, true),
    betterleaksPath: readOptionalString(input.betterleaksPath, "betterleaksPath"),
    scannerTimeoutMs: readPositiveInt(
      input.scannerTimeoutMs,
      DEFAULT_SCANNER_TIMEOUT_MS,
      "scannerTimeoutMs",
    ),
    envFiles: readStringArray(input.envFiles, "envFiles"),
    autoEnvFiles: readBoolean(input.autoEnvFiles, true, "autoEnvFiles"),
    minValueLength: readPositiveInt(input.minValueLength, MIN_SECRET_LENGTH, "minValueLength"),
    disabledTypes: normalizeSet(
      readStringArray(input.disabledTypes, "disabledTypes", [...DEFAULT_DISABLED_TYPES]),
    ),
    disabledScannerRules: normalizeSet(
      readStringArray(input.disabledScannerRules, "disabledScannerRules"),
    ),
    unredactTools: new Set(
      readStringArray(input.unredactTools, "unredactTools", [...UNREDACT_ARGS_TOOLS]),
    ),
    maxMappings: readPositiveInt(input.maxMappings, DEFAULT_MAX_MAPPINGS, "maxMappings"),
    scanCacheSize: readPositiveInt(input.scanCacheSize, DEFAULT_SCAN_CACHE_SIZE, "scanCacheSize"),
  };
}

export function mergeOptions(
  base: PluginOptions,
  ...layers: readonly PartialPluginOptions[]
): PluginOptions {
  const merged: PluginOptions = { ...base };
  for (const layer of layers) {
    for (const key of OPTION_KEYS) {
      if (layer[key] !== undefined) Object.assign(merged, { [key]: layer[key] });
    }
  }
  return merged;
}

function readMode(value: unknown, fallback: boolean): "required" | "optional" | "disabled" {
  if (value === undefined && fallback) return "required";
  if (value === "required" || value === "optional" || value === "disabled") return value;
  throw new PluginConfigError('scannerMode must be "required", "optional", or "disabled"');
}

function readOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new PluginConfigError(`${name} must be a non-empty string`);
  }
  return value;
}

function readBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new PluginConfigError(`${name} must be a boolean`);
  return value;
}

function readPositiveInt(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new PluginConfigError(`${name} must be a positive integer`);
  }
  return value;
}

function readStringArray(value: unknown, name: string, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    throw new PluginConfigError(`${name} must be an array of non-empty strings`);
  }
  return value;
}

function normalizeSet(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => value.toLowerCase()));
}
