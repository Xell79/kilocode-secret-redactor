/**
 * Runtime pattern rules live in JSON, not in this module.
 *
 * Matching is global over each string the redactor receives. It is not
 * line-based and it is not first-regex-wins. Add a rule to the `whitelist`
 * or `blacklist` array of `secret-redactor.json`:
 *
 * ```json
 * {
 *   "id": "public_docs",
 *   "label": "public_docs",
 *   "regex": "https://example\\.com/docs/[^\\s]+",
 *   "flags": "i"
 * }
 * ```
 *
 * - `regex` is a JavaScript source without surrounding slashes.
 * - `flags` may contain `i`, `m`, `s`, or `u`. `g` and `d` are added by the matcher.
 * - `captureGroup` defaults to 0 (the whole match). Use 1 or higher only when
 *   that group is the secret and it always participates. The redactor replaces
 *   that group's span, not the surrounding context.
 * - Whitelist spans stay unchanged and hide that text from later stages.
 * - Blacklist spans are replaced with placeholders.
 * - Stage priority comes from `order`, default
 *   `["whitelist", "blacklist", "betterleaks"]`.
 * - Rules run on the whole string. A match may cross newlines when the regex allows it.
 *
 * The user file is `~/.config/kilo/secret-redactor.json`. The packaged
 * `secret-redactor.default.json` is the fallback. Editing JSON does not require
 * a plugin rebuild.
 */

export const STAGES = ["whitelist", "blacklist", "betterleaks"] as const;
export type Stage = (typeof STAGES)[number];

export interface PatternRule {
  readonly id: string;
  readonly label: string;
  readonly regex: string;
  readonly flags: string;
  readonly captureGroup: number;
}

export const MAX_RULES = 500;
export const MAX_REGEX_LENGTH = 500;
const SAFE_FLAGS = new Set(["i", "m", "s", "u"]);

export class PatternConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatternConfigError";
  }
}

const compiledRules = new WeakMap<PatternRule, RegExp>();

export function compileRule(rule: PatternRule): RegExp {
  assertSafeRegex(rule.regex);
  const flags = uniqueFlags(`${rule.flags}gd`);
  try {
    return new RegExp(rule.regex, flags);
  } catch {
    throw new PatternConfigError(`rule ${rule.id} has an invalid regular expression`);
  }
}

export function matcherFor(rule: PatternRule): RegExp {
  const cached = compiledRules.get(rule);
  if (cached) return cached;
  const compiled = compileRule(rule);
  compiledRules.set(rule, compiled);
  return compiled;
}

export function parseRule(value: unknown, index: number): PatternRule {
  if (!isRecord(value)) throw new PatternConfigError(`rule ${index} must be an object`);
  const allowed = new Set(["id", "label", "regex", "flags", "captureGroup"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new PatternConfigError(`rule ${index} has an unknown field`);
  }
  const id = readToken(value.id, `rule ${index} id`);
  const label = typeof value.label === "string" && value.label.trim() ? value.label : id;
  if (
    typeof value.regex !== "string" ||
    value.regex.length === 0 ||
    value.regex.length > MAX_REGEX_LENGTH
  ) {
    throw new PatternConfigError(`rule ${id} has an invalid regular expression`);
  }
  const flags = typeof value.flags === "string" ? value.flags : "";
  if ([...flags].some((flag) => !SAFE_FLAGS.has(flag))) {
    throw new PatternConfigError(`rule ${id} has unsupported flags`);
  }
  const captureGroup = value.captureGroup === undefined ? 0 : value.captureGroup;
  if (typeof captureGroup !== "number" || !Number.isInteger(captureGroup) || captureGroup < 0) {
    throw new PatternConfigError(`rule ${id} has an invalid capture group`);
  }
  const rule = { id, label, regex: value.regex, flags, captureGroup };
  const compiled = matcherFor(rule);
  const groups = compiled.source.match(/\((?!\?)/g);
  if (captureGroup > (groups ? groups.length : 0)) {
    throw new PatternConfigError(`rule ${id} capture group does not exist`);
  }
  return rule;
}

export function assertRuleList(rules: readonly PatternRule[]): void {
  if (rules.length > MAX_RULES) throw new PatternConfigError("too many pattern rules");
  const seen = new Set<string>();
  for (const rule of rules) {
    const key = rule.id.toLowerCase();
    if (seen.has(key)) throw new PatternConfigError(`duplicate rule id ${rule.id}`);
    seen.add(key);
  }
}

function assertSafeRegex(source: string): void {
  if (source.length > MAX_REGEX_LENGTH) {
    throw new PatternConfigError("regular expression is too ambiguous");
  }
}

function uniqueFlags(flags: string): string {
  return [...new Set(flags)].join("");
}

function readToken(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new PatternConfigError(`${name} must contain only letters, numbers, _ or -`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
