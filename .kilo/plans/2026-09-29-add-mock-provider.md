# Add Mock Provider to Kilo and Test Outbound Redaction

## Goal

Add the local mock provider (`http://127.0.0.1:8787/v1`) to `/home/xell/.config/kilo/kilo.json`,
start the background capture server, and run a test query via Kilo targeting `mock/mock-model`
to verify that requests arrive at the stub with redaction placeholders intact.

## Steps

- [x] Backup `/home/xell/.config/kilo/kilo.json`
- [x] Add the `mock` provider to `/home/xell/.config/kilo/kilo.json`
- [x] Verify `kilo.json` parses as valid JSON
- [x] Start `node dist/capture-server.js` in background
- [x] Execute a test prompt with Kilo targeting `mock/mock-model`
      containing a synthetic secret
- [x] Inspect captured request in `capture/*.json` or via `curl http://127.0.0.1:8787/v1/captures/latest`
- [x] Verify synthetic secret was redacted to placeholder in model request body
- [x] Background capture server active and running for testing

## Notes

- Port: 8787
- Provider ID: `mock`
- Model ID: `mock-model`
- Full model string for Kilo: `mock/mock-model`
