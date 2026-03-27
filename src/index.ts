export { type DetectedSecret, detectSecrets } from "./detector.js";
export { PATTERNS, type SecretPattern } from "./patterns.js";
export { SecretRedactor } from "./plugin.js";
export { type RedactResult, redactDeep, unredactDeep } from "./redactor.js";
export { createVault, type SecretVault } from "./vault.js";
