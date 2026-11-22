# Doctor

`remnote-cli doctor` runs read-only diagnostics across the local installation and
the active RemNote Bridge.

## Usage

```bash
remnote-cli doctor
remnote-cli doctor --json
remnote-cli doctor --text
remnote-cli doctor --offline
remnote-cli doctor --offline --json
```

## Checks

- Node satisfies the package engine policy
- CLI and command-contract versions are internally consistent
- The state directory exists or has a writable parent
- The Bridge responds to status
- Plugin identity is `remnote-cli-bridge`
- Protocol is compatible with protocol 2
- The active knowledge base is identified
- SDK catalog identity matches the Bridge handshake
- Live SDK facts are compared with local generated navigation
- Local metadata and journal files are regular, private, readable JSON

## Statuses

| Status | Meaning |
| --- | --- |
| `pass` | Check succeeded |
| `warn` | Setup can continue, but the report needs attention |
| `fail` | A required check failed |
| `skip` | Check does not apply in this mode or depends on a failed check |

Exit 0 means no failing checks. A failing report returns exit 3 and places the
complete report in `error.details`.

## Offline mode

`doctor --offline` does not construct a client and never opens the Bridge socket.
It runs Node, CLI contract and local state checks. Bridge, plugin, protocol,
knowledge-base, SDK and journal checks are skipped unless they can be
derived locally.

## Read-only guarantee

Doctor does not write RemNote data. Its client is configured with persistence
disabled, and state inspection opens existing files read-only.
