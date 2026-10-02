# Direct CLI and SDK Bridge

Status: approved in the maintainer conversation, 2026-10-02.

## Decision

Only remnote-cli and the RemNote plugin are runtime components. A CLI command owns one
loopback WebSocket listener and one authenticated plugin session for its complete task.
There is no MCP endpoint, stdio proxy, resident daemon, or product-version matching.

The plugin owns the official SDK, generated public-method allowlist, bounded JSON
serialization, capability discovery, permissions and exact knowledge-base binding.
CLI code owns note/card/wiki/todo workflows, validation, previews, local recovery
journals and paging snapshots. SDK upgrades or permission/serialization changes can
still require a plugin update; business changes do not.

## Safety Contract

- Protocol version 1 and actual SDK catalog capabilities determine compatibility.
- A 256-bit pairing secret authenticates both peers with fresh HMAC challenges.
  The listener binds only 127.0.0.1; neither peer sends the secret over WebSocket.
- Every request is bound to the authenticated socket, exact KB and deadline.
  Official permissions and live write/destructive gates are enforced in the plugin.
- Only catalogued SDK methods are callable. No JavaScript, callbacks, private SDK
  methods or persistent SDK object handles cross the wire.
- RichTextBuilder factories are materialized with the native value() method in one
  call; builders themselves are never retained.
- Native transactions use a bounded begin/end scope (10 seconds). The plugin runs
  the actual SDK transaction; disconnect, timeout or abort rejects its callback.
  The CLI must await the commit acknowledgement. An uncertain commit is not success.
- No automatic reconnect/replay within a running command. Lost/expired writes have
  unknown outcomes until read back. Task journals are private CLI metadata, written
  durably before mutations, scoped to the paired KB and stable idempotency key.
- Concurrent CLI commands fail closed on the occupied port. CLI cleanup closes all
  sockets and its listener. Plugin retries remain bounded in delay, including idle.
- Existing destructive authorization and preview-first business contracts remain.
  Local managed media retains exact-token/root validation; no database file access.

## Acceptance

Risk: high (transport, authorization and write ownership).

Run focused negative/lifecycle tests, moved business regression tests, complete
quality checks and production builds in both packages. Repository topology is
amended by [One Repository, Two Packages](0002-single-repository.md). Through the guarded
integration wrapper, load the candidate plugin, create two real flashcards, verify
native cards and text by exact IDs, replay the same key without duplicates, exercise
KB/auth/write/timeout boundaries, and record cold-connect/task durations. Verify a
CLI-only business addition against unchanged plugin assets.

## Independent Local Installation

The implementation plan approved on 2026-10-02 assigns the independent plugin ID
`zeefan-remnote-sdk-bridge` and name `RemNote SDK Bridge`. Do not reuse the old
plugin installation: reloading JavaScript does not refresh installed scopes.
The desktop installation must grant both `All: ReadCreateModifyDelete` and
`KnowledgeBaseInfo: Read`. Status and the sidebar expose plugin identity,
protocol, SDK, KB and authorization failures, never the pairing token.

Local loading uses the existing static asset host on `127.0.0.1:8090`, serving a
verified copy under `~/.local/share/remnote-sdk-bridge/`. A user LaunchAgent keeps
this file-only host available; it is not a business daemon or an MCP endpoint.
The existing private CLI pairing config is reused without logging its token.

Acceptance additionally requires native transaction abort/readback, CLI-only
composition with unchanged plugin build hashes, and restart smoke checks.
Record complete source/build hashes because these candidates are uncommitted.
On success, keep the new plugin and CLI as the local defaults, disable the old
plugin and leave its MCP service stopped. On failure, restore only the recorded
pre-adoption environment. This replaces temporary-test restoration on success.

No commit, push, merge or publishing is part of this adoption authorization.
