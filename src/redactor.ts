import { detectSecrets } from "./detector.js";
import type { SecretVault } from "./vault.js";

export interface RedactResult {
  readonly value: unknown;
  readonly labels: ReadonlyArray<string>;
}

export function redactString(text: string, vault: SecretVault): { text: string; labels: string[] } {
  let result = vault.scrubText(text);
  const labels: string[] = [];

  const detected = detectSecrets(result);
  for (const secret of detected) {
    vault.store(secret.label, secret.value);
    labels.push(secret.label);
  }
  result = vault.scrubText(result);

  return { text: result, labels };
}

export function redactDeep(value: unknown, vault: SecretVault): RedactResult {
  const labels: string[] = [];
  const redacted = redactValue(value, vault, labels);
  return { value: redacted, labels };
}

export function unredactDeep(value: unknown, vault: SecretVault): unknown {
  if (typeof value === "string") return vault.unscrubText(value);
  if (Array.isArray(value)) {
    return value.map((item) => unredactDeep(item, vault));
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = unredactDeep(val, vault);
    }
    return result;
  }
  return value;
}

function redactValue(value: unknown, vault: SecretVault, labels: string[]): unknown {
  if (typeof value === "string") {
    const result = redactString(value, vault);
    labels.push(...result.labels);
    return result.text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, vault, labels));
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactValue(val, vault, labels);
    }
    return result;
  }
  return value;
}

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
