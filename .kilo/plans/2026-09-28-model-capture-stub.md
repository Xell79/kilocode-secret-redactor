# Local model-request capture stub

## Goal

Run an OpenAI-compatible stub that Kilo can target, and keep the exact JSON body
of each model call on disk so redaction can be checked against what the provider
would have received.

## Steps

- [x] Add `src/capture-server.ts`: `/v1/models`, `/v1/chat/completions` (JSON
  and SSE), write one JSON file per request
- [x] Ignore `capture/` and document the Kilo provider snippet in the README
- [x] Test record + placeholder reply without a network provider
- [x] Typecheck and lint

## Notes

The stub does not call tools and does not forward the body. `capture/` can contain
secrets from the session under test; it stays untracked. Point Kilo `baseURL` at
`http://127.0.0.1:8787/v1` and restart Kilo.
