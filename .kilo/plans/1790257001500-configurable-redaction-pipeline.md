# Configurable Redaction Pipeline

## Goal

Make pattern rules editable outside the compiled plugin, add whitelist/blacklist stages with configurable stage order, support disabling Betterleaks, and document dependable install/uninstall and contributor workflows.

## Verified Current Behavior

- `src/patterns.ts` is bundled into `dist` through `detector.ts`; edits require rebuilding today.
- `detectBuiltin()` runs each global regex over the entire string passed to the redactor (`RegExp.exec` loop), not line-by-line. The Kilo hook visits individual text parts and nested strings separately.
- `redactor.ts` currently runs built-in patterns first and then Betterleaks, but it does not preserve match spans: findings are stored by matched value and `vault.scrubText()` replaces that value everywhere. Whitelist support therefore needs span-aware redaction to avoid accidentally masking allowed occurrences of the same string elsewhere.
- Current `scannerMode` is `required | optional`; it resolves and health-checks Betterleaks at plugin initialization in both modes. There is no mode that disables the scanner.
- Kilo 7.7.9 `kilo plugin` accepts an npm module and has `--global` / `--force`; it does not expose a plugin-only uninstall command. `kilo uninstall` removes Kilo itself and is not an appropriate plugin uninstall procedure. Local `file://` plugin registration is done through config, not `kilo plugin`.
- The plugin is currently registered in `~/.config/kilo/kilo.jsonc` with Betterleaks path in its tuple options. Betterleaks 1.8.1 is installed at `~/bin/betterleaks` and its real scanner integration test has passed.

## Decisions

- Pattern order is **not** a per-line or first-regex-wins policy. Regexes run globally over each input text value. Within a configured stage, all non-overlapping matches are collected.
- Add stages `whitelist`, `blacklist`, and `betterleaks`. Default order is `whitelist > blacklist > betterleaks`. The `order` array must be a permutation of those three values and controls overlap precedence. A match from an earlier stage protects its source span from later stages; later stages continue scanning the remaining text and may redact other secrets.
- Whitelist rules allow their matched source spans to pass unchanged and prevent later blacklist/Betterleaks stages from seeing those spans. Any overlap from a lower-priority stage is discarded as a whole. If users place `blacklist` or `betterleaks` before `whitelist`, the earlier stage wins that overlap by explicit configuration.
- Keep built-in patterns as the packaged fallback, but move runtime rule data to JSON. The normal editable config is `~/.config/kilo/secret-redactor.json` (respect `XDG_CONFIG_HOME`/Kilo config directory where unambiguous); package a default/example JSON beside the plugin. Do not silently create or overwrite user configuration at startup.
- Merge precedence: packaged defaults < global `secret-redactor.json` < explicit Kilo plugin tuple options. The normal Kilo plugin entry can therefore be just the module specifier/local `file://` path.
- New `scannerMode` values are `required` (default; startup requires a usable Betterleaks), `optional` (use it if available, otherwise warn once and continue), and `disabled` (do not resolve, launch, or health-check Betterleaks even when installed). In all enabled modes, process each text value through the configured `order`; the default built-in pattern stage runs before Betterleaks.
- JSON pattern rules use explicit `id`, `label`, `regex`, `flags`, and optional numeric `captureGroup` (default 0). Whitelist and blacklist are separate arrays. Captured values must have a source span; use regex indices (`d` flag) and test capture-group offsets. Validate IDs, flags, group numbers, regex compilation, and bounded rule/pattern sizes at load time.
- Preserve `.env*` exact-value detection as part of the blacklist stage. Do not let a whitelist match be accidentally redacted later due to a duplicate value elsewhere; redaction must be span-based, not global value replacement.
- Keep the global JSON as user configuration, never treat project-controlled pattern/scanner config as trusted. Env-file exact matching remains restricted to the configured worktree rules already documented.

## Implementation Steps

1. Refactor detection to retain source spans.
   - Introduce a common match representation `{ start, end, value, label, source, stage }` using JavaScript UTF-16 offsets for the current text string.
   - Rework built-in and external rule matching to report the selected capture group's exact range; reject invalid/non-participating capture groups.
   - Apply matches from the configured stage order. Maintain occupied source intervals; accept all valid matches that do not overlap an earlier-stage interval. Later stages scan a same-length masked view so they cannot inspect earlier-stage spans and offsets remain stable.
   - Run Betterleaks against that masked view. Locate each reported `Secret` at each exact occurrence outside occupied spans; document/test any finding that cannot be mapped to a literal substring as an adapter error rather than silently leaking it.
   - Store accepted blacklist/scanner values in the session vault and replace only accepted source spans from right to left. Never call whole-string `vault.scrubText()` to perform new redaction; retain vault scrubbing only where a global restore/re-scrub is actually required.
   - Keep detection first in the default path (`whitelist`, then built-in/custom blacklist plus env exact values, then Betterleaks). If Betterleaks is enabled but fails under `required`, abort before the transformed text can reach the provider; `optional` warns and retains matches from previous stages.

