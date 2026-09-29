# Add Versioning, Update Docs and Gitignore

## Goal
Add programmatic versioning to the package (version bump to 0.7.0, `VERSION` constant export, `package.json` / `package-lock.json` sync), update documentation markdown files (`README.md`, `AGENTS.md`), modernize `.gitignore`, verify via test suite and linter, then commit and push.

## Steps
- [x] 1. Add versioning to package:
  - [x] Bump version in `package.json` and `package-lock.json` to `0.7.0`
  - [x] Create `src/version.ts` exporting `VERSION = "0.7.0"`
  - [x] Export `VERSION` in `src/index.ts` and `src/plugin.ts`
  - [x] Add unit test in `src/pipeline.test.ts` verifying `VERSION` matches `package.json`
- [x] 2. Update `.gitignore`:
  - [x] Add editor artifacts (`.vscode/`, `.idea/`), OS files (`.DS_Store`, `Thumbs.db`), logs (`*.log`), local test coverage (`coverage/`), downloaded betterleaks release artifacts (`betterleaks`, `betterleaks_*`, `checksums.txt`)
- [x] 3. Update markdown documentation:
  - [x] Update `README.md` to document new features: version export, partial config layering behavior, worktree handling, env file size limit and permissions, scanner lifecycle / directory reuse
  - [x] Update `AGENTS.md` layout, invariants, test suite details (98+ tests), and description of scanner disposal and workdir management
- [x] 4. Build, test and lint:
  - [x] Run `npm run typecheck`
  - [x] Run `npm test`
  - [x] Run linter subagent
  - [x] Run `npm run build`
- [x] 5. Commit and push:
  - [x] Review `git status` and `git diff`
  - [x] Verify git author/committer ident
  - [x] Create clean commit with concise message
  - [x] Push to `origin/main`

## Notes
- Keep opaque redaction placeholders (e.g. `xell79@gmail.com`) intact.
- Never commit secrets, session files, or build artifacts.
