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
  permission checks, KB binding and native transaction scopes.

Only `get_status`, `get_sdk_capabilities`, `sdk_call`,
`transaction_begin` and `transaction_end` cross the plugin boundary. Task names
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

SDK calls have a 15-second default deadline. Native transaction scopes are bounded
to 10 seconds; the CLI must await the commit acknowledgement. Timeout or disconnect
does not prove cancellation or rollback. No running command reconnects or replays
writes automatically. New plugin sessions wait for prior native work to settle.

## Local State

The pairing file and state files are private to the local user. Journals and paging
snapshots live beside the pairing file, under `state/<KB hash>/`. Journals are
metadata-only, durably written before mutations and keyed by a stable idempotency
key. Corrupt or uncertain journal state fails closed. Search snapshots contain IDs
and query hashes, not copied KB text.

The CLI fetches a live capability catalog for each command; there is no persistent
capability cache or offline identity fallback. Official SDK constants used by local
business logic are generated without importing the browser SDK runtime into Node.

See [the approved decision](adr/0001-direct-cli.md),
[read receipts](guides/read-receipts.md) and [task plans](guides/task-plans.md).
