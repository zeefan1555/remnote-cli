# Direct CLI and RemNote CLI Bridge

Status: approved in the maintainer conversation, 2026-10-02; marketplace Origin
amendment approved, 2026-11-25.

## Decision

Only remnote-cli and the RemNote plugin are runtime components. A CLI command owns one
loopback WebSocket listener and one protocol 2 plugin session for its complete task.
There is no MCP endpoint, stdio proxy, resident daemon, or product-version matching.

The plugin owns the official SDK, generated public-method allowlist, bounded JSON
serialization, capability discovery, permissions and exact knowledge-base binding.
CLI code owns note, card, and native TODO workflows, validation, previews, local recovery
journals and paging snapshots. SDK upgrades or permission/serialization changes can
still require a plugin update; business changes do not.

## Safety Contract

- Protocol version 2 and actual SDK catalog capabilities determine compatibility.
- There is no pairing token or HMAC challenge. The listener binds fixed
  `127.0.0.1:3002`, accepts only the exact RemNote upgrade Origins `null` and
  `https://www.remnoteplugins.com`, and rejects missing, lookalike or unknown
  Origins with HTTP 403.
- The CLI sends `hello`; the Bridge reports its plugin/SDK versions, catalog hash
  and active knowledge base in `ready`. Optional `--kb-id` validates that id.
- Every request is bound to the socket, exact KB and deadline. Official permissions
  are enforced by RemNote; there are no Bridge write or destructive gates.
- Only catalogued SDK methods are callable. No JavaScript, callbacks, private SDK
  methods or persistent SDK object handles cross the wire.
- RichTextBuilder factories are materialized with the native value() method in one
  call; builders themselves are never retained.
- Native transactions use a bounded begin/end scope (10 seconds). The plugin runs
  the actual SDK transaction; disconnect, timeout or abort rejects its callback.
  The CLI must await the commit acknowledgement. An uncertain commit is not success.
- No automatic reconnect/replay within a running command. Lost/expired writes have
  unknown outcomes until read back. Task journals are private CLI metadata, written
  durably before mutations, scoped to the active KB and stable idempotency key.
- Concurrent CLI commands fail closed on the occupied port. CLI cleanup closes all
  sockets and its listener. Plugin retries remain bounded in delay, including idle.
- Existing destructive authorization and preview-first business contracts remain.
  Local managed media retains exact-token/root validation; no database file access.

## Acceptance

Risk: high (transport, Origin boundary and write ownership).

Run focused negative/lifecycle tests, moved business regression tests, complete
quality checks and production builds in this CLI and in
[remnote-cli-bridge](https://github.com/zeefan1555/remnote-cli-bridge). Repository
topology is amended by [CLI And Plugin Repositories](0002-single-repository.md). Through the guarded
integration wrapper, load the candidate plugin, create two real flashcards, verify
native cards and text by exact IDs, replay the same key without duplicates, exercise
KB/Origin/write/timeout boundaries, and record cold-connect/task durations. Verify a
CLI-only business addition against unchanged plugin assets.

## Independent Local Installation

The plugin id is `remnote-cli-bridge` and the display name is `RemNote CLI Bridge`
(npm name `remnote-cli-bridge`). Protocol 2 does not carry the plugin id or name.
Do not reuse the old MCP plugin installation:
reloading JavaScript does not refresh installed scopes.
The desktop installation must grant both `All: ReadCreateModifyDelete` and
`KnowledgeBaseInfo: Read`. Status and the sidebar expose plugin identity,
protocol, SDK, KB and authorization failures.

Local loading uses the existing static asset host on `127.0.0.1:8090`, serving a
verified copy under `~/.local/share/remnote-cli-bridge/`. A user LaunchAgent keeps
this file-only host available; it is not a business daemon or an MCP endpoint.
The CLI has no private pairing config. Local metadata uses the standard per-user
state directory, overridable in tests with `REMNOTE_CLI_STATE_HOME`.

Acceptance additionally requires native transaction abort/readback, CLI-only
composition with unchanged plugin build hashes, and restart smoke checks.
Record complete source/build hashes because these candidates are uncommitted.
On success, keep the new plugin and CLI as the local defaults, disable the old
plugin and leave its MCP service stopped. On failure, restore only the recorded
pre-adoption environment. This replaces temporary-test restoration on success.

No commit, push, merge or publishing is part of this adoption authorization.

## Local Command Registration Amendment

On 2026-10-02, after the normal two-card write/readback/replay test passed and the
native abort failure was reported, the maintainer explicitly requested replacing
the old local CLI with this repository's build for ongoing use. This authorizes
local registration separately from full native acceptance; it does not establish
working rollback or authorize publication.

Use the existing CLI `link-cli.sh` once to register `remnote-cli` in the existing
npm prefix. Daily operations and installed-command smoke checks invoke that
command directly, not the integration wrapper. The wrapper remains the entrypoint
for development integration suites. Keep preview, explicit writes, exact KB
binding and unknown-outcome recovery unchanged.

Keep the independent plugin enabled with the verified static assets served by a
user LaunchAgent. Remove obsolete global MCP command links and disable old MCP
autostart. Preserve old source repositories and recorded test evidence; they are
not dependencies of the installed command. On an installation/smoke failure,
restore the recorded environment. The known native abort failure remains a
separate failed acceptance gate; do not rerun the hanging abort scenario.
