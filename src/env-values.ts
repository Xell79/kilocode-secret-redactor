import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "dotenv";
import {
  ENV_TEMPLATE_NAMES,
  MAX_ENV_FILE_BYTES,
  PluginConfigError,
  SAMPLE_VALUE_PATTERN,
} from "./config.js";
import type { Finding } from "./findings.js";

export async function loadEnvFindings(
  worktree: string,
  options: {
    autoEnvFiles: boolean;
    envFiles: readonly string[];
    minValueLength: number;
    strict: boolean;
    warn?: (message: string) => void;
  },
): Promise<Finding[]> {
  const paths = new Set<string>();
  if (options.autoEnvFiles) {
    for (const path of await discoverRootEnvFiles(worktree, options.strict)) paths.add(path);
  }
  for (const configured of options.envFiles) {
    paths.add(await resolveConfiguredPath(worktree, configured));
  }

  const byValue = new Map<string, Finding>();
  for (const path of paths) {
    const readable = await readableEnvFile(path, options.strict, options.warn);
    if (!readable) continue;
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      if (options.strict) throw new PluginConfigError("unable to read an env file");
      continue;
    }
    for (const [name, value] of Object.entries(parse(content))) {
      if (!isSensitiveValue(value, options.minValueLength) || byValue.has(value)) continue;
      byValue.set(value, { category: sanitizeEnvName(name), value, source: "env" });
    }
  }
  return [...byValue.values()];
}

export async function discoverRootEnvFiles(worktree: string, strict: boolean): Promise<string[]> {
  const entries = await readdir(worktree, { withFileTypes: true }).catch((error: unknown) => {
    if (strict) throw new PluginConfigError("unable to read worktree directory");
    void error;
    return [];
  });
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(".env") || ENV_TEMPLATE_NAMES.has(entry.name)) continue;
    const path = join(worktree, entry.name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      paths.push(path);
    } catch {
      if (strict) throw new PluginConfigError("unable to inspect an env file");
    }
  }
  return paths.sort();
}

async function resolveConfiguredPath(worktree: string, configured: string): Promise<string> {
  if (configured.includes("\0")) throw new PluginConfigError("envFiles contains an invalid path");
  const root = await realpath(resolve(worktree));
  const resolved = isAbsolute(configured) ? resolve(configured) : resolve(root, configured);
  // Falling back to the unresolved path would let a dangling symlink or a
  // permission error skip the containment check below.
  const real = await realpath(resolved).catch(() => {
    throw new PluginConfigError("unable to resolve an env file");
  });
  const rel = relative(root, real);
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    throw new PluginConfigError("envFiles path escapes the worktree");
  }
  return real;
}

/**
 * Reject anything that is not a regular file before reading it. A directory
 * fails with EISDIR; a FIFO blocks `readFile` forever and hangs startup.
 * Returns false when the file should be skipped.
 */
async function readableEnvFile(
  path: string,
  strict: boolean,
  warn?: (message: string) => void,
): Promise<boolean> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) {
    if (strict) throw new PluginConfigError("env file is not a regular file");
    return false;
  }
  if (info.size > MAX_ENV_FILE_BYTES) {
    if (strict) throw new PluginConfigError("env file exceeds the size limit");
    return false;
  }
  // The path only: never a value, a variable name, or a length.
  if ((info.mode & 0o077) !== 0) warn?.("env file is readable by group or others");
  return true;
}

function isSensitiveValue(value: string, minLength: number): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= minLength && !trimmed.includes("${") && !SAMPLE_VALUE_PATTERN.test(trimmed)
  );
}

function sanitizeEnvName(name: string): string {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return safe || "env_secret";
}
