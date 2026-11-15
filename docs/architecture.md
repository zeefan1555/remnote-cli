# Direct CLI Architecture

```text
CLI business commands -> remote SDK bindings -> loopback WebSocket
                                                |
                         RemNote SDK <- authenticated plugin gateway
```

The browser plugin cannot listen on a local TCP port. Therefore the CLI owns the
short-lived WebSocket listener and the plugin connects outward. This is a transport
inside the CLI command, not a separate server product.

## Ownership

- `src/remnote-cli/commands/`: arguments, previews, output and exit status.
- `src/business/`: notes, cards, wiki, todos, inspection and verification.
- `src/schemas/`: CLI input/output contracts.
- `src/remnote-cli/client/`: paired connection, SDK snapshots and private local state.
- Companion plugin: official SDK, generated method allowlist, serialization,
  permission checks and KB binding.

Only `get_status`, `get_sdk_capabilities` and `sdk_call` execute in the plugin.
`transaction_begin` and `transaction_end` explicitly fail without SDK calls. Task names
such as `flashcards_apply` are local CLI dispatch names, not plugin actions.
There is no HTTP MCP endpoint, OAuth provider, MCPB proxy, daemon or semver matching.

## Connection And Safety

1. The CLI reads its private pairing file and binds `127.0.0.1`.
2. Fresh HMAC challenges authenticate both peers without transmitting the secret.
3. The CLI requires the exact KB and protocol version. It verifies the live SDK
   catalog hash before generating remote method bindings.
4. Every request carries an ID, KB binding and deadline. The plugin validates
   live permissions immediately before invoking an allowlisted SDK method.
5. The CLI closes all sockets and its listener on completion or failure.

Concurrent commands fail on the occupied port; no process is stopped automatically.
The plugin retries at delays up to 1.5 seconds while idle. Browser timer throttling
can delay background connections; a CLI connection attempt waits at most 15 seconds.

Requests and responses are capped at 8 MiB. SDK values have additional depth,
collection, node and text bounds. Rem/Card objects cross as value snapshots with
IDs; callbacks and private/stateful handles do not cross. Supported RichTextBuilder
factories are materialized with the native `value()` method within one call.

Protocol 2 allocates canonical positive safe-integer decimal request IDs in actual
send order (1 through 9007199254740991). The Bridge stores one session high-water
ID, rejecting duplicates, decreases and noncanonical/out-of-range values before
dispatch. Success, SDK rejection and expiry all consume the ID; exhaustion never
wraps. This follows the monotonic non-reuse pattern of
[RFC 9113 section 5.1.1](https://www.rfc-editor.org/rfc/rfc9113.html#section-5.1.1),
without adding HTTP/2 or a cumulative request-count ceiling.

The CLI admits at most 32 requests (including connection waits): 16 wire requests
and 16 timed local slot waiters. Excess/expired unsent requests fail without
dispatch; disconnect rejects all pending work and never replays it. The Bridge
separately caps outstanding work at 32, SDK execution at 16, slot waiters at 16,
and ordered frames at 32 / 8 MiB aggregate. Overload closes the session before the
offending request dispatches. Earlier native calls may still settle, so closing
does not establish rollback. New sessions wait for prior native work as before.

Business read producers use lazy, ordered pools that stop scheduling and drain
started reads before reporting failure. Full workspace reconciliation uses two
batches, four Rems per batch and four snapshot leaves per Rem; probes retain four
batches with at most two powerup leaves per Rem. Other data-sized reads are bounded
at their composition boundary. This preserves complete native facts within the
transport budget; a single Rem's snapshot may require additional read waves.
Native writes remain serial, and excessive external composition is still rejected.

The pairing file's strict `schemaVersion: 1` is independent of wire protocol 2.
Unsupported/old files fail before listener creation and are never rewritten.
Create-only pairing, KB/port/settings and private state derivation are unchanged.

SDK calls have a 15-second default deadline. Native transactions are disabled because
SDK 0.0.46 does not acknowledge a rejected callback and can block the editor. See
[ADR 0003](adr/0003-disable-unsafe-native-transactions.md) for the
additive-write and rejected atomic-command boundary. Timeout or disconnect does
not prove cancellation or rollback. No running command reconnects or replays writes
automatically. New plugin sessions wait only for prior individual SDK calls to settle.

## Local State

The pairing file and state files are private to the local user. Journals and paging
snapshots live beside the pairing file, under `state/<KB hash>/`. Journals are
metadata-only and durably written before mutations. Task journals use a stable
idempotency key; additive command journals use a per-attempt recovery key and retain
known IDs on partial failure. Corrupt or uncertain journal state fails closed. Search snapshots contain IDs
and query hashes, not copied KB text.

The CLI fetches a live capability catalog for each command; there is no persistent
capability cache or offline identity fallback. Official SDK constants used by local
business logic are generated without importing the browser SDK runtime into Node.

See [the approved decision](adr/0001-direct-cli.md),
[read receipts](guides/read-receipts.md) and [task plans](guides/task-plans.md).
