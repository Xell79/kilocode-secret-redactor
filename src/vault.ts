import { REDACTED_PREFIX, REDACTED_SUFFIX } from "./config.js";

export interface SecretVault {
  store(name: string, value: string): string;
  scrubText(text: string): string;
  unscrubText(text: string): string;
  readonly size: number;
}

export function createVault(): SecretVault {
  const tokenByValue = new Map<string, string>();
  const valueByToken = new Map<string, string>();

  function store(name: string, value: string): string {
    const existing = tokenByValue.get(value);
    if (existing) return existing;

    const token = `${REDACTED_PREFIX}${name}${REDACTED_SUFFIX}`;
    tokenByValue.set(value, token);
    valueByToken.set(token, value);
    return token;
  }

  function scrubText(text: string): string {
    let result = text;
    for (const [value, token] of tokenByValue) {
      result = result.split(value).join(token);
    }
    return result;
  }

  function unscrubText(text: string): string {
    let result = text;
    for (const [token, value] of valueByToken) {
      result = result.split(token).join(value);
    }
    return result;
  }

  return {
    store,
    scrubText,
    unscrubText,
    get size() {
      return tokenByValue.size;
    },
  };
}
