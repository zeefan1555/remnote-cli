# RemNote CLI

Part of [RemNote Direct](../../README.md). Run this page's development commands
from `packages/cli`. [Native rollback acceptance remains blocked](../../docs/acceptance.md).

Local command-line access to RemNote through the companion
[SDK Bridge plugin](../plugin/README.md).

```text
remnote-cli <-> authenticated loopback WebSocket <-> SDK Bridge <-> RemNote SDK
```

There is no MCP endpoint, stdio proxy, resident daemon, or cloud relay. Each command
opens its own loopback listener, performs its task, and closes the connection.
`batch --file` keeps that listener open across a list of commands so back-to-back
calls do not collide on the CLI port. Help, version, and usage errors stay inside
the batch JSON envelope. `batch --allow-destructive` covers inner `sdk` calls.
Keep RemNote open with the paired plugin enabled. An idle plugin waiting for a CLI
command is normal.

## Setup

This direct architecture is currently built from source; do not substitute the old
marketplace plugin or published MCP server.

```bash
npm ci
npm run build
node dist/remnote-cli/index.js pair --kb-id YOUR_KNOWLEDGE_BASE_ID
```

The pairing command creates a private configuration file and never prints its
secret. Enter its `token` once in the SDK Bridge's **CLI pairing token** setting.
Grant the plugin content access and **KnowledgeBaseInfo: Read** in RemNote.
Enable **Accept write operations** only when writes are intended.

```bash
node dist/remnote-cli/index.js status --text
```

See [installation](docs/guides/installation.md) and
[configuration](docs/guides/configuration.md). Product versions need not match:
protocol and generated SDK capabilities determine compatibility.

## Commands

```bash
remnote-cli search "topic"
remnote-cli read REM_ID --content-mode structured --depth 1
remnote-cli read REM_ID OTHER_ID --content-mode none
remnote-cli list-children PARENT_ID OTHER_PARENT_ID
remnote-cli batch --file commands.jsonl
remnote-cli review-stats REM_ID
remnote-cli context --request context.json
remnote-cli verify scope --expect expectations.json
remnote-cli flashcards apply --plan cards.json --idempotency-key batch-1
remnote-cli flashcards apply --plan cards.json --idempotency-key batch-1 --apply
remnote-cli sdk capabilities --status supported --mode read --text
```

Preview-first task commands keep durable, metadata-only journals scoped to the
paired KB. A lost response or timeout does not prove that no data changed: inspect
exact returned IDs before retrying. Never change a reviewed plan under its key or
create a new key to bypass an uncertain write.

Business workflows live in this CLI. The plugin exposes the generated public SDK
surface, excluding callbacks, private methods and non-serializable handles.
Business additions need only a CLI update; SDK, permission or serialization changes
can still require a plugin update.

## Development

```bash
./code-quality.sh
npm run build
./run-agent-integration-test.sh --preflight-only
./run-agent-integration-test.sh --yes --flashcards-only "EXISTING HOME CONCEPT TITLE"
```

Live tests require explicit authorization and create real, labeled test data.
They are not run by unit tests or CI.

- [Command reference](docs/guides/remnote-cli-command-reference.md)
- [Read receipts](docs/guides/read-receipts.md)
- [Task plans](docs/guides/task-plans.md)
- [Agent skill](skills/remnote/SKILL.md)
- [Architecture](docs/architecture.md)
- [Development](docs/guides/development-setup.md)
- [Integration testing](docs/guides/integration-testing.md)
- [Troubleshooting](docs/guides/remnote-cli-troubleshooting.md)
- [Changelog](CHANGELOG.md)

MIT License. See [LICENSE](LICENSE).
