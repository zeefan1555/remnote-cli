# CLI Troubleshooting

## Connection Fails

Run `remnote-cli status --text`. Check that RemNote is open with RemNote CLI Bridge
enabled, the private tokens match and the URL uses the paired loopback port.
An idle plugin is normally disconnected because no command owns a listener.

The connection deadline is 15 seconds. Browser background timer throttling can
delay reconnection; bring RemNote to the foreground and retry a read-only status
check. Collect the plugin panel's error if this still fails.

## Port Occupied

Only one command can own the paired port. Identify the listener with
`lsof -nP -iTCP:3002 -sTCP:LISTEN`. Wait for a legitimate command or explicitly
stop a confirmed obsolete companion. Never kill an unknown listener.

## Permission Or KB Mismatch

`All` content permission and `KnowledgeBaseInfo: Read` are separate grants.
The latter is required for authenticated KB binding even on read-only commands.
Grant the requested scope in RemNote. Never use a different KB ID merely to
silence a mismatch.

Writes need **Accept write operations**. Destructive SDK methods additionally
need **Accept destructive operations** and CLI `--allow-destructive`.
Remote SDK calls cannot change or disclose pairing/security settings.

## SDK Capability Mismatch

Run `remnote-cli sdk capabilities`. Use the advertised signatures and modes.
Unsupported callback/handle methods cannot be invoked through JSON. Protocol and
capabilities determine compatibility, not matching plugin/CLI product versions.
A changed catalog during a command fails closed.

## Interrupted Writes

A timeout or lost connection does not mean no mutation occurred. Keep the reviewed
plan, key, journal and any returned IDs. Read those exact IDs and reconcile the
outcome before another authorized attempt. Never blindly rerun the original write
or choose a new idempotency key to bypass uncertainty.

Native transactions are disabled: SDK 0.0.46 cannot acknowledge a rejected callback
and can leave the editor blocked. Atomic commands fail before their callbacks run.
Additive commands retain a private per-attempt recovery key and known IDs; task
commands retain their stable idempotency key. Neither supplies automatic rollback.
See [the exact boundary](../adr/0003-disable-unsafe-native-transactions.md).

## Exit Status

0 means success; 1 means a command, validation, connection or incomplete-receipt
failure. JSON errors go to stderr. Task commands emit available receipts before
returning nonzero.

Use `--verbose` for timing metadata. Never share pairing tokens or raw KB content
in diagnostic logs.
