# kilocode-secret-redactor

Kilo plugin that keeps secrets and selected PII out of model
context. Detected spans are replaced with session-local
placeholders before a provider call. Originals stay in process
memory and are restored only for approved local tool arguments
and the final text shown to you.

This is a Kilo-only fork of
[opencode-secret-redactor](https://github.com/casonadams/opencode-secret-redactor).

## Dependencies

- Kilo CLI 7.7.9 or newer, with plugin support.
- Node.js 20 or newer and npm, only if you build this
  checkout. `npm ci` installs `dotenv` and the TypeScript
  toolchain.
- [Betterleaks](https://github.com/betterleaks/betterleaks)
  1.8.1 or newer when `scannerMode` is `required` or
  `optional`. Skip it when `scannerMode` is `disabled`.

Betterleaks stays local. The plugin never passes
`--validation`, so the scanner does not call secret
providers. Install it with a package manager or a
checked release:

```bash
brew install betterleaks
# or, on Fedora:
sudo dnf install betterleaks
```

Manual Linux x64 install of the pinned release:

```bash
gh release download v1.8.1 --repo betterleaks/betterleaks \
  --pattern 'betterleaks_1.8.1_linux_x64.tar.gz' --pattern 'checksums.txt'
sha256sum -c checksums.txt --ignore-missing
tar -xzf betterleaks_1.8.1_linux_x64.tar.gz
install -m 755 betterleaks "$HOME/bin/betterleaks"
betterleaks version
```

## Install

Local checkout, after `npm ci && npm run build` if you
are not running from source through Kilo's loader:

```json
{
  "plugin": ["file:///absolute/path/to/kilocode-secret-redactor"]
}
```

Published package, once it is on npm:

```bash
kilo plugin kilocode-secret-redactor --global
kilo plugin kilocode-secret-redactor --global --force
```

`kilo plugin` only accepts an npm module name.
It writes the entry into the Kilo config. A local
`file://` path is added by editing
`~/.config/kilo/kilo.jsonc` or the project config
yourself.

Most settings belong in
`~/.config/kilo/secret-redactor.json`, not in the
plugin tuple. Copy `secret-redactor.default.json`
there and edit it. The plugin does not create or
overwrite that file. If it is missing, the packaged
defaults are used. Kilo tuple options override the
JSON for the same keys.

```json
{
  "scannerMode": "required",
  "betterleaksPath": "/home/you/bin/betterleaks",
  "order": ["whitelist", "blacklist", "betterleaks"]
}
```

`scannerMode`:

- `required` — default. Betterleaks must be installed
  and healthy before any text is sent.
- `optional` — use Betterleaks when it works; otherwise
  keep whitelist, blacklist, and `.env*` matching.
- `disabled` — do not look up or start Betterleaks,
  even if the binary is on `PATH`.

## Detection

Each string is scanned as a whole. Rules are not applied
line by line, and the first matching rule does not stop
the rest of the text.

Default stage order is `whitelist`, then `blacklist`,
then `betterleaks`. `order` must list each stage once.
An earlier stage owns its matched spans; later stages
do not see those characters and can still redact other
spans. Putting `blacklist` before `whitelist` makes
the blacklist win overlaps.

Blacklist rules and exact values from root `.env*` files
redact. Whitelist rules pass their spans through
unchanged, including to the provider. `.env.example`,
`.env.sample`, and `.env.template` are skipped. `url`,
`ip_address`, and `ssh_public_key` are disabled by
default. Private keys stay enabled.

Add a rule to the JSON. See the comment at the top of
`src/patterns.ts` for fields. A change to the JSON does
not need a rebuild. Each `regex` is limited to 500
characters. That bound is the load-time guard against
catastrophic backtracking; it is not a full
regex-complexity proof. Rejected patterns fail startup
and are not executed.

Repository `.betterleaks.toml`, `.gitleaks.toml`, and
`BETTERLEAKS_CONFIG*` / `GITLEAKS_CONFIG*` are ignored.

## Uninstall

This does not use `kilo uninstall`. That command removes
the Kilo CLI, its config, and its data.

1. Delete only this plugin's string, or its two-element
   tuple, from the `plugin` array in
   `~/.config/kilo/kilo.jsonc` or the project `kilo.jsonc`.
   Leave every other entry.
2. Restart Kilo.
3. If an old npm build is still loaded, remove only that
   package's directory under Kilo's package cache and
   restart again. Do not delete the whole cache.
4. Optional: delete `~/.config/kilo/secret-redactor.json`
   and the Betterleaks binary. They are not removed with
   the plugin entry.

## Hooks

- `chat.message` and `experimental.chat.messages.transform`
  redact text before the model sees it.
- `tool.execute.after` redacts every tool's string output.
- `tool.execute.before` restores placeholders only for
  `bash`, `write`, and `edit` by default.
- `experimental.text.complete` restores placeholders in
  the final local response.
- `session.deleted` and plugin dispose drop that
  session's vault.

Binary and file parts are not scanned. Encoded secrets
are not decoded. `KILO_PURE=1` disables plugins entirely.

## Logging and Verification

The plugin logs through `client.app.log` with service
name `kilocode-secret-redactor`. It never logs secret
values — only counts and warnings.

| Message | When |
|---------|------|
| `Redacted N value(s) from chat` | A chat message contained secrets. |
| `Redacted N value(s) from model context` | Outbound history was redacted. |
| `Redacted N value(s) from tool output` | A tool result contained secrets. |
| `Betterleaks unavailable; …` | Scanner not found (optional mode only). |
| `Betterleaks scan failed; …` | Scanner error (optional mode only). |

If nothing is found, no line is written.

### Quick verification

After a restart, open a new chat and send a synthetic
token such as `ghp_` followed by 36 letters/digits.
You should see `🔒github_pat_1🔓` in place of the token
and this in the log:

Search only the warning lines the plugin writes.
A broader search for the service name also matches
permission logs that merely quote earlier commands:

```bash
rg 'level=WARN message="Redacted' ~/.local/share/kilo/log/opencode.log
```

`rg` has no follow mode. `-L` follows symlinks.
To watch new lines, including across log rotation:

```bash
tail -F ~/.local/share/kilo/log/opencode.log | rg --line-buffered 'level=WARN message="Redacted'
```

Expected: `Redacted 1 value(s) from chat` or
`from tool output`, with no raw token in the line.

### Silent when clean

The plugin logs only when it redacts something or when
a scanner warning fires. Absence of log lines means
nothing was found — not that the plugin failed to load.
To confirm the plugin is active, check startup logs:

```bash
rg "run=.*" ~/.local/share/kilo/log/opencode.log | head -20
```

Kilo loads the plugin silently at startup. A missing
Betterleaks with `scannerMode: "required"` prevents Kilo
from starting at all.

## Boundaries

Mappings live in the Kilo process until the session ends.
They are not written to disk, but another plugin or a
memory dump of the same process can read them. A whitelist
span is sent to the provider on purpose. Approved tool
arguments contain real values, so pair this plugin with
Kilo `permission` and sandbox rules. This is reversible
local masking, not a DLP enclave and not a raw HTTP
interceptor.

## License

[MIT](LICENSE)
