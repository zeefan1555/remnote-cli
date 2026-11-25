---
name: remnote
description: Search, read, verify, and write RemNote through remnote-cli within the user's authorized scope.
metadata:
  openclaw:
    requires:
      bins: [remnote-cli]
---

# RemNote CLI

Use the direct CLI for ordinary knowledge-base operations. A customized
`remnote-kb-navigation` skill can supply the user's exact root IDs. Do not guess
IDs from an unconfigured template.

## Preconditions

- RemNote desktop is open with protocol 2 RemNote CLI Bridge (`remnote-cli-bridge`) enabled.
- The user granted official content and `KnowledgeBaseInfo: Read` permissions.
- Run `remnote-cli doctor --text` for aggregated diagnosis.
- `remnote-cli status` is the focused handshake read for plugin ID, active KB, protocol 2, and SDK catalog hash.
- No pairing token, endpoint setting, KB switching, MCP server, or business daemon is required.
- Treat the current operating-system user as the trust boundary. Origin checks reject ordinary webpages, not native same-user programs.

See [installation](../../docs/guides/installation.md) and
[configuration](../../docs/guides/configuration.md).

## Output contract

JSON success is one stdout envelope:

```json
{"schemaVersion":2,"ok":true,"data":{}}
```

JSON failure is one stderr envelope with `error.type`, `error.subtype`,
`error.message`, optional `hint`, `retryable`, and optional `details`.

Exit 0 is success. Exit 1 is internal. Exit 2 is usage. Exit 3 means
configuration or connection unavailable. Exit 4 means a missing target or
conflict. A write with an unknown outcome returns exit 5. Exit 6 means an unsupported
capability. Read receipts from `data` on success and from `error.details`
on a failed or incomplete result.

`unknown_outcome` means a write may have changed RemNote. Reconcile exact
affected IDs before another write. Text mode remains human-readable and strips
terminal control characters.

## Safety

Default to reads and previews. An explicit write request authorizes its specified
operation, targets, and scope throughout the same task. Inspection and preview do
not authorize a write. Ask before expanding scope or overwriting unrecognized
changes.

Check live status before writes and verify the resulting state by semantic
readback. Destructive changes require explicit intent and `--allow-destructive`.
Official RemNote permissions remain the native boundary.

Use one `remnote-cli` process per turn. Do not shell-chain separate processes
because each process owns the loopback port. Use `batch --file commands.jsonl`
to run several argv commands over one connection.

Use direct `--content` or stdin for native text. Use file payloads for `--content-file`, `--request`, `--expect`,
and `--file`. Native content payloads are bounded to 100 KiB. A batch file is
bounded to 1 MB and 100 commands. Inner batch commands cannot read stdin.

Use exact Rem IDs, not ambiguous names. Run live development acceptance tests only
through the guarded integration wrapper after explicit authorization.

## Read and discover

```bash
remnote-cli status
remnote-cli doctor --text
remnote-cli doctor --offline
remnote-cli schema
remnote-cli contract
remnote-cli rem search "topic" --parent-id ROOT_ID
remnote-cli rem search "topic" --all
remnote-cli rem search "topic" --cards-only --include-review-stats
remnote-cli rem search-by-tag --tag-id TAG_ID
remnote-cli rem read REM_ID --content-mode structured --depth 1 --child-limit 100
remnote-cli rem read REM_ID OTHER_ID --content-mode none
remnote-cli rem children list ROOT_ID
remnote-cli rem inspect REM_ID --fields elements,markdown,tags,parent,portal,cards
remnote-cli rem assert --file rules.json --strict
remnote-cli rem inspect REM_ID --fields cards,rawCards
remnote-cli table read --rem-id TABLE_ID
remnote-cli sdk capabilities --status supported --mode read --text
remnote-cli sdk call rem:getChildrenRem --target-id REM_ID --args-json '[]'
```

JSON is preferred for ID-based follow-up work. Use shallow structured reads for
navigation and Markdown for presentation. Increase bounds only when needed.

`--all` follows every cursor page. `--max-pages` is an optional explicit bound
and requires `--all`. Require `data.paging.complete=true` when the whole
snapshot is needed, and preserve `nextCursor` when it is false.

`rem inspect` is the generic state read. One session can read many IDs and
optional descendants. Code blocks are rich-text elements with `code:true`, not
`rem.isCode`. `rem assert --file rules.json` checks generic JSON path rules,
including `rems[*].field`. See [state verification](../../docs/guides/state-verification.md).

SDK group and method help comes from versioned facts shipped with the CLI, so it
works while RemNote is closed. Execution checks the live catalog hash and support
status. `sdk call` is the raw escape hatch for one supported live capability.
Callback, private, and stateful-handle methods are unsupported.

## Native TODOs

RemNote TODO identity comes from the Rem's native `isTodo` flag. Status comes from
`getTodoStatus()`: `Finished` or `Unfinished`. TODO is not identified by a tag
and does not change tag membership.

```bash
remnote-cli todo list --root-id ROOT_ID
remnote-cli todo list --root-id ROOT_ID --status finished
remnote-cli todo list --root-id ROOT_ID --status all
remnote-cli todo complete REM_ID
remnote-cli todo complete REM_ID --apply
remnote-cli todo reopen REM_ID
remnote-cli todo reopen REM_ID --apply
```

