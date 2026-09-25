# Memory and CPU Optimization Plan

## Goal

Reduce allocation and CPU overhead in the redaction hot path while preserving UTF-16 span semantics, configured stage precedence, session isolation, scanner masking, and existing security behavior.

## Scope And Priorities

1. Optimize confirmed hot paths first: occupied-text masking, regex compilation, and repeated vault rescans.
2. Add focused benchmarks and regression tests before/alongside each change.
3. Avoid speculative algorithm changes until measurements show they matter. Dynamic `import()` and the string-only `redactDeep` wrapper are secondary cleanup items, not primary performance work.

## Implementation Steps

### 1. Establish a reproducible baseline

- Add a local benchmark or benchmark test covering:
  - 1 MB text with 0, 1, and many occupied spans.
  - 20-50 configured rules over short and large text values.
  - A session vault containing 100, 1,000, and the configured maximum mappings.
  - Repeated and overlapping secret values.
- Measure wall time and, where practical, heap allocation/GC using the project-supported Node/Bun tooling.
- Do not include real secrets or provider calls in benchmarks.
- Record baseline results in the plan or benchmark output without asserting fixed percentage gains before measurement.

### 2. Replace per-character masking allocation

- Rework `maskOccupied` in `src/spans.ts` to build the masked string from unchanged slices and same-length space runs, after sorting/merging occupied intervals for the mask operation.
- Keep JavaScript UTF-16 offsets exactly unchanged. Do not split or normalize spans; surrogate pairs must remain two UTF-16 code units when not occupied.
- Preserve behavior for unsorted, adjacent, duplicate, out-of-range, and empty spans.
- Add tests for non-BMP text, adjacent spans, overlapping spans, unsorted spans, and exact output length.
- Benchmark the new implementation against the current implementation on 1 MB inputs.

### 3. Compile and validate regex rules once

- Move regex compilation and load-time validation out of `matchRules`' per-text/per-call path.
- Prefer storing a compiled matcher alongside each validated `PatternRule` during config parsing, or use a cache keyed by the immutable parsed rule object if the public JSON-facing type must remain unchanged.
- Ensure every `exec` loop resets `lastIndex` before use because matchers remain global.
- Preserve the `d` indices flag, capture-group validation, disabled category behavior, global matching, and all existing error messages/security bounds.
- Ensure user config edits still take effect without rebuilding: a newly loaded config must receive newly compiled matchers and must not reuse stale compiled rules by rule ID alone.
- Add a test/spying hook or benchmark assertion that repeated scans do not construct a new `RegExp` for the same parsed rule.
- Benchmark rule-heavy repeated scans before and after the change.

### 4. Avoid scanning the entire vault for every text value

- Add an internal vault lookup index suitable for redaction, while keeping the existing session-local value-to-token semantics and public vault behavior.
- At minimum, skip stored values whose UTF-16 length exceeds the current text length before calling `indexOf`.
- Prefer a length-bucket or prefix index when it can be implemented without changing placeholder allocation, duplicate-value handling, or session cleanup behavior.
- Maintain deterministic replacement order and exact occurrence handling:
  - Only unoccupied occurrences are accepted.
  - A whitelist span must still protect its occurrence.
  - Identical values in different mappings must not change existing vault semantics.
  - `clear()` must release all index structures.
- Add tests for long stored values, duplicate values, many mappings, repeated occurrences, and clearing a session.
- Benchmark short text against vaults with 100, 1,000, and maximum mappings to verify the index improves the common case.

### 5. Reduce avoidable hook overhead after measurement

- Replace repeated dynamic `import("./redactor.js")` calls in `src/plugin.ts` with static imports only if the benchmark/profile shows measurable hook overhead and the bundle remains valid for both ESM and CJS builds.
- In `redactParts`, call `redactString` directly for known text parts if this removes measurable object traversal/allocation without duplicating behavior needed by nested tool outputs.
- Keep `redactDeep` for arbitrary tool output structures and preserve all hook restoration restrictions.
- Add or retain built-module import tests after any import-graph change.

### 6. Re-evaluate interval scans only if benchmarks justify them

- If overlap checks or `locateUnoccupied` remain material after steps 2-4, introduce a sorted interval helper with binary search or a moving cursor.
- Keep the helper span-based and UTF-16 based; do not use substring replacement or value-based deduplication.
- Add randomized equivalence tests comparing the optimized interval implementation with the current straightforward implementation across unsorted and overlapping intervals.
- Do not add an interval tree or Aho-Corasick implementation without benchmark evidence that the simpler length/index approach is insufficient.

### 7. Validation and security checks

- Run focused tests for masking, rule matching, vault behavior, whitelist/blacklist overlap, scanner masking, and session cleanup.
- Run full `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.
- Run the Betterleaks integration test with `BETTERLEAKS_BIN` set.
- Run ESM, CJS, and Bun import checks plus the synthetic plugin hook smoke test.
- Verify no raw secrets, home config, session JSON, benchmark fixtures containing secrets, or generated artifacts are added to the package or repository.
- Compare benchmark results with the baseline and record memory/CPU deltas and any residual bottleneck.

## Correctness Invariants

- All spans use JavaScript UTF-16 offsets.
- Earlier-stage spans remain invisible to later stages through same-length masking.
- Whitelist spans are never inserted into the vault or replaced, but identical values at other unwhitelisted occurrences remain redactable.
- Required scanner failures abort before transformed text reaches the provider; optional failures are not cached as successful empty scans.
- Session vaults, caches, and indexes remain isolated and are cleared on session deletion and dispose.
- Runtime JSON edits remain effective without rebuilding the plugin.

## Risks And Decisions

- `maskOccupied` must not use a code-point array or any representation whose indexes differ from UTF-16 offsets.
- Regex caching must be tied to parsed rule identity/settings, not only an ID, so runtime edits cannot reuse stale matchers.
- Vault indexing increases session state complexity; prefer a small, measurable index and preserve `maxMappings` as the memory bound.
- A benchmark harness must not become a production dependency or package artifact.
- Do not optimize based solely on theoretical O-notation; retain simple code where profiling shows the path is insignificant.

## Results (2026-09-25)

`node scripts/bench-hot-path.mjs`, two runs, Node, synthetic values only:

- Mask 1,000,004 UTF-16 chars with 200 spans: old per-character array 32.2-36.1 ms and about 9.7 MB heap delta; new slice/space-run mask 0.51-0.58 ms and about 0.1 MB.
- 40 rules, 20 passes: recompile 3.43-3.63 ms; cached matcher 1.13-1.44 ms. Matchers are cached per parsed rule object, and `lastIndex` resets at the start of each scan.
- Vault with 9,000 long and 1,000 short values against a 20-character text: full scan 7.4-7.64 ms; length filter 2.52-3.66 ms. At 1,000 mixed values the filter was slower, so this is a large-vault improvement, not a small-vault one.
- Dynamic `import()` and interval-tree/binary overlap search were not changed. The measured hot paths were masking, regex compilation, and large vault scans.
- Validation: 87 tests, typecheck, lint, build, Betterleaks stdin test (6), and ESM/CJS/Bun imports passed.

## Completion Criteria

- Benchmarks show measured CPU/allocation improvement for the confirmed hot paths or document why a proposed optimization was rejected.
- Existing behavior and all correctness invariants remain covered by tests.
- Full validation passes with no new critical/high security findings.
- The final benchmark results and residual risks are recorded in this plan.
