# Direct CLI Architecture

```text
CLI business commands -> remote SDK bindings -> loopback WebSocket
                                                |
                         RemNote SDK <- zero-configuration plugin gateway
```

The browser plugin cannot listen on a local TCP port. Therefore the CLI owns the
short-lived WebSocket listener and the plugin connects outward. This is a transport
inside the CLI command, not a separate server product.

## Ownership

- `src/remnote-cli/commands/`: arguments, previews, output and exit status.
- `src/business/`: notes, cards, wiki, todos, inspection and verification.
- `src/schemas/`: CLI input/output contracts.
- `src/remnote-cli/client/`: protocol 2 connection, SDK snapshots and private local state.
- Companion plugin: official SDK, generated method allowlist, serialization,
  permission checks and KB binding.

Only `get_status`, `get_sdk_capabilities` and `sdk_call` execute in the plugin.
`src/remnote-cli/client/remote-actions.ts` binds each action to one payload schema,
one handler, and its receipt/effect semantics. Unknown names and malformed payloads
reject before a listener opens; a fourth action cannot pass the fixed type registry.
`transaction_begin` and `transaction_end` explicitly fail without SDK calls. Task names
such as `flashcards_apply` are local CLI dispatch names, not plugin actions.
There is no HTTP MCP endpoint, OAuth provider, MCPB proxy, daemon or semver matching.

## Connection And Safety

1. The CLI binds fixed endpoint `127.0.0.1:3002` and accepts only the observed
   RemNote WebSocket Origin `null`; missing/unknown Origins receive HTTP 403.
2. The CLI sends protocol 2 `hello`. The Bridge answers `ready` with plugin and SDK
   versions, catalog hash, and the live active knowledge-base identity.
3. An optional `--kb-id` is explicit validation only. The CLI verifies the live SDK
   catalog hash before generating remote method bindings.
4. Every request carries an ID, KB binding and deadline. The plugin validates
   live permissions immediately before invoking an allowlisted SDK method.
5. Up to 32 SDK requests are in flight over the command-owned socket. Additional
   requests wait in FIFO order and are admitted as responses free capacity; a
   normal burst is throttled rather than rejected.
6. The CLI closes all sockets and its listener on completion or failure.

Concurrent commands fail on the occupied port; no process is stopped automatically.
The plugin retries at delays up to 1.5 seconds while idle. Browser timer throttling
can delay background connections; a CLI connection attempt waits at most 15 seconds.

Requests and responses are capped at 8 MiB. SDK values have additional depth,
collection, node and text bounds. Rem/Card objects cross as value snapshots with
IDs; callbacks and private/stateful handles do not cross. Supported RichTextBuilder
factories are materialized with the native `value()` method within one call.

SDK calls have a 15-second default deadline. Native transactions are disabled because
SDK 0.0.46 does not acknowledge a rejected callback and can block the editor. See
[ADR 0003](adr/0003-disable-unsafe-native-transactions.md) for the
additive-write and rejected atomic-command boundary. Timeout or disconnect does
not prove cancellation or rollback. No running command reconnects or replays writes
automatically. New plugin sessions wait only for prior individual SDK calls to settle.
Tasks have no command-wide 45-second deadline; every task mutation remains guarded by
its journal, and a long-running operation can be resumed under the same idempotency
key instead of being truncated by wall-clock time.

The trust boundary is the current operating-system user. Origin validation blocks
ordinary webpages, not native local processes that can forge headers.

## Local State

State files are private to the local user under `$XDG_STATE_HOME/remnote-cli`, or
`~/.local/state/remnote-cli`. Journals and paging snapshots live under
`state/<KB hash>/`. Journals are
metadata-only and durably written before mutations. Task journals use a stable
idempotency key; additive command journals use a per-attempt recovery key and retain
known IDs on partial failure. Corrupt or uncertain journal state fails closed. Search snapshots contain IDs
and query hashes, not copied KB text.

The CLI fetches a live capability catalog for each command; there is no persistent
capability cache or offline identity fallback. Official SDK constants used by local
business logic are generated without importing the browser SDK runtime into Node.

Every Commander command is created through `CommandCatalog`. The catalog records
the path once and distinguishes navigation groups from executable actions. Risk,
Bridge requirements and pagination belong only to actions. Help, schema, contract
and diagnostics read that registered model instead of maintaining a second path
policy table. Commander still owns argument parsing and the mature option model.

`ReadSession` is command-local. `context` and `inspect` share exact Rem loads and
read-only SDK method results, preserve input order through a bounded scheduler, and
discard the entire cache after any mutation. Values never survive the owning
`DirectClient`, so batch commands can benefit without leaking state across commands.

`OperationKernel` is the common mutation policy. Task and workspace journals both
persist a `started` step before a native write and advance to `verified` only
after their own readback. Flashcard scaffolding advances to `applied` as soon as
all returned IDs are durably saved; later binding and content failures remain
`partial` and resume under the same key. `unknown` plus exact-ID reconciliation
is reserved for outcomes that cannot identify the affected objects. Publication
and business-specific proof remain in their owning modules.

See [the approved decision](adr/0001-direct-cli.md),
[read receipts](guides/read-receipts.md) and [task plans](guides/task-plans.md).
