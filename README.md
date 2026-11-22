# RemNote CLI

`remnote-cli` gives scripts, coding agents, and people direct access to the active RemNote knowledge base. Each live command starts a short local connection to RemNote CLI Bridge, runs the requested SDK operations, and exits.

The CLI has no MCP server, background daemon, or cloud relay. Command output is JSON by default. Add the global `--text` option for human-readable output.

## Requirements

- Node.js 22.13.0 or newer. Node.js 24 is recommended.
- RemNote desktop with the RemNote CLI Bridge plugin enabled.
- A shell on macOS or Linux for the source installation steps in this README.

The current operating-system user is the trust boundary. The Bridge rejects ordinary webpages, but a native process running as the same user can forge local request headers. Do not run untrusted local programs while the Bridge is enabled.

## Install RemNote CLI Bridge

Install **RemNote CLI Bridge** from the RemNote marketplace. Its manifest ID is `remnote-cli-bridge`.

1. Open the plugin in RemNote.
2. Enable it.
3. Grant content read and write access in RemNote.
4. Grant the separate `KnowledgeBaseInfo: Read` permission.

Keep RemNote open while you run CLI commands. The Bridge connects automatically and reports its active knowledge base. No extra connection setup is required.

If you build the Bridge from source, follow the [installation guide](docs/guides/installation.md). Do not reuse an old MCP plugin installation.

## Install the CLI

The package is installed from source. It is not distributed as a global npm package.

```bash
git clone https://github.com/zeefan1555/remnote-cli.git
cd remnote-cli
npm ci
npm run build
./link-cli.sh
remnote-cli --version
```

`./link-cli.sh` registers `remnote-cli` in the current npm prefix. Later builds in this checkout update the linked command. Run `./unlink-cli.sh` to remove it.

To run the build without registering a command, replace `remnote-cli` in the examples with `node dist/remnote-cli/index.js`.

## Verify the first connection

Start RemNote, then run:

```bash
remnote-cli status --text
```

A working connection starts with `Bridge: Connected`. The status also shows the active knowledge base, plugin ID `remnote-cli-bridge`, protocol version 2, and the live SDK version. Product versions do not need to match. Compatibility depends on protocol version 2 and the live SDK catalog.

You can inspect the machine-readable interface without RemNote running:

```bash
remnote-cli --help
remnote-cli contract
```

`contract` prints protocol, plan schemas, required SDK capabilities, receipt statuses, and exit codes. Use `--schema flashcards`, `--schema wiki`, or `--schema workspace` to inspect one plan schema.

## Find and read notes

`search` returns result IDs and metadata. Use `--content-mode` when you need note content in the search response.

```bash
remnote-cli search "project plan" --limit 10 --text
remnote-cli search "project plan" --content-mode structured --depth 2
remnote-cli read REM_ID --content-mode structured --depth 2
```

Pass one or more IDs to `read`. Use `--content-mode none` to read metadata only, or `--include-media-metadata` to find image IDs for `get-media`.

Page through large searches with the returned `nextCursor`. Reuse the cursor with the same query and scope.

## Gather bounded context

`context` reads a bounded set of Rems in one bridge session. Save the request as JSON, then pass it by path or through stdin.

```json
{
  "schemaVersion": 1,
  "remIds": ["REM_ID"],
  "subtreeRootIds": ["ROOT_ID"],
  "tagRemIds": [],
  "maxRems": 1000,
  "ancestorDepth": 20
}
```

```bash
remnote-cli context --request /tmp/context-request.json
printf '%s\n' '{"schemaVersion":1,"remIds":["REM_ID"],"maxRems":1000,"ancestorDepth":20}' | remnote-cli context --request -
```

Raw titles, text, and aliases are included only for IDs in `remIds`. Subtree and tag selectors return structural metadata and content hashes.

Use `verify scope` when a later step needs fresh proof for a parent, tag, type, child list, references, or card scope. It exits zero only when the requested evidence is complete and passes.

```bash
remnote-cli verify scope --expect /tmp/verify-request.json --summary
```

See [Read receipts](docs/guides/read-receipts.md) for request fields and receipt meanings.

## Inspect state

`inspect` returns generic Rem state in one connection. Select only the fields you need.

```bash
remnote-cli inspect REM_ID --fields markdown,tags,cards,children
remnote-cli inspect REM_ID --fields elements,isCardItem,hasCardStructure
remnote-cli inspect REM_ID --expect /tmp/rules.json --strict
```

Rules can compare exact fields, counts, hashes, and nested values. Without `--strict`, rule failures still appear in the result but do not change the exit code. Use [state verification](docs/guides/state-verification.md) to author reusable rules.

## Create flashcards

Flashcard plans target existing IDs. Save an inner `schemaVersion: 1` plan, preview it, then apply only the reviewed plan with the same stable idempotency key.

```json
{
  "schemaVersion": 1,
  "dailyRemId": "DAILY_ID",
  "homeRootId": "HOME_ID",
  "tagRemId": "TAG_ID",
  "title": "Spaced repetition",
  "newCards": [
    {
      "key": "interval",
      "question": "What does the interval control?",
      "answer": [["The time before the card appears again."]]
    }
  ]
}
```

```bash
remnote-cli flashcards apply --plan /tmp/flashcards.json --idempotency-key cards-2026-11-22
remnote-cli flashcards apply --plan /tmp/flashcards.json --idempotency-key cards-2026-11-22 --apply --summary
```

Preview is the default. `--apply` performs writes. The CLI does not choose or validate the calendar date. Pass an existing daily document and recheck the intended date before a new batch or after midnight.

