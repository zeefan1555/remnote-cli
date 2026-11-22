# Output and errors

`remnote-cli` uses one machine contract for every command.

## JSON

A successful command writes one envelope to stdout.

```json
{
  "schemaVersion": 2,
  "ok": true,
  "data": {}
}
```

A failed command writes one envelope to stderr. stdout stays empty.

```json
{
  "schemaVersion": 2,
  "ok": false,
  "error": {
    "type": "usage",
    "subtype": "unknown_option",
    "message": "error: unknown option '--bad'",
    "retryable": false
  }
}
```

The error may include `hint` for the next safe action and `details` for a failed
receipt or partial result.

Command groups have machine-readable boundary errors. A bare group prints help and
exits 0. An unknown subcommand, a missing subcommand with a leaf-only flag, or an
unknown group flag exits 2 with `error.details.commandPath`, `suggestions` and
`usage`.

```json
{
  "schemaVersion": 2,
  "ok": false,
  "error": {
    "type": "usage",
    "subtype": "unknown_subcommand",
    "message": "unknown subcommand lis for todo; did you mean list, reopen, complete?",
    "retryable": false,
    "details": {
      "commandPath": "todo",
      "suggestions": ["list", "reopen", "complete"],
      "usage": "todo"
    }
  }
}
```

## Error types and exit codes

| Type | Exit | Meaning |
| --- | ---: | --- |
| `usage` | 2 | Arguments or input schema are invalid |
| `configuration` | 3 | Local configuration is missing or invalid |
| `unavailable` | 3 | RemNote, the Bridge or the required connection is unavailable |
| `not_found` | 4 | An exact target does not exist or is inaccessible |
| `conflict` | 4 | State changed, evidence is incomplete, or targets conflict |
| `unknown_outcome` | 5 | A write may have changed RemNote and must be reconciled |
| `unsupported` | 6 | The live SDK cannot safely provide the requested operation |
| `internal` | 1 | The CLI or Bridge returned malformed or unexpected data |

`unknown_outcome` always has `retryable: false`. Read the exact affected IDs
before attempting another write or choosing a new idempotency key.

## Text

`--text` is for people. It preserves the same exit codes but removes ANSI escape
sequences and non-printing terminal controls.

## Verbose diagnostics

`--verbose` writes timing diagnostics to stderr in JSON. stdout still contains
only the command contract.

## Batch

`batch` runs inner commands with an in-memory runtime. It does not replace global
`console` state. Each result contains its own `ok`, `exitCode`, `result` or
structured `error`.

If any executed command fails, the outer batch returns a failure envelope with
the complete batch result in `error.details`. If any inner command has
`unknown_outcome`, the outer error also uses `unknown_outcome` and is not
retryable.
