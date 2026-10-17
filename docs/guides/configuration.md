# Configuration

## Private Pairing

`remnote-cli pair --kb-id ID [--port PORT]` creates a private file with:

- `protocolVersion: 1`
- a random 256-bit `token`
- exact `knowledgeBaseId`
- loopback `port` (default 3002)

The default path is `$XDG_CONFIG_HOME/remnote-cli/connection.json`, or
`~/.config/remnote-cli/connection.json`. `REMNOTE_CLI_CONFIG` selects another
file. It must be a regular, non-symlink file, at most 8 KiB, with no group/other
permission bits. Pairing refuses to overwrite it.

Enter the token only in the trusted RemNote CLI Bridge plugin. The plugin never returns
the token through SDK calls and cannot change its own security settings over RPC.

## CLI Overrides

- `--port PORT`: loopback listener port; must match the plugin URL.
- `--kb-id ID`: require this exact KB for this invocation.
- `--allow-destructive`: authorize a destructive operation in addition to both
  live plugin write gates.
- `--verbose`: emit connection, SDK-call and command durations to stderr.
- `--text`: human-readable output; JSON is the default.

No remote URL, HTTP port, MCP URL, OAuth or daemon configuration exists.

## Business Defaults

The optional `settings` object in the pairing file accepts `defaultParentId`,
`autoTagEnabled`, `autoTagRemId`, `journalPrefix` and `journalTimestamp`.
These are CLI business defaults, not plugin features or permissions.

Journals and ID-only search snapshots are stored beside the pairing file under
`state/<KB hash>/`. Do not remove uncertain journals to force a fresh write.

`REMNOTE_MEDIA_ROOTS` explicitly lists authorized RemNote-managed media directories,
separated by the platform path delimiter. No media root is discovered automatically.
Managed-image reads validate exact media tokens and containment; this is not access
to the RemNote database.

## Plugin Settings

- **CLI pairing token**: the matching private token.
- **CLI loopback WebSocket URL**: only `ws://127.0.0.1:PORT` is accepted.
- **Accept write operations**: disabled by default.
- **Accept destructive operations**: disabled by default; CLI consent is also required.

The plugin needs the official content permissions and separate
`KnowledgeBaseInfo: Read` scope. An old installation's content grant does not
automatically grant KB identity access. Apply new permissions in RemNote; do not
weaken KB verification to work around a denied scope.