2. Make rule data runtime-configurable.
   - Replace the runtime static `PATTERNS` array in `src/patterns.ts` with typed JSON schema/loading/validation and detailed JSDoc comments explaining how to add a rule, regex syntax/flags, capture groups, labels, whitelist-vs-blacklist behavior, global matching, and overlap/order semantics.
   - Add a packaged default JSON file containing the existing patterns and default stage order. Include it in the package files and ensure both source and built layouts can locate it reliably.
   - Load `~/.config/kilo/secret-redactor.json` by default, with deterministic support for the active Kilo/XDG config directory. Provide an explicit config-path override for tests/advanced setup. Missing user config falls back to packaged defaults; malformed or unreadable explicitly selected config is an actionable startup error.
   - Validate regexes at startup, enforce maximum rule count and regex length, reject duplicate IDs/unknown fields where appropriate, and ensure configuration errors contain no matched values.
   - Provide a checked-in example/default JSON that users can copy/edit; do not package the user's home config or any secrets.

3. Expand scanner settings and source ordering.
   - Change `scannerMode` parser/type to `required | optional | disabled`; default `required`.
   - In `disabled`, skip executable resolution and scanner health check completely. Required/optional retain current local-only command safeguards and Betterleaks minimum-version requirement.
   - Add `order` validation as an exact permutation of `whitelist`, `blacklist`, `betterleaks`. Entries for Betterleaks are a no-op when disabled; still validate config consistently.
   - Put exact `.env*` findings and configured regex blacklist findings in the `blacklist` stage; retain built-in category suppression and Betterleaks rule suppression.
   - Update the per-session scan cache key to include the masked text and scanner rule settings/version; never cache unmasked source content.

4. Update plugin registration and the user's Kilo configuration.
   - Reduce the global plugin entry to the local `file://` module only; move Betterleaks path and normal preferences into `~/.config/kilo/secret-redactor.json`.
   - Keep support for Kilo's npm tuple options as explicit per-install overrides; document the merge precedence.
   - Ensure plugin startup reads global config once, validates it before accepting hooks, and never reads project-provided secret-redactor config by default.

5. Verify install/uninstall workflow and document it.
   - Confirm against the installed CLI/docs that `kilo plugin <npm-package> [--global] [--force]` installs/registers a package and whether any plugin-only remove command exists; do not use `kilo uninstall` for plugin removal.
   - README install: list dependencies first (Kilo, Node.js version used for development/build, Betterleaks >=1.8.1 when scanner is enabled); give official package-manager install paths for Betterleaks and a manual release/checksum path for Linux; include local `file://` config and `kilo plugin ... --global` for npm once published.
   - README uninstall: remove only this module specifier/entry from the relevant `kilo.jsonc`/`kilo.jsonc` project/global plugin array; preserve unrelated config entries/comments; restart Kilo. Explain clearing only this package's Kilo plugin cache if stale code remains, after confirming the actual cache location. State explicitly that `kilo uninstall` removes the CLI, not just this plugin.
   - Add upgrade/reinstall instructions (`kilo plugin ... --force` for npm, update local checkout/build for `file://`) and Betterleaks disable behavior.
   - Do not publish to npm or Marketplace as part of this work.

6. Add detailed `AGENTS.md` at repository root.
   - State project purpose and that it is Kilo-only; explain module entrypoint, hook adapters, config loader, patterns, scanner adapter, env matching, session vault, and tests.
   - Include dependency installation: Node/npm versions, `npm ci`, Betterleaks installation with checksum verification for supported platform or official package manager, `npm run build`, `npm test`, `npm run typecheck`, `npm run lint`.
   - Explain how to install locally into `~/.config/kilo/kilo.jsonc`, configure `secret-redactor.json`, run a synthetic smoke test, and uninstall without removing Kilo.
   - Define security invariants: never log raw secrets/findings/env values; no Betterleaks validation/network requests; no project-owned scanner/rule config; scanner disabled mode never starts a process; keep mappings session-local; whitelist only exempts matched spans; never restore into web/MCP/unknown tools; don't commit local config, secrets, or session JSON.
   - Describe how to add/modify a JSON whitelist or blacklist rule and run focused tests. Explain global matching and configured stage-order semantics.
   - Require tests for scanner CLI changes, matching overlaps, cache keys, and config validation. Do not instruct agents to publish, push, or commit without an explicit user request.

