# Installation

The direct CLI and SDK Bridge are source candidates. No registry or marketplace
publication is assumed.

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

## Plugin

Build and load the companion SDK Bridge from source using its
[local plugin guide](../../../plugin/docs/guides/development-run-plugin-locally.md).
Install independent plugin ID `zeefan-remnote-sdk-bridge` in RemNote desktop.
Enter `http://localhost:8090/` in its local-plugin installer, not the numeric IP;
verify that it appears under **Build** with that local URL and SDK settings.
Do not reuse the old MCP plugin installation: a JavaScript reload cannot refresh
its stored manifest permissions. The approved local deployment keeps a static
asset host at `127.0.0.1:8090` running through a user LaunchAgent. It does not
execute business calls or hold credentials, and it requires no upload/publication.

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

After real two-card, same-key replay and native transaction acceptance, keep the
new CLI/plugin as defaults, disable the old plugin and leave its MCP service
stopped. Restart the static host and RemNote, then verify exact test IDs again.
On failure, stop and restore the recorded pre-adoption environment; do not add
runtime compatibility fallback or silently reconnect old MCP clients.

An old daemon occupying the port must be identified before it is stopped. The CLI
never stops listeners or rewrites existing MCP client configuration automatically.
See [configuration](configuration.md) and [troubleshooting](remnote-cli-troubleshooting.md).
