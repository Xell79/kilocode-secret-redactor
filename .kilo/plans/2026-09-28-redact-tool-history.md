# Redact tool output stored in message history

## Goal

Secrets that Kilo reads via tools (Read and others) must be replaced
with placeholders before the provider call. Today
`experimental.chat.messages.transform` only rewrites `type: "text"`
parts, so completed tool results in `state.output` reach the model
unchanged.

## Steps

- [x] Rewrite every string field the model sees on a history part:
  text, tool `state.output`, `state.error`, and string
  `state.input` values
- [x] Leave non-string metadata (paths, counts, truncated flags) untouched
- [x] Cover a completed `read` tool part in `plugin.test.ts`
- [x] Note the history shape in README Hooks
- [x] Run typecheck and tests

## Notes

Kilo 7.8.1 `toModelMessages` sends `state.output` and `state.input`
of completed tool parts. `tool.execute.after` already mutates the live
result before it is saved, but history reload and any path that skips
that mutation still leak through `messages.transform`.
