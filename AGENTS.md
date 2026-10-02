# Agent Map

This package contains `remnote-cli` in the RemNote Direct repository. Shared
repository guidance lives in [the root agent map](../../AGENTS.md).

```text
CLI commands <-> authenticated loopback WebSocket <-> ../plugin <-> SDK
```

## Ownership And Contracts

- `src/remnote-cli/`: command parsing, output, connection and private state.
- `src/business/`: note/card/wiki/todo workflows, inspection and recovery.
- `src/schemas/`: Zod input/output contracts.
- `../plugin`: generated official SDK allowlist, serialization,
  live permissions and exact KB binding. Native transactions are disabled by shared ADR 0003.
- [Architecture](docs/architecture.md) and [approved ADR](docs/adr/0001-direct-cli.md).

Business changes belong in the CLI and must not require a plugin update when the
needed SDK capability already exists. No MCP transport, proxy, daemon, remote
endpoint, compatibility shim or product-version matching is maintained.
Callbacks, private SDK methods and persistent SDK object handles are not supported.

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

Live validation requires explicit human authorization and only uses this wrapper:

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
For the approved local adoption, success keeps the independent SDK plugin and
direct CLI installed, the old plugin disabled and the MCP service stopped;
failure restores the recorded prior environment. Do not restore the old service
on successful adoption. Record source/build hashes and restart smoke evidence.

Reload changed plugin code through Computer Use before live verification, subject
to its action-time confirmation rules. Preserve real test IDs and recovery plans.
Stop on partial/unknown writes and reconcile them before another batch. Do not
access the RemNote database directly. Unit mocks are not native persistence proof.

## Documentation And Delivery

Keep this map, the [CLI reference](docs/guides/remnote-cli-command-reference.md),
[read receipts](docs/guides/read-receipts.md), [task plans](docs/guides/task-plans.md)
and [agent skill](skills/remnote/SKILL.md) aligned with behavior. Update both packages'
contracts/changelogs for protocol changes. Record functional and documentation
changes in `CHANGELOG.md`.

Use the root quality/build commands and shared CI for changes in this repository.
The retained [fork adoption workflow](../plugin/docs/workflows/pr-validation-and-adoption.md)
is historical guidance for the original forks, not this repository's delivery
contract; do not modify the existing forks or their PRs. Commit and push to this
independent repository are now explicitly authorized. Package publication is not
authorized; daily installation requires all native acceptance gates. Preserve
dirty work, upstream licenses and existing trailers.
