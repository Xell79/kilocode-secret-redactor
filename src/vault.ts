import { REDACTED_PREFIX, REDACTED_SUFFIX } from "./config.js";

export class VaultCapacityError extends Error {
  constructor(limit: number) {
    super(`secret mapping limit of ${limit} exceeded`);
    this.name = "VaultCapacityError";
  }
}

export interface SecretVault {
  store(category: string, value: string): string;
  scrubText(text: string): string;
  unscrubText(text: string): string;
  clear(): void;
  entries(): IterableIterator<[string, string]>;
  valuesUpTo(maxLength: number): IterableIterator<[string, string]>;
  readonly size: number;
}

function sanitizeCategory(category: string): string {
  const safe = category
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return safe || "secret";
}

export function createVault(maxMappings = 10_000): SecretVault {
  const tokenByValue = new Map<string, string>();
  const valueByToken = new Map<string, string>();
  const nextByCategory = new Map<string, number>();

  function store(category: string, value: string): string {
    const existing = tokenByValue.get(value);
    if (existing) return existing;
    if (tokenByValue.size >= maxMappings) throw new VaultCapacityError(maxMappings);

    const safe = sanitizeCategory(category);
    const next = (nextByCategory.get(safe) ?? 0) + 1;
    nextByCategory.set(safe, next);
    const token = `${REDACTED_PREFIX}${safe}_${next}${REDACTED_SUFFIX}`;
    tokenByValue.set(value, token);
    valueByToken.set(token, value);
    return token;
  }

  function scrubText(text: string): string {
    const entries = [...tokenByValue.entries()].sort(
      (left, right) => right[0].length - left[0].length,
    );
    let result = text;
    for (const [value, token] of entries) result = result.split(value).join(token);
    return result;
  }

  function unscrubText(text: string): string {
    const entries = [...valueByToken.entries()].sort(
      (left, right) => right[0].length - left[0].length,
    );
    let result = text;
    for (const [token, value] of entries) {
      if (!result.includes(token)) continue;
      result = result.split(token).join(value);
    }
    return result;
  }

  return {
    store,
    scrubText,
    unscrubText,
    clear() {
      tokenByValue.clear();
      valueByToken.clear();
      nextByCategory.clear();
    },
    get size() {
      return tokenByValue.size;
    },
    entries() {
      return tokenByValue.entries();
    },
    *valuesUpTo(maxLength: number) {
      for (const [value, token] of tokenByValue) {
        if (value.length <= maxLength) yield [value, token];
      }
    },
  };
}
