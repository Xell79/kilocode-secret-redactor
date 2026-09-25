import { MIN_SECRET_LENGTH } from "./config.js";
import { matcherFor, type PatternRule } from "./patterns.js";
import type { Span } from "./spans.js";
import { overlaps } from "./spans.js";
import { packagedConfig } from "./user-config.js";

export interface DetectedSecret {
  readonly label: string;
  readonly value: string;
}

export function matchRules(
  text: string,
  rules: readonly PatternRule[],
  options: {
    minLength?: number;
    disabledTypes?: ReadonlySet<string>;
    occupied?: readonly Span[];
    stage: Span["stage"];
  },
): Span[] {
  const minLength = options.minLength ?? MIN_SECRET_LENGTH;
  const disabled = options.disabledTypes ?? new Set<string>();
  const occupied = options.occupied ?? [];
  const found: Span[] = [];
  for (const rule of rules) {
    if (disabled.has(rule.id.toLowerCase()) || disabled.has(rule.label.toLowerCase())) continue;
    const regex = matcherFor(rule);
    regex.lastIndex = 0;
    for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
      const indices = match.indices?.[rule.captureGroup];
      if (!indices) continue;
      const [start, end] = indices;
      const value = text.slice(start, end);
      const span: Span = { start, end, value, label: rule.label, stage: options.stage };
      if (
        value.length < minLength ||
        occupied.some((item) => overlaps(item, span)) ||
        found.some((item) => overlaps(item, span))
      ) {
        continue;
      }
      found.push(span);
    }
  }
  return found;
}

export function detectSecrets(
  text: string,
  rules: readonly PatternRule[] = packagedConfig().blacklist,
  options: { minLength?: number; disabledTypes?: ReadonlySet<string> } = {},
): DetectedSecret[] {
  return matchRules(text, rules, { ...options, stage: "blacklist" }).map((span) => ({
    label: span.label,
    value: span.value,
  }));
}
