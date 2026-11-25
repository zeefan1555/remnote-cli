# RemNote CLI

`remnote-cli` gives scripts, coding agents, and people direct access to the active RemNote knowledge base. Each live command starts a short local connection to RemNote CLI Bridge, runs the requested SDK operations, and exits.

The CLI has no MCP server, background daemon, or cloud relay. Command output is JSON by default. Add the global `--text` option for human-readable output.

## Output contract

Every JSON command returns one versioned envelope.

```json
{
  "schemaVersion": 2,
  "ok": true,
  "data": {}
}
```

Success goes to stdout. A structured failure goes to stderr and keeps stdout empty.

```json
{
  "schemaVersion": 2,
  "ok": false,
  "error": {
    "type": "unknown_outcome",
    "subtype": "write_response_lost",
    "message": "SDK timeout; write outcome unknown. Do not blindly replay.",
    "hint": "Read the exact affected IDs before making another write.",
    "retryable": false
  }
}
```

Exit codes distinguish usage, connection, target conflicts, unsupported
capabilities and unknown write outcomes. `unknown_outcome` is never safe to retry
automatically. Text mode remains human-readable and strips terminal control
characters. See [Output and errors](docs/guides/output-and-errors.md).

## Commands

The root commands group stable product domains:

```text
Knowledge: rem, card, table, todo, media, journal
Diagnostics: batch, status, doctor, schema, contract
Raw SDK: sdk
```

Most note work uses `rem <action>`. Create review cards through `card create`;
`rem create` is the generic Rem and note entry. Other examples include `rem read`,
`rem search`, `rem children list`, `rem property set`, and guarded `rem delete`.
SDK group and method help is available offline; execution still checks the live
Bridge catalog.

## Requirements

- Node.js 22.13.0 or newer. Node.js 24 is recommended.
- RemNote desktop with the RemNote CLI Bridge plugin enabled.
- A shell on macOS or Linux for the source installation steps in this README.

The current operating-system user is the trust boundary. The CLI listener accepts only `null` and the exact official marketplace origin `https://www.remnoteplugins.com`, so ordinary webpages cannot connect. This check does not isolate a native process running as the same user, which can forge request headers. Do not run untrusted local programs while the Bridge is enabled.

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

The repository keeps "private": true and has no npm publish path. The local quality
gate builds the exact executable and runs npm run test:bin before completion.
See [Source installation](docs/guides/source-install.md).

## Verify the first connection

Start RemNote, then run:

```bash
remnote-cli status --text
```

A working connection starts with `Bridge: Connected`. The status also shows the active knowledge base, plugin ID `remnote-cli-bridge`, protocol version 2, and the live SDK version. Product versions do not need to match. Compatibility depends on protocol version 2 and the live SDK catalog.

Run the aggregated read-only diagnostic when setup or state looks wrong:

```bash
remnote-cli doctor --text
remnote-cli doctor --offline --json
```

Doctor checks Node, the CLI contract, state-directory access, the Bridge, plugin
identity, protocol, knowledge base, SDK catalog and local
journals. It never writes RemNote data or local state.

You can inspect the machine-readable interface without RemNote running:

```bash
remnote-cli --help
remnote-cli contract
remnote-cli schema
remnote-cli schema rem.search
```

`contract` prints protocol, SDK catalog identity, command metadata, output and
error contracts, and exit codes. Use `schema <command-path>` for command inputs.

`schema` lists every command path and whether it is a navigation group or an
executable action. Pass the command path to get positional arguments, options,
defaults and action-only risk or Bridge metadata:

```bash
remnote-cli schema
remnote-cli schema rem.search
remnote-cli schema rem.powerup.get
remnote-cli schema sdk rem
```

Every command is registered through one command catalog. Its Commander instance
and schema projection come from that registration, so schema and help cannot
drift. See [Command schema](docs/guides/command-schema.md).

See [Doctor](docs/guides/doctor.md) for status meanings and offline behavior.

## Find and read notes

`rem search` returns result IDs and metadata. Use `--content-mode` when you need note content in the search response.

```bash
remnote-cli rem search "project plan" --limit 10 --text
remnote-cli rem search "project plan" --content-mode structured --depth 2
remnote-cli rem read REM_ID --content-mode structured --depth 2
```

Pass one or more IDs to `rem read`. Use `--content-mode none` to read metadata only, or `--include-media-metadata` to find image IDs for `media get`.

