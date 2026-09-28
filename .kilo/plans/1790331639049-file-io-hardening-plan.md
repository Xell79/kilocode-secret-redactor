# Privacyfilter: file-IO, config-precedence, and regex hardening

## Goal

Fix every defect found in the code review of `src/`: scanner temp-directory
churn, unsafe/unguarded filesystem access, executable resolution, the
config-precedence bug that silently discards user settings, and inaccurate
capture-group validation. Preserve all existing invariants from `AGENTS.md`.

## Context

Findings come from a review of `src/secret-scanner.ts`, `src/env-values.ts`,
`src/user-config.ts`, `src/config.ts`, `src/patterns.ts`, `src/plugin.ts`.

### Why the neutral scanner `cwd` exists (do not remove it)

Verified against gitleaks/betterleaks upstream source:

- `cmd/stdin.go` → `runStdIn` calls `initConfig(".")` and
  `Detector(cmd, cfg, "")`. The config "target path" for a stdin scan **is the
  process cwd**.
- `cmd/root.go` → config precedence is `--config` → `GITLEAKS_CONFIG` →
  `GITLEAKS_CONFIG_TOML` → `(target path)/.gitleaks.toml`. The plugin already
  strips the env vars in `sanitizedScannerEnv`, but the **file** channel is only
  closed by controlling `cwd`.
- `cmd/root.go` also does `fileExists(filepath.Join(source, ".gitleaksignore"))`
  with `source == ""`, plus `--gitleaks-ignore-path` defaulting to `"."`. So
  `.gitleaksignore` / `.betterleaksignore` are read from `cwd` too.

Consequence: if `cwd` were the user's repo, a committed `.gitleaks.toml` with
`[allowlist] regexes = ['''.*''']` would silently turn the redactor into a
no-op. Using `tmpdir()` directly is also unsafe — `/tmp` is world-writable, so
`/tmp/.gitleaks.toml` would be attacker-controlled. A private `mkdtemp`
directory (mode `0700`) is the correct guard.

An in-memory substitute is impossible: a child process `cwd` is a real
`chdir()` path in the kernel. The directory stays **empty** — input goes over
the stdin pipe, the report comes back on stdout via `--report-path -`. No
secret ever touches the disk.

The actual defect is only the **lifetime**: `mkdtemp` + `rm -rf` runs on every
scanned string (chat parts, tool output) instead of once per scanner instance.

## Decisions

- Keep the neutral directory; make it one per scanner instance, released on
  `dispose`. Add a comment in `secret-scanner.ts` recording the two bypass
  channels above so it is not "optimized away" later.
- Recreate the directory once and retry if it vanished (tmp reaper on long
  sessions).
- Config layering becomes explicit three-level: packaged defaults ← user file ←
  Kilo tuple overrides, using *partial* parsing so an absent key never
  overwrites a lower layer.
- Failures reading env files stay non-fatal when `strict` is false; `strict`
  (i.e. `scannerMode: "required"`) keeps failing loudly.
- Permission warnings on `.env` files are logged, never fatal, and never
  include file contents.

## Steps

### A. Scanner working directory and spawn robustness (`src/secret-scanner.ts`)

- [x] Extend the `SecretScanner` interface with `dispose(): Promise<void>`.
- [x] In `createBetterleaksScanner`, create the neutral directory once and reuse
      it for the `version` health check and every `scan`. Remove the per-scan
      `mkdtemp`/`rm` pair and the `finally { rm(cwd) }` that currently deletes
      the directory immediately after the health check.
- [x] Release the directory in `dispose()` only (`rm(dir, { recursive: true,
      force: true })`); make `dispose()` idempotent and mark the scanner unusable
      afterwards.
- [x] Harden `createNeutralWorkdir`: keep `mkdtemp` (mode `0700`) and add a
      short comment naming the `.gitleaks.toml` / `.gitleaksignore` bypass it
      blocks.
- [x] If a scan fails because the directory disappeared (`ENOENT` from `spawn`),
      recreate it once and retry the scan a single time; a second failure
      surfaces as `SecretScannerError`.