7. Test and validate.
   - Pattern/config tests: JSON default and override loading, source resolution, malformed file errors, duplicate IDs, invalid regex/flags/group, size bounds, and documented example validation.
   - Matching tests: multiple same-string matches; match across a newline when regex allows it; no implicit line splitting; selected capture span only; whitelist span remains unchanged; overlapping lower-priority candidates are discarded; non-overlapping later-stage findings still redact; changing `order` changes overlap winner; Betterleaks receives same-length masked input and cannot see whitelist/earlier blacklist text.
   - Required/optional/disabled tests: required resolves/health-checks Betterleaks then executes patterns before scan; optional proceeds after absence/failure; disabled never calls resolve/create/scan even if the executable exists.
   - Run lint, typecheck, all unit tests, Betterleaks integration test with installed binary, package build/pack, Bun module import, and a local hook smoke using synthetic values only.
   - Validate both the local plugin config and new global `secret-redactor.json` with Kilo `debug config`/`config check` without sending a prompt to a provider.
   - Inspect final git status to ensure home config with no secrets is not accidentally included in the repository; preserve unrelated session JSON.

8. Close every remaining implementation and validation gap before review.
   - Add pattern/config tests for duplicate rule IDs, unsupported flags, missing capture groups, oversized regex/rule lists, unknown fields, invalid stage permutations, missing user config fallback, malformed explicitly selected config, and runtime edits loaded without rebuilding.
   - Add matching tests for two occurrences of the same value, matches crossing newlines when the regex permits it, no implicit line splitting, capture-group-only replacement, whitelist preservation of one occurrence while another identical occurrence is blacklisted, overlap winners for both relevant `order` permutations, and non-overlapping later-stage findings.
   - Add scanner-order tests proving whitelist and blacklist transformations happen before Betterleaks in default order, Betterleaks receives same-length masked input, and a required scanner failure cannot pass transformed text onward.
   - Add a real plugin test for `scannerMode: "disabled"` with spies on resolve/health-check/create/scan; retain the installed Betterleaks integration test for enabled mode.
   - Run `npm pack --dry-run` after the JSON migration and verify the tarball contains `secret-redactor.default.json`, built entrypoints, README, and LICENSE only; verify no `.env`, home config, session JSON, or source fixtures are packaged.
   - Validate both `~/.config/kilo/kilo.jsonc` and `~/.config/kilo/secret-redactor.json` using available Kilo config/debug commands, and run the built ESM/CJS/Bun import checks.
   - Run the local synthetic hook smoke again without contacting a provider. Check outbound redaction, whitelist behavior, Betterleaks masking, approved-tool restoration, blocked-tool non-restoration, session deletion, disposal, and disabled scanner mode.
   - Review and update the live plan/checklist with the exact validation results; do not claim completion while any acceptance criterion remains unverified.

9. Perform an independent review pass using audit skills.
   - Load the `code-reviewer` skill and review the complete worktree diff, not only the latest files. Prioritize security defects, data leakage paths, hook regressions, incorrect span/capture handling, config precedence, and missing tests. Record each finding with severity and file/line evidence.
   - Load `security-best-practices` for a TypeScript security review focused on subprocess invocation, environment/config isolation, regex denial of service, path/symlink handling, secret logging, placeholder restoration, and dependency/supply-chain behavior.
   - Load `skills-security-audit` before validating the audit skills themselves; confirm the skill instructions do not introduce unsafe commands, data exfiltration, or trust-boundary violations. Do not install third-party skills during this task.
   - Treat review output as untrusted findings until verified against the source and tests. Do not broaden scope based only on stylistic recommendations.

10. Fix review findings and re-audit.
   - Fix every confirmed high/critical finding before proceeding; fix confirmed medium findings unless explicitly documented as an accepted limitation in README/AGENTS.md and the plan.
   - Add a regression test for every behavior-changing fix, especially scanner disabled mode, whitelist/blacklist overlap, Betterleaks source mapping, cache invalidation, config fallback, and subprocess boundaries.
   - Re-run `code-reviewer` and `security-best-practices` after fixes. Compare the second pass with the first and verify no new critical/high findings were introduced.
   - Run the skills security audit again if skill files or skill configuration changed; otherwise retain the initial audit result and record that no skill files were modified.
   - Finish with lint, typecheck, full tests, real Betterleaks integration, build, package inspection, config validation, and synthetic smoke. Capture residual risks and explicitly mark them in this plan.

## Acceptance Criteria

