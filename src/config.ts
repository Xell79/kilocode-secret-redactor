export const REDACTED_PREFIX = "🔒";
export const REDACTED_SUFFIX = "🔓";
export const MIN_SECRET_LENGTH = 8;
export const DEFAULT_SCANNER_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_MAPPINGS = 10_000;
export const DEFAULT_SCAN_CACHE_SIZE = 256;
export const MAX_SCAN_INPUT_CHARS = 1_000_000;
export const MAX_SCAN_OUTPUT_CHARS = 2_000_000;
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

export function parseOptions(raw: Record<string, unknown> | undefined): PluginOptions {
  const input = raw ?? {};
  return {
    scannerMode: readMode(input.scannerMode),
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

function readMode(value: unknown): "required" | "optional" | "disabled" {
  if (value === undefined) return "required";
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