Plan variants, text segments, limits, and receipt fields are documented in [Task plans](docs/guides/task-plans.md).

## Maintain a Wiki

Wiki plans identify one Wiki root, its partition, index, and log Rems. The plan below adds one page.

```json
{
  "schemaVersion": 1,
  "wikiRootId": "WIKI_ID",
  "partitionRemId": "PARTITION_ID",
  "indexRemId": "INDEX_ID",
  "logRemId": "LOG_ID",
  "pages": [
    {
      "key": "overview",
      "title": "Overview",
      "nodes": [{ "key": "scope", "text": ["Current scope."] }],
      "summary": ["Overview."]
    }
  ]
}
```

```bash
remnote-cli wiki apply --plan /tmp/wiki.json --idempotency-key wiki-2026-11-22
remnote-cli wiki apply --plan /tmp/wiki.json --idempotency-key wiki-2026-11-22 --apply --summary
```

The Wiki plan keeps grouped index entries in their reviewed parent and refuses missing or conflicting structure. A successful batch checks the affected objects. After the final Wiki write, run `verify scope` with the Wiki root and a `zeroCards` expectation for full task acceptance.

## Synchronize an Obsidian vault

Sync maps a private Markdown vault to bound RemNote IDs. Keep the vault outside code repositories and use a directory that no other process edits during a command.

Create the first baseline in a new, empty vault with an exact knowledge-base ID and root ID:

```bash
mkdir -m 700 /PRIVATE/remnote-vault
remnote-cli --kb-id KB_ID sync import /PRIVATE/remnote-vault --root-id ROOT_ID
```

After import, preview and apply changes from either side:

```bash
remnote-cli sync plan /PRIVATE/remnote-vault
remnote-cli sync apply /PRIVATE/remnote-vault
remnote-cli sync apply /PRIVATE/remnote-vault --path 'Projects/Plan.md'
```

`sync plan` performs no native writes. `sync apply` validates the whole vault, plans the selected changes, applies them, and verifies the result. `sync apply` does not use an `--apply` flag.

`--path` accepts repeatable vault-relative files or directories. It does not accept globs. With no path, sync selects the whole vault. The default `--scope changed` reads local changes and their dependencies. Use `--scope all` to reconcile all bound IDs in the selected area.

These commands inspect local state without changing RemNote:

```bash
remnote-cli sync status /PRIVATE/remnote-vault
remnote-cli sync lint /PRIVATE/remnote-vault
remnote-cli sync diff /PRIVATE/remnote-vault --path 'Projects'
```

File removal is not a delete command. Native deletion is a separate, bounded operation:

```bash
remnote-cli sync delete /PRIVATE/remnote-vault --id REM_ID --scope-root ROOT_ID
remnote-cli --allow-destructive sync delete /PRIVATE/remnote-vault --id REM_ID --scope-root ROOT_ID --apply --plan-hash HASH
```

The first command previews. The second requires an explicitly authorized deletion, `--allow-destructive`, `--apply`, and the preview's `--plan-hash`.

For the Markdown format, scope rules, conflict evidence, and recovery commands, use the [sync reference](docs/guides/remnote-cli-command-reference.md#sync).

## Preview, apply, and unknown writes

Commands with preview and apply modes preview by default. `flashcards apply` and `wiki apply` write only with `--apply`. `sync plan` previews, while `sync apply` is the write path.

Native writes are sequential, not atomic. A timeout, disconnect, `unknown` receipt, or lost response does not prove that no data changed. If a write is interrupted:

1. Stop the original writer.
2. Keep the reviewed plan, plan hash, idempotency key, journal, and every returned ID.
3. Read the exact IDs to reconcile the outcome.
4. Use a documented recovery command only when it accepts the original evidence.

Do not rerun the write or choose a new idempotency key to bypass uncertainty. Do not delete journals to force a fresh attempt. Some native update commands fail closed until the SDK can safely abort them. A preview receipt is not write approval.

## Knowledge-base boundary

`--kb-id` is an optional global guard. Put it before the command name.

```bash
remnote-cli --kb-id KB_ID search "architecture" --text
```

The option checks the Bridge's active knowledge base. It does not switch knowledge bases. A mismatch is an error. `sync import` requires `--kb-id` because it creates the first binding.

## Troubleshooting

If `status` reports `Not connected`, confirm that RemNote is open, RemNote CLI Bridge is enabled, and both permissions are granted. Bring RemNote to the foreground and retry. An unreachable Bridge can take up to 15 seconds to time out.

If a command reports a knowledge-base mismatch, read the target from the live `status` output. Do not use another ID to bypass the guard.

If a command reports `CLI port occupied`, run queued commands with `batch` or wait for the active command to finish. Do not stop an unknown process that uses the local listener.

If `update`, `replace-children`, `set-property`, or a TODO state change fails before mutation, the installed SDK does not provide a safe abort path for that operation. Use a supported preview or follow the command help. Do not retry a partial batch.

For detailed diagnosis, see [troubleshooting](docs/guides/remnote-cli-troubleshooting.md).

## Learn more

- [Installation](docs/guides/installation.md)
- [Command reference](docs/guides/remnote-cli-command-reference.md)
- [Task plans and receipts](docs/guides/task-plans.md)
- [Read receipts](docs/guides/read-receipts.md)
- [State verification](docs/guides/state-verification.md)
- [Advanced use cases](docs/advanced-use-cases.md)
- [Development setup](docs/guides/development-setup.md)
- [Integration testing](docs/guides/integration-testing.md)
- [Changelog](CHANGELOG.md)

MIT License. See [LICENSE](LICENSE).
