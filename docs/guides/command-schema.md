# Command schema

`remnote-cli schema` is the offline source for command discovery.

Every command registers through `CommandCatalog`. The catalog records each path once
and separates navigation groups from executable actions. Positional arguments,
options and defaults are read from the Commander command created by that same
registration, so help and schema cannot drift.

## List commands

```bash
remnote-cli schema
```

Each summary contains the exact command path and its `group` or `action` kind.
Actions also include risk, Bridge requirement, dynamic SDK marker and cursor
pagination metadata when applicable.

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

The checked-in generated contract test fails when a Commander command bypasses the
catalog, when an action lacks policy, or when generated output is stale.

## Dynamic SDK commands

`sdk GROUP` commands are marked dynamic and destructive. Their group and method
help comes from the versioned SDK facts shipped with the CLI. Execution checks the
live catalog hash, modes and supported status exposed by the active SDK.

`sdk call <capability-id>` accepts one supported capability from the live catalog.
It does not bypass the Bridge allowlist, destructive approval or target-ID rules.
