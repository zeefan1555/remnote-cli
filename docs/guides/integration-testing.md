# Integration Testing

Live tests exercise the candidate CLI directly against the candidate SDK Bridge.
There are no MCP or stdio suites.

## Prerequisites

- Explicit user authorization for real test writes.
- RemNote open with the candidate plugin loaded and paired to the exact KB.
- Official content and `KnowledgeBaseInfo: Read` permissions.
- Plugin writes enabled for write tests.
- The configured loopback port free. Preflight never stops another process.

If a confirmed old project daemon was running, record its state before an
authorized stop. Ordinary temporary tests restore it afterward. For the approved
local adoption, restore only on failure; success keeps the new plugin/CLI and
leaves the old plugin disabled and MCP service stopped. Do not kill unknown listeners.

## Entrypoints

AI agents use only the guarded wrapper, including for one-off live CLI commands:

```bash
./run-agent-integration-test.sh --preflight-only
./run-agent-integration-test.sh --yes --command status --text
./run-agent-integration-test.sh --yes --flashcards-only "EXISTING HOME CONCEPT TITLE"
./run-agent-integration-test.sh --yes --transactions-only
./run-agent-integration-test.sh --yes
```

The wrapper builds the candidate CLI. Every spawned CLI command owns and closes
its authenticated WebSocket session. `--suite` is removed; unknown wrapper flags
fail before live work. Do not invoke the TypeScript live runner directly.

## Two-Card Acceptance

`--flashcards-only` runs a targeted task without table/media fixtures:

1. Resolve one existing HOME folder, the specified exact HOME concept and the
   explicit host date's native daily document.
2. Preview a two-card plan and read prerequisites again to check no content changed.
3. Apply once with a stable recorded idempotency key.
4. Verify HOME tag, parent/child edges, exact question/answer text
   and two distinct native card IDs. Card Cluster (`cc`) stays off unless the
   plan sets `cardCluster: true`.
5. Replay the same plan/key and verify unchanged Rem IDs, card IDs, content, child
   lists and review history.
6. Use only existing public `sdk` commands to read both card Rems and count the
   same native card IDs. Keep the plugin asset hash unchanged throughout this
   CLI-only composition; compare status identity/catalog before and after.

The workflow requires the independent plugin ID `zeefan-remnote-sdk-bridge` and
native `app.getPlatform() === 'app'`; web sessions are not desktop acceptance.

The runner creates a private temporary evidence directory and prints its path.
It retains the plan, key, command results and exact IDs for diagnosis. Existing
prerequisites are never deleted. The date API can create today's daily document
if absent; the plan itself never resolves or creates dates.

On a partial, unknown or failed apply, stop. Preserve the original plan, key and
journal; inspect known IDs before another authorized action. Never start a new
batch to bypass uncertainty.

## General Suite

`--transactions-only` first requires `status.nativeTransactions === true`, before
creating any fixture. The current SDK returns false, so this gate fails without
writes. Do not bypass it to reproduce the known editor hang.

When available, the test uses the CLI's shared authenticated connection and SDK
client to create one isolated `[CLI-TEST]` root. It aborts a native transaction
after editing that root and creating a child, then reads both exact IDs back.
It next commits a root edit, awaits acknowledgement and verifies persistence
and child absence in a fresh session. It records intent/IDs before subsequent
writes, never deletes user data, and stops on any failure without retrying.
Retain the root and aborted child IDs for another readback after restarting
RemNote. Mocks passing this test do not establish native rollback.

The default suite covers status, create/search, read/update, journal, error cases,
Advanced Tables, properties and managed media. Missing required fixtures are
reported as skipped and the overall run is not a pass.

Fixture names are `Automation Bridge Advanced Table`,
`Automation Bridge Test Tag` and `Automation Bridge Test Media`. The shared
anchor is `RemNote Automation Bridge [temporary integration test data]`.
New artifacts use `[CLI-TEST]`; journal/card artifacts may also appear in the
daily document. The suite does not delete existing user data. Cleanup is manual
and must target only recorded test IDs with appropriate authorization.

`REMNOTE_MEDIA_ROOTS` must explicitly contain any authorized media fixture root.
No filesystem media discovery or database access is performed.

## Evidence

Report candidate source/build identity, KB, workflow/step counts, skipped cases,
retained artifact IDs and timings. `--verbose` records per-command connection and
SDK timing metadata. Record plugin asset hashes when verifying CLI-only evolution.

Use mock tests for exhaustive malformed/auth/timeout/lifecycle boundaries; record
which boundaries were also tested live. Mocks, CI and old installed packages never
substitute for real card creation/readback. Never claim native rollback without
observing it in the actual RemNote session. Never include pairing secrets in logs.