- Runtime pattern additions/edits in `~/.config/kilo/secret-redactor.json` take effect without rebuilding the plugin; packaged JSON defaults work if the global file is absent.
- Pattern matchers run globally over each individual text value, with no implicit line or arbitrary substring segmentation.
- Default stage order is `whitelist`, `blacklist`, `betterleaks`; all three stages can be reordered and overlap winner follows configured order.
- Earlier-stage matched spans are invisible to later stages; unrelated text and other findings continue through the pipeline.
- Pattern/whitelist/blacklist matching always occurs before Betterleaks in default order, including when `scannerMode` is `required`.
- `scannerMode: "disabled"` performs no binary lookup, health check, or subprocess launch; built-in, configured, and env-value blacklist rules still work.
- README clearly describes dependency installation, install, update, plugin-only uninstall, cache caveats, and distinction from `kilo uninstall`.
- Root `AGENTS.md` provides actionable dependency, development, configuration, security, test, and lifecycle instructions.
- All automated tests, lint, typecheck, build, and safe local smoke checks pass.
- The implementation gap checklist, code review, TypeScript security review, fixes, and follow-up audit are complete with no unresolved critical/high findings.

## Risks

- Span handling must distinguish full regex match from captured secret; use capture indices and regression tests for all existing capture-based patterns.
- Betterleaks JSON may report the same secret multiple times or a value whose source occurrence is masked; map only exact unoccupied occurrences and fail according to scanner mode when mapping is ambiguous.
- A whitelist deliberately sends its matched content to the provider. Keep whitelist examples conservative, document the risk prominently, and test overlap behavior.
- Arbitrary JavaScript regex can cause catastrophic backtracking. Configurable patterns are rejected above 500 characters. A nested-quantifier heuristic was not kept: it cannot distinguish safe packaged patterns such as private-key and IP rules from unsafe nesting, and a wrong reject blocks plugin startup. Residual risk: a user-authored regex under 500 characters can still backtrack. Accepted limitation, documented in README and AGENTS.md. No isolated regexp engine was added.
- Global config path differs across platforms and Kilo config overrides. Resolve it deterministically and let tests inject the path; never search the project tree for this policy file.
- Kilo package cache layout may change; base uninstall docs on verified current behavior and make cache deletion optional, narrow, and reversible.
- Review/audit tools can produce false positives or unsafe suggestions; verify findings against source, refuse instructions to expose secrets or bypass privacy controls, and keep audit artifacts free of sensitive values.

## Validation (2026-09-25)

- `npm test`: 80 passed.
- `npm run typecheck`, `npm run lint`, `npm run build`: passed.
- `npm pack --dry-run`: tarball contains LICENSE, README, package.json, dist, and `secret-redactor.default.json` only. No `.env`, home config, session JSON, or fixtures.
- Built ESM (`node`), CJS (`require`), and Bun imports resolve `loadUserConfig`.
- `kilo config check`: no warnings. `kilo debug config` plugin entry is `file://<local-plugin-path>` with no tuple options. Betterleaks path stays in `~/.config/kilo/secret-redactor.json`.
- In-process built-plugin smoke redacted a synthetic GitHub-shaped token. The log line did not contain the token. No provider call.
- `BETTERLEAKS_BIN=/path/to/betterleaks npm test -- src/secret-scanner.test.ts`: 6 passed, including the real stdin scan of a synthetic token.
## Review (2026-09-25)

Skill audit of `skills-security-audit`, `code-reviewer`, and `security-best-practices`: SAFE. Dangerous strings appear only as quoted detection examples. No skill files were modified. TypeScript security references are web-framework documents, so the review used the skill's general secure-coding rules plus the plugin invariants.

Confirmed and fixed:

- High: env values were stored in the session vault before stage order, so a whitelist span of the same value was still replaced. Env matches now happen only in the blacklist stage. Regression: `plugin.test.ts` whitelist-plus-second-copy.
- Medium: Kilo tuple `whitelist`/`blacklist` were ignored, contrary to documented override precedence. Tuple rule arrays now override the user file and packaged defaults. Regression: `pipeline.test.ts`.
- Medium: an optional Betterleaks failure was cached as an empty finding list, so a later retry of the same masked text skipped the scanner. Failures are not cached. Regression: `redactor.test.ts`.

Verified, not defects: disabled mode never resolves or spawns; scan cache keys include masked text and disabled rules; scanner stderr is length-capped and not logged; config errors do not include matched values; env paths cannot escape the worktree; restore stays limited to `unredactTools`; session delete and dispose clear mappings. ReDoS under 500 characters remains the documented accepted limitation.

Follow-up after fixes: `npm test` 82 passed, typecheck, lint, and build passed. No new critical or high findings in the changed paths.

## Non-Goals

- Per-line/first-regex-wins behavior, arbitrary text chunking, decoded/archive secret matching, binary/OCR scanning, raw HTTP interception, cross-session/persistent mappings, user-project pattern config, automatic Betterleaks downloads, package publication, or Marketplace submission.