- [x] Fix `spawnProcess`: attach an `error` handler to `child.stdin` before
      `child.stdin.end(request.input)`. A failed `spawn` (bad binary, missing
      `cwd`) currently emits an unhandled `'error'` on the destroyed stdin
      stream and crashes the host instead of rejecting cleanly.
- [x] Replace `assertExecutable`'s `access(X_OK)`-only check with `stat` +
      `isFile()` first, then `access(X_OK)`. Directories carry `+x` by default,
      so a directory named `betterleaks` on `PATH` currently passes and then
      fails at `spawn` with `EISDIR`/`EACCES`.
- [x] In `resolveBetterleaks`, skip non-absolute `PATH` entries (`isAbsolute`).
      A `.` or relative entry currently resolves candidates against
      `process.cwd()`, allowing a repo-local binary to hijack the scan.

### B. Plugin wiring (`src/plugin.ts`)

- [x] Use the workspace root: `serverOptions.worktree ?? input.worktree ??
      input.directory`. `input.directory` is the session cwd, so a session
      started in a subdirectory currently misses root `.env*` files and
      mis-resolves relative `envFiles` (or trips "escapes the worktree").
- [x] Call `scanner.dispose()` from the `dispose` hook, alongside the existing
      per-session vault/cache teardown.

### C. Env-file filesystem safety (`src/env-values.ts`)

- [x] Wrap the `readdir(worktree)` call in `discoverRootEnvFiles` in
      `try/catch`. `EACCES`/`ENOENT`/`ENOTDIR` currently produce an unhandled
      rejection during plugin startup even when `strict` is false; return `[]`
      when not strict, throw `PluginConfigError` when strict.
- [x] Before reading any env file (both auto-discovered and configured), `stat`
      it and require `isFile()`. This rejects directories (`envFiles: ["."]`
      currently passes the containment check and then fails with `EISDIR`) and,
      critically, FIFOs — `readFile` on a named pipe blocks forever and hangs
      plugin startup.
- [x] Add a `MAX_ENV_FILE_BYTES` constant in `src/config.ts` (512 KiB) and skip
      larger files, warning when strict. Scanner input is already capped by
      `MAX_SCAN_INPUT_CHARS`; env reads are currently unbounded.
- [x] Remove the `realpath(...).catch(() => resolved)` fallback in
      `resolveConfiguredPath`: a `realpath` failure must not downgrade to the
      unresolved path, which weakens the symlink-escape check. Treat it as
      unreadable (skip, or throw when strict).
- [x] Warn when an env file is group- or world-readable (`mode & 0o077`). Log
      the path only — never a value, name, or length.

### D. Config precedence (`src/config.ts`, `src/user-config.ts`)

- [x] Add `parsePartialOptions(raw): Partial<PluginOptions>` in `config.ts` that
      validates only the keys actually present and fills no defaults. Keep
      `parseOptions` as the full-defaults parser for the packaged base layer.
- [x] Have `parseDocument` (user file) and the plugin-override path use
      `parsePartialOptions`, then merge packaged ← user ← overrides.
      **Current bug:** `parseOptions(overrides)` fills every default and is
      spread *after* `user`, so `~/.config/kilo/secret-redactor.json` is
      silently ignored — `"scannerMode": "disabled"` still runs as `required`,
      and `minValueLength`, `scannerTimeoutMs`, `autoEnvFiles`, `unredactTools`
      are all reset.
- [x] Drop the `plugin.disabledTypes.size ? ... : ...` and
      `disabledScannerRules` heuristics in favour of presence checks. This also
      makes an explicit `[]` mean "disable nothing", which is currently
      inexpressible.
- [x] Keep `order` / `whitelist` / `blacklist` precedence as-is (overrides →
      user → packaged); they already use presence checks via
      `pluginOrder`/`parsePluginRules`.

### E. Capture-group validation (`src/patterns.ts`)

- [x] Replace the `compiled.source.match(/\((?!\?)/g)` heuristic with an
      accurate count derived from the compiled regex, e.g.
      `(new RegExp(`${source}|`).exec("")?.length ?? 1) - 1`.
      Current behaviour: named groups `(?<name>…)` are not counted at all (so
      any rule using one is rejected with "capture group does not exist"), while
      escaped `\(` and `(` inside a character class are miscounted as groups.
