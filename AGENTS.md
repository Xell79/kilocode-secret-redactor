# AGENTS.md

Kilo-only secret redaction plugin. It replaces sensitive spans
with session-local placeholders before model calls and restores
them only for approved local tools.

Do not publish, push, or commit unless the user asks.
Do not commit a home `secret-redactor.json`, project
`.env*` files, session JSON, build output, or tool caches.
`.gitignore` covers those paths.

## Layout

- `src/plugin.ts` — Kilo `{ id, server }` module and hooks.
- `src/user-config.ts` — loads `secret-redactor.default.json`,
  then `~/.config/kilo/secret-redactor.json`,
  then Kilo tuple overrides.
- `src/patterns.ts` — rule schema and comments for adding
  JSON rules. Runtime rules are not the old in-source array.
- `src/detector.ts` — global regex match with capture-group
  spans.
- `src/redactor.ts` — stage order, masking, span replacement.
- `src/secret-scanner.ts` — Betterleaks stdin adapter.
  No `--validation`, no decode, no archive scan,
  no project config.
- `src/env-values.ts` — exact values from worktree-root `.env*`.
- `src/spans.ts` — UTF-16 span merge, mask, and replacement.
- `src/vault.ts` — in-memory per-session map.
- `scripts/bench-hot-path.mjs` — local hot-path benchmark.
  It is not part of the npm package.

## Dependencies

- Node.js 20+ and npm.
- Kilo CLI 7.7.9+ for a real load.
- Betterleaks >= 1.8.1 on `PATH` or `betterleaksPath`,
  unless `scannerMode` is `disabled`.

```bash
npm ci
npm run typecheck
npm test
npm run lint
npm run build
```

Install Betterleaks from its release with `checksums.txt`
before trusting the binary. `brew install betterleaks` and
`sudo dnf install betterleaks` are the packaged options.
Do not add a postinstall download.

`BETTERLEAKS_BIN=/absolute/path/betterleaks npm test`
runs the real stdin integration test.
Without that variable the test is skipped.

## Config

Default stage order is `whitelist`, `blacklist`, `betterleaks`.
Matching is global on each string, not per line and not
first-match-wins. An earlier stage owns its spans;
later stages scan a masked copy and can still redact
other spans.

`scannerMode`: `required` (default), `optional`,
or `disabled`. `disabled` must not resolve or spawn
Betterleaks. `required` aborts when Betterleaks is
missing or a finding cannot be mapped onto an
unoccupied literal span.

User rules belong in
`~/.config/kilo/secret-redactor.json`
(`KILO_CONFIG_DIR` or `XDG_CONFIG_HOME` when set).
Do not read a project-owned pattern file.
Do not create the user file automatically.

A JSON rule is
`{ "id", "label", "regex", "flags", "captureGroup" }`.
`regex` is the JavaScript source without slashes
and must be at most 500 characters. Allowed flags
are `i`, `m`, `s`, `u`. `captureGroup` defaults to 0
and must be the secret span. Whitelist spans are sent
to the provider unchanged. The length cap is the
ReDoS guard; do not add a nested-quantifier heuristic
that rejects the packaged patterns.

## Install and uninstall

Local install is a `file://` entry in the Kilo `plugin`
array. `kilo plugin <npm-name> --global` is only for a
published package. `kilo plugin --force` replaces
that npm entry.

Uninstall by deleting only this plugin entry and
restarting Kilo. `kilo uninstall` removes Kilo itself;
never use it to remove this plugin. Cache cleanup
must target only this package directory.

## Invariants

- Never log raw secrets, findings, env values,
  scanner stdout, or restored arguments.
- Never enable Betterleaks live validation or
  recursive decoding.
- Never restore placeholders into `webfetch`, MCP,
  or unknown tools.
- Keep vaults per `sessionID` and clear them on
  `session.deleted` and `dispose`.
- Redact by source span. Do not replace every copy
  of a string when one copy was whitelisted.

## Tests to add when behavior changes

- Scanner CLI flags, cwd, and stripped config environment.
- Overlap winners for both `order` permutations that matter.
- Masked Betterleaks input that cannot contain
  earlier-stage text.
- `disabled` mode never calling resolve, health check,
  or scan.
- Invalid JSON, duplicate ids, bad flags, and
  capture groups.
- Cache keys that change when masked text or
  rule settings change.

Smoke tests must use synthetic secrets and must not
send a prompt to a provider.
