export { PluginConfigError, type PluginOptions, parseOptions } from "./config.js";
export { type DetectedSecret, detectSecrets, matchRules } from "./detector.js";
export { loadEnvFindings } from "./env-values.js";
export { type Finding, type FindingSource, mergeFindings } from "./findings.js";
export { matcherFor, type PatternRule, parseRule, type Stage } from "./patterns.js";
export { createServer, server } from "./plugin.js";
export {
  type RedactResult,
  redactDeep,
  redactString,
  type ScanContext,
  unredactDeep,
} from "./redactor.js";
export {
  createBetterleaksScanner,
  parseBetterleaksVersion,
  parseFindings,
  resolveBetterleaks,
  type SecretScanner,
  sanitizedScannerEnv,
} from "./secret-scanner.js";
export { maskOccupied } from "./spans.js";
export { kiloConfigDir, loadUserConfig } from "./user-config.js";
export { createVault, type SecretVault, VaultCapacityError } from "./vault.js";
