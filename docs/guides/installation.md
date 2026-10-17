# Installation

Install this CLI from source. Install the companion plugin, RemNote CLI Bridge,
from the RemNote marketplace. Its repository is
[remnote-cli-bridge](https://github.com/zeefan1555/remnote-cli-bridge).

## CLI

Use Node.js 22.13.0 or newer (Node.js 24 recommended).

```bash
npm ci
npm run build
node dist/remnote-cli/index.js --help
node dist/remnote-cli/index.js pair --kb-id YOUR_KNOWLEDGE_BASE_ID
```

The KB ID is available in the RemNote knowledge-base URL. Pairing creates
`~/.config/remnote-cli/connection.json` with mode 0600. It refuses to overwrite an
existing file. Keep the token private and never paste it into logs or issue reports.

For an explicitly requested local installation, `./link-cli.sh` links the single
`remnote-cli` executable using the existing npm prefix and lockfile. A build alone
does not replace installed commands. Record the current executable symlink before
adoption. If it belongs to the old MCP package, replace only that link; never
force-overwrite an unrelated command. Check `command -v remnote-cli`, the resolved
symlink, version and build hash against the candidate after linking.

When the old `remnote-mcp-server` package owns the existing command, remove that
global npm link/install before running `./link-cli.sh`. This does not require
deleting its source repository. Daily use after registration is simply:

```bash
remnote-cli --version
remnote-cli status --text
remnote-cli read REM_ID --content-mode structured --depth 1
```

The integration wrapper is for development suites, not a daily command launcher.
No shell alias, secondary command name or runtime compatibility fallback is used.
The npm link points at this repository, so subsequent `npm run build` runs here
update the same installed command without relinking the plugin.

## Plugin

Install **RemNote CLI Bridge** from the RemNote marketplace. The manifest id and
npm name are `remnote-cli-bridge`; the display name is RemNote CLI Bridge.
Plugin version 0.25.0 is compatible with this CLI. A build that still reports
`zeefan-remnote-sdk-bridge` or RemNote SDK Bridge is accepted during the rename.
Confirm `status.pluginVersion`, `status.pluginId`, `status.sdkCatalogHash` and
`status.nativeTransactions === false`; the installed manifest panel alone does
not prove which JavaScript is running. Atomic update/replacement/property/TODO
commands are unavailable until native abort is safe. Additive writes and
journaled tasks remain available with exact readback and recovery records.

Source builds of the plugin come from
[remnote-cli-bridge](https://github.com/zeefan1555/remnote-cli-bridge).
For a local installer, enter `http://localhost:8090/`, not the numeric IP, and
verify that it appears under **Build** with that local URL and SDK settings.
Do not reuse the old MCP plugin installation: a JavaScript reload cannot refresh
its stored manifest permissions. A local static asset host at `127.0.0.1:8090`
can run through a user LaunchAgent. It does not execute business calls or hold
credentials. That deployment stores plugin `dist/` and `serve-dist.js` under
`~/.local/share/remnote-cli-bridge/`; its LaunchAgent label is
`com.zeefan.remnote-cli-bridge`.

In RemNote plugin settings:

1. Grant content access and the separate `KnowledgeBaseInfo: Read` permission.
2. Paste **CLI pairing token** from the private pairing file's `token` and leave
   the input to save it. Verify live status; a populated field is not enough.
3. Set **CLI loopback WebSocket URL** to `ws://127.0.0.1:3002` (or the paired port).
4. Enable **Accept write operations** only when authorized. Destructive operations
   also require the separate plugin gate and explicit CLI `--allow-destructive`.

Reload the plugin after changing its WebSocket URL or source build.
Keep RemNote open; the sidebar does not need to remain open.

```bash
remnote-cli status --text
```

Successful status must show the intended KB and protocol. Product version numbers
are informational; they do not need to match. Confirm the new plugin ID and SDK
version as well. Reuse an existing private pairing file instead of creating or
printing another token; enter it only in the new plugin's settings.

The maintainer separately authorized local registration after the normal two-card
write/readback/replay test passed. Native transaction abort remains failed; local
use does not establish full acceptance. See the shared
[ADR amendment](../adr/0001-direct-cli.md#local-command-registration-amendment).
Keep the new CLI/plugin as defaults, disable the old plugin and old MCP autostart.
Restart the static host and RemNote, then directly invoke the installed command
to verify exact test IDs again. On installation/smoke failure, stop and restore
the recorded prior environment; do not add runtime fallback or reconnect MCP.

An old daemon occupying the port must be identified before it is stopped. The CLI
never stops listeners or rewrites existing MCP client configuration automatically.
See [configuration](configuration.md) and [troubleshooting](remnote-cli-troubleshooting.md).
