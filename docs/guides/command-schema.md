# Command schema

`remnote-cli schema` is the offline source for command discovery.

The command reads the actual Commander command tree after registration. Positional
arguments, options and defaults are not copied into a second registry.

## List commands

```bash
remnote-cli schema
```

Each summary contains the exact command path, risk, Bridge requirement, dynamic
SDK marker and cursor pagination metadata when applicable.

## Inspect one command

```bash
remnote-cli schema search
remnote-cli schema powerup get
remnote-cli schema sdk rem
```

The result includes usage, an object-shaped CLI input schema, required fields,
global options, output streams and the command risk policy.

## Contract relationship

`remnote-cli contract` includes the command summary. The complete per-command
input schema stays available through `remnote-cli schema PATH`.

The checked-in generated contract test fails when an added Commander command has
no policy or when generated output is stale.

## Dynamic SDK commands

`sdk GROUP` commands are marked dynamic and destructive. The live
`remnote-cli sdk capabilities` result remains authoritative for methods,
modes and supported status exposed by the active SDK.