`todo list` scans one required exact root Rem and its descendants. It returns
only Rems where `isTodo()` is true. The status defaults to `Unfinished`.
`complete` and `reopen` preview by default and change only
`getTodoStatus()` or `setTodoStatus()` on an existing native TODO. They do not
add or remove tags.

Before apply, confirm the exact Rem is the intended native TODO. After apply, read
that exact Rem and require the requested native status. A timeout or disconnect
can leave the outcome unknown. Read the exact Rem before retrying.

## Authorized writes

Read [ADR 0003](../../docs/adr/0003-disable-unsafe-native-transactions.md). Native
transactions are disabled. Atomic update, child replacement, and property writes
remain unavailable. Additive create and insert commands keep recovery metadata
and known IDs on failure. They are not atomic and must not be replayed blindly.

Use friendly commands when available:

```bash
remnote-cli rem create
remnote-cli card create
remnote-cli rem update
remnote-cli rem update-answer
remnote-cli rem children insert
remnote-cli rem tags update
remnote-cli rem document status
remnote-cli rem move
remnote-cli rem outline collapse
remnote-cli rem outline expand
remnote-cli journal append
remnote-cli todo complete
remnote-cli todo reopen
```

Preview-first commands need `--apply` for execution. Prefer additive
`rem children insert`. `rem children replace` destroys child identities and
requires `--allow-destructive`. Use stale-state guards where provided.

## Review card creation

Run `remnote-cli card create --help` for official card syntax, then pass the
reviewed text directly to `--content`. Write multiline cards as ordinary Markdown
with real newlines. A blank line between answer bullets marks a section boundary;
the CLI converts it to RemNote's empty answer item. Leading, trailing and
between-card blank lines are removed. The command verifies separator text,
card-item status, parent, and native card identity before returning success. A
failed verification is an unknown outcome; use the reported IDs to read back,
not to replay the write. One invocation uses one parent and tag set.
RemNote determines the technical card type from the text; the CLI has no
`--card-type` option and no card plan or content-file mode. Ordinary `rem create`
keeps its existing content handling.

```bash
remnote-cli card create --content "Question >> Answer" --parent-id PARENT_REM_ID --tag-ids TAG_REM_ID

remnote-cli card create \\
  --content '- Question >>>
  - Why
  - Reason

  - How
  - Action' \\
  --parent-id PARENT_REM_ID \\
  --tag-ids TAG_REM_ID \\
  --kb-id KB_ID

remnote-cli rem update QUESTION_REM_ID --content "New question" --expected-text-hash CURRENT_TEXT_HASH
remnote-cli rem update-answer ANSWER_REM_ID --card-id QUESTION_REM_ID --content "New answer" --expected-text-hash CURRENT_ANSWER_TEXT_HASH
remnote-cli rem inspect QUESTION_REM_ID --fields cards,rawCards
```

`rem create` remains the generic note and Rem entry. Existing card reads, question
updates and direct-answer updates remain under `rem`.

`rem update` changes only the target Rem's own text and preserves its children.
`rem update-answer` requires an existing card-item directly under the exact card-generating
parent Rem. `--card-id` is that parent Rem ID, not a generated CardID.
Both content updates require the current raw-text SHA-256 from `rem context` with
the target in `remIds`; displayed text and `cards[].hash` are not raw-text hashes.
Updates verify text, parent, children, card-item status, CardIDs, creation time,
scheduling, and available history. Reconcile an unknown write by exact-ID readback
before another write.

`rem inspect --fields cards,rawCards` returns compact card facts plus native creation
time, full available review history, and scheduling. Missing native facts remain
`null`. `sdk card` remains the low-level SDK inspector.
Use `rem move` and `rem children insert` to move or reference an existing Rem.
See [read receipts](../../docs/guides/read-receipts.md) for context and scope verification.

## Batch read session

Within one `batch` process, `rem context` and `rem inspect` share a command-local
read session. Repeated exact Rem and field reads are de-duplicated with bounded
concurrency. Any mutation clears the session before later commands read again.
The session never survives the batch process.

## Recovery

Exit 0 requires successful completion. Exit 2 means invalid input. Exit 3 means
configuration or connection unavailable. Exit 4 means a missing target, conflict,
or incomplete receipt. A write with an unknown outcome returns exit 5. Exit 6 means an
unsupported capability. Exit 1 means an internal failure. Parse the stderr
envelope for `error.type`, `error.hint`, and
`error.details`. Preserve available receipts on failure.

A timed-out or disconnected write may have succeeded. Preserve the exact plan,
key, and local journal. Inspect known IDs and reconcile the outcome before another
authorized operation. Never blind-retry, change a plan under its key, generate a
new key to bypass uncertainty, or remove a journal to force a fresh attempt.

For connection failures, run `remnote-cli doctor --text` once. Inspect the named
failing checks. Do not stop arbitrary listeners, weaken KB binding, or disable
browser security.

Capabilities are fetched live per command. Journals and ID-only paging snapshots
are private local state.
