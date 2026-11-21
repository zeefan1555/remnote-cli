# Configuration

## Zero-Configuration Connection

The CLI has no pairing command, token file, endpoint option, port option, or
persisted connection configuration. Every live command binds the fixed endpoint
`127.0.0.1:3002`, sends protocol 2 `hello`, and uses the active knowledge base and
SDK catalog identity returned by RemNote CLI Bridge.

The listener accepts only the WebSocket upgrade `Origin: null` emitted by
RemNote's sandboxed plugin. Missing and unknown Origins receive HTTP 403. The
trust boundary is the current operating-system user: Origin validation blocks an
ordinary webpage but does not isolate a malicious native local process, which can
forge request headers.

## CLI Options

- `--kb-id ID`: require this exact active knowledge base for the invocation.
- `--allow-destructive`: authorize a destructive SDK operation; official RemNote
  scopes remain the native permission boundary.
- `--verbose`: emit connection, SDK-call and command durations to stderr.
- `--text`: human-readable output; JSON is the default.

No remote URL, HTTP port, MCP URL, OAuth, pairing secret, or daemon configuration
exists.

## Business Defaults

The CLI uses its built-in defaults for journals, auto-tagging and parent selection.
There is no persisted settings object. Official SDK scopes decide whether an
operation can read or write the active knowledge base.

Local metadata is stored in the standard per-user state directory:

```text
$REMNOTE_CLI_STATE_HOME
$XDG_STATE_HOME/remnote-cli
~/.local/state/remnote-cli
```

Journals and ID-only search snapshots live under `state/<KB hash>/`. Tests and
isolated runs may set `REMNOTE_CLI_STATE_HOME`; this is not a runtime configuration
requirement. Do not remove uncertain journals to force a fresh write.

`REMNOTE_MEDIA_ROOTS` explicitly lists authorized RemNote-managed media directories,
separated by the platform path delimiter. No media root is discovered automatically.
Managed-image reads validate exact media tokens and containment; this is not access
to the RemNote database.

## RemNote Permissions

The Bridge needs official content permission and the separate
`KnowledgeBaseInfo: Read` scope. An existing content grant does not automatically
grant KB identity access. Apply new permissions in RemNote; do not weaken KB
verification to work around a denied scope.
