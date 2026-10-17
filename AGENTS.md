# Agent Map

This repository is `remnote-cli`. The companion plugin is
[RemNote CLI Bridge](https://github.com/zeefan1555/remnote-cli-bridge)
(manifest id `remnote-cli-bridge`).

```text
CLI commands <-> authenticated loopback WebSocket <-> RemNote CLI Bridge <-> SDK
```

## Design principle

The plugin exposes only atomic RemNote SDK capabilities (one SDK method per bridge call, args passed through). All composition, argument normalization, verification and workflow logic lives in this CLI. CLI commands stay generic (no flashcard/workflow-specific concepts).

The bridge must not contain composition, translation, workarounds or business logic, and should rarely change. The CLI composes multiple atomic plugin calls.

## Ownership And Contracts

- `src/remnote-cli/`: command parsing, output, connection and private state.
- `src/business/`: composition, inspection, task journals and recovery.
- `src/schemas/`: Zod input/output contracts.
- [RemNote CLI Bridge](https://github.com/zeefan1555/remnote-cli-bridge): generated official SDK allowlist, serialization, live permissions and exact KB binding. Native transactions are disabled by ADR 0003.
- [Architecture](docs/architecture.md) and [approved ADR](docs/adr/0001-direct-cli.md).

Business changes belong in the CLI and must not require a plugin update when the
needed SDK capability already exists. No MCP transport, proxy, daemon, remote
endpoint, compatibility shim or product-version matching is maintained.
Callbacks, private SDK methods and persistent SDK object handles are not supported.

Handshake accepts plugin id `remnote-cli-bridge` and, during the rename, the
previous id `zeefan-remnote-sdk-bridge`. The same transition applies to the
display names `RemNote CLI Bridge` and `RemNote SDK Bridge` when the plugin
sends them. Plugin version `0.25.0` is accepted. Compatibility is protocol 1
plus the SDK catalog, not matching product versions.

Task plans default to preview, require current hashes for patches and use durable
metadata-only journals scoped to the paired KB. Unknown write outcomes must not
be replayed automatically. Task commands do not resolve dates or create daily
documents; the caller owns calendar freshness. Replay keeps the recorded diary.
Required proof scopes cannot be narrowed merely to pass.

## Verification

```bash
npm run typecheck
npm run check:sdk-constants
./code-quality.sh
npm run build
```

If Node is unavailable, first run `source ./node-check.sh`.
SDK constants are generated from the installed official declaration files; do not
hand-edit generated files or load the browser SDK runtime in Node.

Daily operations and installed-command smoke checks invoke `remnote-cli` directly.
Development integration suites require explicit authorization and use this wrapper:

```bash
./run-agent-integration-test.sh --preflight-only
./run-agent-integration-test.sh --yes
./run-agent-integration-test.sh --yes --flashcards-only "EXISTING HOME CONCEPT TITLE"
./run-agent-integration-test.sh --yes --command status
./run-agent-integration-test.sh --yes --transactions-only
```

Read [integration testing](docs/guides/integration-testing.md) before live actions.
Preflight checks the paired loopback port before any build or mutation. The wrapper
never stops listeners or starts a daemon. Identify an occupied port before acting;
under explicit full-operation authority, record, stop and later restore only a
confirmed project-owned obsolete companion. Never stop unrelated services.
The maintainer explicitly requested replacing the daily command with this build.
Successful local registration keeps the RemNote CLI Bridge plugin and direct CLI
installed, the old plugin disabled and MCP autostart disabled; installation/smoke
failure restores the recorded prior environment. Native rollback remains failed,
not waived as a test result. Record source/build hashes and restart smoke evidence.

Reload changed plugin code through Computer Use before live verification, subject
to its action-time confirmation rules. Preserve real test IDs and recovery plans.
Stop on partial/unknown writes and reconcile them before another batch. Do not
access the RemNote database directly. Unit mocks are not native persistence proof.

## Documentation And Delivery

Keep this map, the [CLI reference](docs/guides/remnote-cli-command-reference.md),
[read receipts](docs/guides/read-receipts.md), [task plans](docs/guides/task-plans.md)
and [agent skill](skills/remnote/SKILL.md) aligned with behavior. Protocol changes
belong in this repository and in
[remnote-cli-bridge](https://github.com/zeefan1555/remnote-cli-bridge). Record
functional and documentation changes in `CHANGELOG.md`.

Use this repository's quality and build commands and its GitHub Actions CI.
The original fork adoption workflow is historical guidance for the original forks,
not this repository's delivery contract; do not modify those forks or their PRs.
Commit and push to this repository are authorized. Package publication is not
authorized. Local registration is separately authorized by the ADR amendment;
it does not establish full native acceptance. Preserve dirty work and upstream licenses.
