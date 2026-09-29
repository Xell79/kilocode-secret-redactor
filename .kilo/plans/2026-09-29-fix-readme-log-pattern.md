# Fix Log Search Pattern in README

## Goal

Update the log verification command examples in `README.md` to account for the
`run=<id>` attribute between `level=WARN` and `message="Redacted..."` in Kilo logs.

## Steps

- [x] Update `rg` commands in `README.md` to use `'level=WARN .*message="Redacted'`
- [x] Update expected log line description to include `from model context`
- [x] Run linter subagent to verify clean Markdown formatting
- [x] Commit and push the fix