Page through large searches with the returned `nextCursor`. Reuse the cursor with
the same query and scope. Use `--all` when the complete snapshot is required.

```bash
remnote-cli rem search "project plan" --all
remnote-cli rem search "project plan" --all --max-pages 20 --page-delay 100
```

`--all` follows every page by default. `--max-pages` is an explicit safety
bound, not a hidden default. The result contains a `paging` object with
`complete`, `pages`, `itemCount` and `nextCursor` when the result is incomplete.
The same options work for `rem search-by-tag` and single-parent `rem children list`.

## Gather bounded context

`rem context` reads a bounded set of Rems in one bridge session. Save the request as JSON, then pass it by path or through stdin.

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
remnote-cli rem context --request /tmp/context-request.json
printf '%s\n' '{"schemaVersion":1,"remIds":["REM_ID"],"maxRems":1000,"ancestorDepth":20}' | remnote-cli rem context --request -
```

Raw titles, text, and aliases are included only for IDs in `remIds`. Subtree and tag selectors return structural metadata and content hashes.

Use `rem verify scope` when a later step needs fresh proof for a parent, tag, type, child list, references, or card scope. It exits zero only when the requested evidence is complete and passes.

```bash
remnote-cli rem verify scope --expect /tmp/verify-request.json --summary
```

See [Read receipts](docs/guides/read-receipts.md) for request fields and receipt meanings.

## Inspect state

`rem inspect` returns generic Rem state in one connection. Select only the fields you need.

```bash
remnote-cli rem inspect REM_ID --fields markdown,tags,cards,children
remnote-cli rem inspect REM_ID --fields elements,isCardItem,hasCardStructure
remnote-cli rem inspect CARD_REM_ID --fields cards,rawCards
remnote-cli rem inspect REM_ID --expect /tmp/rules.json --strict
```

Rules can compare exact fields, counts, hashes, and nested values. Without `--strict`, rule failures still appear in the result but do not change the exit code. Use [state verification](docs/guides/state-verification.md) to author reusable rules.

### Replace existing Rem text

`rem update --content` replaces only the target Rem's own text. It preserves children.
Use `rem update-answer` for an existing card-item directly under an exact card-generating
parent Rem. `--card-id` means that parent Rem ID, not a generated CardID.

```bash
remnote-cli rem update QUESTION_REM_ID --content "New question" --expected-text-hash CURRENT_RAW_TEXT_HASH
remnote-cli rem update-answer ANSWER_REM_ID --card-id QUESTION_REM_ID --content "See [[id:SOURCE_REM_ID]]" --expected-text-hash CURRENT_ANSWER_TEXT_HASH
remnote-cli rem update QUESTION_REM_ID --content - --expected-text-hash CURRENT_RAW_TEXT_HASH
```

Both content commands require a 64-character lowercase SHA-256 hash of the current
raw rich text. Obtain `textHash` from `rem context --request` with the target in `remIds`.
Do not use the displayed title, Markdown, or `rem inspect`'s `cards[].hash` as the text hash.
Content accepts Markdown and the same `[[id:<remId>]]` native references as `rem create`.
`--content -` reads UTF-8 stdin. `--content` cannot be combined with `--title`,
`--add-aliases`, or `--remove-aliases`. Run separate commands for text and metadata updates.

Each content update uses one text setter without an outer transaction, then verifies
raw text, parent, children, card-item status, CardIDs, creation time, scheduling, and
available review history. The receipt contains exact IDs, hashes, `rawCards`, and
verification facts. Missing SDK history remains `null`, not an invented empty history.
`rem inspect --fields cards,rawCards` already reads these review facts. No new card
inspection command is needed. Reads and the write are not atomic. A failed or lost
write/readback reports `unknown_outcome`. Inspect the exact IDs before another write.
Metadata-only title and alias updates keep their existing behavior.

## Work with native TODOs

RemNote TODO state lives on the Rem. The CLI uses `isTodo()`,
`getTodoStatus()`, and `setTodoStatus()`. A TODO tag or the text `TODO` does
not identify a native TODO.

```bash
remnote-cli todo list --root-id ROOT_ID
remnote-cli todo list --root-id ROOT_ID --status all
remnote-cli todo complete REM_ID
remnote-cli todo complete REM_ID --apply
remnote-cli todo reopen REM_ID --apply
```

`todo list` scans one exact root Rem and its descendants. It shows unfinished
native TODOs by default. Complete and reopen preview by default. Apply changes only
the native status and then reads the exact Rem back.

## Create cards with official text

`card create` passes RemNote's official card text directly to the native parser.
Run `remnote-cli card create --help` for single-line, multiline and multi-card
examples.

```bash
remnote-cli card create --content "Question >> Answer" --parent-id PARENT_REM_ID --tag-ids TAG_REM_ID

