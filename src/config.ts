export const REDACT_OUTPUT_TOOLS = ["bash", "read"] as const;
export const UNREDACT_ARGS_TOOLS = ["bash", "write", "edit"] as const;
export const MIN_SECRET_LENGTH = 8;
export const REDACTED_PREFIX = "<<REDACTED:";
export const REDACTED_SUFFIX = ">>";