- [x] Confirm every packaged rule in `secret-redactor.default.json` still parses
      (the `captureGroup: 1` rules at lines 94, 160, 286, 292, 395 and the
      lookbehind email rule at line 362).

## Tests to add

Mirrors the "Tests to add when behavior changes" list in `AGENTS.md`.

- [x] Scanner reuses one `cwd` across scans: `workdirFactory` called once for N
      scans; `dispose()` removes the directory; `dispose()` twice is safe.
- [x] Scan retries once after an `ENOENT` spawn failure and fails cleanly on a
      second failure.
- [x] `spawnProcess` rejects with an error (no crash) when the command cannot be
      spawned.
- [x] `assertExecutable` rejects a directory that has the execute bit set.
- [x] `resolveBetterleaks` ignores relative `PATH` entries.
- [x] `discoverRootEnvFiles` returns `[]` on an unreadable worktree when not
      strict and throws when strict.
- [x] A directory listed in `envFiles` is skipped (strict) or rejected. A FIFO
      is covered by the same `isFile()` guard; no named-pipe fixture is created
      because a blocked `readFile` would hang the suite.
- [x] An oversized env file is skipped.
- [x] User-file `scannerMode: "disabled"` survives with `overrides = {}` and
      with `overrides = undefined`; a tuple override still beats the user file;
      user-file `minValueLength` / `disabledTypes` are honoured; explicit
      `disabledTypes: []` disables nothing.
- [x] `parseRule` accepts a named-capture-group rule with `captureGroup: 1` and
      still rejects an out-of-range group for patterns containing `\(` or
      `[()]`.
- [x] Existing invariant tests keep passing: `request.cwd !== process.cwd()`,
      `SCAN_ARGS` unchanged, `BETTERLEAKS_CONFIG` stripped, no
      `validation|verbose|--redact` flags.

All fixtures stay synthetic; no prompt is sent to a provider.

## Risks

- `SecretScanner` gains `dispose()`. It is exported from `src/index.ts`, so any
  external implementer must be updated — keep the change additive and consider
  an optional method if compatibility matters.
- Reusing one directory across concurrent scans is safe (it stays empty and is
  only read by the child), but deletion must happen exclusively in `dispose`.
- The config-precedence fix changes effective behaviour for anyone who already
  has `~/.config/kilo/secret-redactor.json`: settings that were being ignored
  start taking effect. Notably a user file with `scannerMode: "optional"` or
  `"disabled"` will finally apply. Call this out in the commit message.
- Accurate capture-group counting is slightly more permissive; the packaged
  rules must be re-validated (step E).

## Validation

Run from `/home/xell/gitlab/kilo/plugins/privacyfilter`:

- [x] `npm run typecheck`
- [x] `npm test` — 98 passed
- [x] `npm run lint`
- [x] `npm run build`
- [x] `BETTERLEAKS_BIN=/home/xell/bin/betterleaks npm test -- src/secret-scanner.test.ts`
      (real stdin integration path)
- [x] `node scripts/bench-hot-path.mjs` — no hot-path regression (mask-new-many
      0.31 ms, rules-cached 1.36 ms, vault-index-bounded 2.02 ms). The per-scan
      `mkdtemp`/`rm` pair is gone; the benchmark does not exercise it.
- [x] Verify the packaged config loads from an unrelated cwd (ESM and CJS), the
      regression that `shims: true` + `import.meta.url` already fixed
- [ ] Live check in Kilo: reload, confirm
      `rg 'level=WARN message="Redacted' ~/.local/share/kilo/log/opencode.log`
      still reports redactions and no raw secret appears in the log

## Out of scope

- ReDoS beyond the existing `MAX_REGEX_LENGTH` cap (no timeout or safe-regex
  engine). Noted in review; not addressed here.
- Placeholder-collision hardening (session-unique token prefixes) when input
  already contains `🔒…🔓` text.
- Passing rules via `GITLEAKS_CONFIG_TOML` instead of relying on the neutral
  `cwd` — it would not remove the directory requirement (ignore files are still
  read from `cwd`) and the fork's env-var names need verification against the
  real binary.
- Publishing to npm or pushing to any remote.