remnote-cli card create \\
  --content '- Question >>>
  - Why
  - Reason

  - How
  - Action' \\
  --parent-id PARENT_REM_ID \\
  --tag-ids HOME_TAG_ID TERM_TAG_ID \\
  --kb-id KB_ID
```

Write multiline cards as ordinary Markdown with real newlines. A blank line
between answer bullets marks a section boundary; `card create` converts it to
RemNote's empty answer item. Leading, trailing and multi-card blank lines are
removed. Ordinary `rem create` input keeps its existing behavior.

One `--content` value can contain multiple cards. The native parser determines the
card direction and type. Use one parent and tag set per invocation. Read the created Rem IDs with
`rem inspect --fields cards,rawCards` to verify native card type, CardIDs, scheduling,
and available review history. Update question text with `rem update` and existing
direct answers with `rem update-answer`.

## Preview, apply, and unknown writes

Commands with preview and apply modes preview by default.
`todo complete` and `todo reopen` write only with `--apply`.

Native writes are sequential, not atomic. A timeout, disconnect, `unknown` receipt, or lost response does not prove that no data changed. If a write is interrupted:

1. Stop the original writer.
2. Keep the original input, expected hash, journal, and every returned ID.
3. Read the exact IDs to reconcile the outcome.
4. Use a documented recovery command only when it accepts the original evidence.

Capacity backpressure is not a failed write. When the Bridge already has 32 SDK
requests in flight, the CLI queues additional requests and continues as responses
arrive. Preserve returned IDs and recovery metadata when a write fails.

Do not rerun the write to bypass uncertainty. Do not delete journals to force a fresh attempt. Some native update commands fail closed until the SDK can safely abort them. A preview receipt is not write approval.

## Use SDK methods

SDK group and method help comes from versioned SDK facts shipped with the CLI. It
works while RemNote is closed. Execution still checks the live Bridge catalog.

```bash
remnote-cli sdk rem object-get-children-rem --help
remnote-cli sdk rem object-get-children-rem --target-id REM_ID --args-json '[]'
remnote-cli sdk call rem:getChildrenRem --target-id REM_ID --args-json '[]'
```

Use the generated group and method command when it exists. `sdk call` is the raw
escape hatch for one supported live capability. It does not bypass the Bridge
allowlist, live catalog hash, target requirements or destructive approval.

## Knowledge-base boundary

`--kb-id` is available on live leaf commands. Put it on the executable command.

```bash
remnote-cli rem search "architecture" --kb-id KB_ID --text
```

The option checks the Bridge's active knowledge base. It does not switch knowledge
bases. A mismatch is an error.

## Troubleshooting

If `status` reports `Not connected`, confirm that RemNote is open, RemNote CLI Bridge is enabled, and both permissions are granted. Bring RemNote to the foreground and retry. An unreachable Bridge can take up to 15 seconds to time out.

If a command reports a knowledge-base mismatch, read the target from the live `status` output. Do not use another ID to bypass the guard.

If a command reports `CLI port occupied`, run queued commands with `batch` or wait for the active command to finish. Do not stop an unknown process that uses the local listener.

Metadata-only `rem update`, `rem children replace`, and `rem property set` retain the
native transaction restriction. Content updates and native TODO status changes use
one SDK setter and exact readback instead. No command has a safe native abort path.
Use a supported preview or follow command help. Do not retry a partial batch.

For detailed diagnosis, see [troubleshooting](docs/guides/remnote-cli-troubleshooting.md).

## Learn more

- [Installation](docs/guides/installation.md)
- [Command reference](docs/guides/remnote-cli-command-reference.md)
- [Read receipts](docs/guides/read-receipts.md)
- [State verification](docs/guides/state-verification.md)
- [Advanced use cases](docs/advanced-use-cases.md)
- [Development setup](docs/guides/development-setup.md)
- [Integration testing](docs/guides/integration-testing.md)
- [Versioning](docs/guides/versioning.md)
- [Changelog](CHANGELOG.md)

MIT License. See [LICENSE](LICENSE).
