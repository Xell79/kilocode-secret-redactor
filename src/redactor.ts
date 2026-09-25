import { createHash } from "node:crypto";
import { MAX_SCAN_INPUT_CHARS } from "./config.js";
import { matchRules } from "./detector.js";
import type { Finding } from "./findings.js";
import type { PatternRule, Stage } from "./patterns.js";
import type { SecretScanner } from "./secret-scanner.js";
import { locateUnoccupied, maskOccupied, replaceSpans, type Span } from "./spans.js";
import { packagedConfig } from "./user-config.js";
import type { SecretVault } from "./vault.js";

export interface RedactResult {
  readonly value: unknown;
  readonly labels: ReadonlyArray<string>;
}

export interface ScanContext {
  readonly scanner?: SecretScanner;
  readonly order: readonly Stage[];
  readonly whitelist: readonly PatternRule[];
  readonly blacklist: readonly PatternRule[];
  readonly envValues: readonly { category: string; value: string }[];
  readonly disabledTypes: ReadonlySet<string>;
  readonly disabledScannerRules: ReadonlySet<string>;
  readonly minValueLength: number;
  readonly cache: Map<string, Finding[]>;
  readonly cacheLimit: number;
  readonly mode: "required" | "optional" | "disabled";
  warn(message: string): void;
}

export async function redactString(
  text: string,
  vault: SecretVault,
  context?: ScanContext,
): Promise<{ text: string; labels: string[] }> {
  const accepted = await collectSpans(text, vault, context);
  const labels: string[] = [];
  const redacted = replaceSpans(
    text,
    accepted.filter((span) => span.stage !== "whitelist"),
    (span) => {
      const token = span.label.startsWith("🔒") ? span.label : vault.store(span.label, span.value);
      labels.push(token);
      return token;
    },
  );
  return { text: redacted, labels };
}

export async function redactDeep(
  value: unknown,
  vault: SecretVault,
  context?: ScanContext,
): Promise<RedactResult> {
  const labels: string[] = [];
  return { value: await redactValue(value, vault, labels, context), labels };
}

export function unredactDeep(value: unknown, vault: SecretVault): unknown {
  if (typeof value === "string") return vault.unscrubText(value);
  if (Array.isArray(value)) return value.map((item) => unredactDeep(item, vault));
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) result[key] = unredactDeep(val, vault);
    return result;
  }
  return value;
}

async function collectSpans(
  text: string,
  vault: SecretVault,
  context: ScanContext | undefined,
): Promise<Span[]> {
  const occupied: Span[] = [];
  const accepted: Span[] = [];
  for (const [value, token] of vault.valuesUpTo(text.length)) {
    for (const span of locateUnoccupied(text, value, occupied)) {
      const known = { ...span, label: token, stage: "blacklist" as const };
      occupied.push(known);
      accepted.push(known);
    }
  }
  for (const stage of context?.order ?? ["whitelist", "blacklist", "betterleaks"]) {
    const view = maskOccupied(text, occupied);
    const stageSpans = await spansForStage(view, text, stage, occupied, context);
    occupied.push(...stageSpans);
    accepted.push(...stageSpans);
  }
  return accepted;
}

async function spansForStage(
  view: string,
  original: string,
  stage: Stage,
  occupied: readonly Span[],
  context: ScanContext | undefined,
): Promise<Span[]> {
  const defaults = context ? undefined : packagedConfig();
  if (stage === "whitelist") {
    return matchRules(view, context?.whitelist ?? defaults?.whitelist ?? [], {
      ...ruleOptions(context),
      occupied,
      stage,
    });
  }
  if (stage === "blacklist") {
    const rules = matchRules(view, context?.blacklist ?? defaults?.blacklist ?? [], {
      ...ruleOptions(context),
      occupied,
      stage,
    });
    const exact = (context?.envValues ?? []).flatMap((item) =>
      locateUnoccupied(view, item.value, [...occupied, ...rules]).map((span) => ({
        ...span,
        label: item.category,
        stage: "blacklist" as const,
      })),
    );
    return [...rules, ...exact];
  }
  return scanBetterleaks(view, original, occupied, context);
}

async function scanBetterleaks(
  view: string,
  original: string,
  occupied: readonly Span[],
  context: ScanContext | undefined,
): Promise<Span[]> {
  if (!context?.scanner || context.mode === "disabled") return [];
  if (view.length > MAX_SCAN_INPUT_CHARS) {
    if (context.mode === "required") throw new Error("text exceeds the scanner input limit");
    context.warn("skipped Betterleaks because the text exceeds the input limit");
    return [];
  }
  const digest = createHash("sha256")
    .update(context.scanner.version)
    .update("\0")
    .update([...context.disabledScannerRules].sort().join(","))
    .update("\0")
    .update(view)
    .digest("hex");
  let findings = context.cache.get(digest);
  if (!findings) {
    try {
      findings = await context.scanner.scan(view, context.disabledScannerRules);
    } catch (error) {
      if (context.mode === "required") throw error;
      context.warn("Betterleaks scan failed; continuing with earlier detection stages");
      return [];
    }
    remember(context, digest, findings);
  }
  const located: Span[] = [];
  for (const finding of findings) {
    const places = locateUnoccupied(original, finding.value, [...occupied, ...located]).filter(
      (span) => view.slice(span.start, span.end) === finding.value,
    );
    if (places.length === 0 && original.includes(finding.value)) {
      if (context.mode === "required")
        throw new Error("Betterleaks finding could not be mapped to source text");
      context.warn("skipped a Betterleaks finding that was not a literal source span");
      continue;
    }
    located.push(
      ...places.map((span) => ({
        ...span,
        label: finding.category,
        stage: "betterleaks" as const,
      })),
    );
  }
  return located;
}

function remember(context: ScanContext, key: string, value: Finding[]): void {
  if (context.cache.size >= context.cacheLimit) {
    const oldest = context.cache.keys().next().value;
    if (oldest) context.cache.delete(oldest);
  }
  context.cache.set(key, value);
}

function ruleOptions(context: ScanContext | undefined) {
  return { minLength: context?.minValueLength, disabledTypes: context?.disabledTypes };
}

async function redactValue(
  value: unknown,
  vault: SecretVault,
  labels: string[],
  context: ScanContext | undefined,
): Promise<unknown> {
  if (typeof value === "string") {
    const result = await redactString(value, vault, context);
    labels.push(...result.labels);
    return result.text;
  }
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value) result.push(await redactValue(item, vault, labels, context));
    return result;
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value))
      result[key] = await redactValue(val, vault, labels, context);
    return result;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
