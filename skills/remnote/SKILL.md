---
name: remnote
description: Search, read, and write RemNote through remnote-cli. Require confirm write before mutating commands.
homepage: https://github.com/zeefan1555/remnote-direct
metadata:
  openclaw:
    requires:
      bins: [remnote-cli]
---

# RemNote CLI

Use the direct CLI for ordinary knowledge-base operations. A customized
`remnote-kb-navigation` skill can supply the user's exact root IDs; do not guess
IDs from an unconfigured template.

## Preconditions

- RemNote desktop is open with independent plugin `zeefan-remnote-sdk-bridge` enabled.
- CLI and plugin are paired with a private token for the exact intended KB.
- Official content and `KnowledgeBaseInfo: Read` permissions are granted.
- Run `remnote-cli status` and verify plugin ID, KB, protocol, SDK and live write flags.
- No MCP endpoint or business daemon is required. Local plugin loading uses a
  file-only static host; product versions need not match.
- Never request the private token in chat or include it in evidence.

See [installation](../../docs/guides/installation.md) and
[configuration](../../docs/guides/configuration.md).

## Safety

Default to reads and previews. Require the user's exact phrase `confirm write`
in the same turn before ordinary mutating commands. Preview is not write consent.
Destructive changes also require explicit replacement/deletion intent, both plugin
write gates and `--allow-destructive`.

Prefer one `remnote-cli` process per turn. Do not shell-chain separate processes:
each process owns the loopback port, and the next process can fail with
`CLI port occupied`. Use `batch --file commands.jsonl` to run several argv
commands on one connection, in order, and read each `results[]` entry.
Help, `--version`, and usage errors stay inside that envelope and later commands
still run. Put `--allow-destructive` on `batch` when an inner `sdk` call needs it.
`read` and `list-children` also accept multiple Rem IDs in one call. One ID keeps
the previous JSON object; several IDs return `results` keyed by ID.
Prefer file payloads (`--content-file`, `--plan`, `--request`,
`--expect`, `--file`) over shell interpolation. Write payloads are bounded to
100 KiB; a batch file is bounded to 1 MB and 100 commands. Inner batch commands
must not read stdin.
Use exact Rem IDs, not ambiguous tag names. Respect repository policy: live
development/acceptance tests run only through the guarded integration wrapper
after explicit authorization.

## Read And Discover

```bash
remnote-cli status
remnote-cli search "topic" --parent-id ROOT_ID
remnote-cli search "topic" --cards-only --include-review-stats
remnote-cli search-by-tag --tag-id TAG_ID
remnote-cli read REM_ID --content-mode structured --depth 1 --child-limit 100
remnote-cli read REM_ID OTHER_ID --content-mode none
remnote-cli list-children ROOT_ID
remnote-cli list-children ROOT_ID OTHER_ID
remnote-cli batch --file commands.jsonl
remnote-cli review-stats REM_ID
remnote-cli read-table --rem-id TABLE_ID
remnote-cli todo list --tag-id TAG_ID
remnote-cli sdk capabilities --status supported --mode read --text
remnote-cli sdk rem object-get-children-rem --help
```

JSON is preferred for ID-based follow-up work. Use shallow structured reads for
navigation, Markdown for presentation. Increase bounds only when needed.
SDK command help comes from the live catalog. Callback/private/stateful-handle
methods are unsupported; do not substitute arbitrary JavaScript.

## Authorized Writes

First check [ADR 0003](../../../../docs/adr/0003-disable-unsafe-native-transactions.md):
native transactions are disabled. Atomic update/replace/property/TODO apply commands
are unavailable. Additive create/journal/insert commands retain per-attempt recovery
keys and known IDs on failure; they are not atomic and must not be blindly replayed.

Use friendly commands when available: `create`, `update`, `insert-children`,
`update-tags`, `set-property` and `journal`.
`set-document-status`, `move-note`, `outline`, `todo complete|reopen`,
`flashcards apply` and `wiki apply` default to preview and need `--apply`.

Prefer additive `insert-children`. `replace-children` destroys child identities
and requires `--allow-destructive`; an empty payload clears content children.
Use stale-state guards where provided. Existing title/card/document identity and
exact tag/property semantics are documented in the
[command reference](../../docs/guides/remnote-cli-command-reference.md).

## Bounded Tasks

Use `context --request FILE` for bounded exact-ID metadata, then
`verify scope --expect FILE` for fresh proof. Raw text appears only for explicit
`remIds`; request it narrowly. Required subtree and inverse-tag scopes must not
be narrowed merely to pass. Incomplete evidence is not success.

`flashcards apply` and `wiki apply` take an inner schema-1 plan and stable
`--idempotency-key`. Preview first, then authorized apply. Existing text patches
require the current raw-text hash. Semantic receipt keys identify returned Rems;
never infer IDs from creation order. Multi-card flashcards do not receive the
Card Cluster powerup unless the plan sets `cardCluster: true` together with a
title and at least two new cards. Omitted or `false` leaves `cc` unset.
Flashcard questions accept a plain string or `TextSegments`. Use `{"remId":"EXACT_ID"}`
segments for native references. A plain string containing `[[` or `]]` is invalid.
An answer line may be one code block, `[{"code":"line1\nline2","language":"plaintext"}]`.
`language` defaults to `plaintext`. Apply stores `{i:"m",code:true,language,text}` and
sets `isCardItem` so the line is on the card back. Do not create that child with
`create` plus `object-set-text`; that child defaults to `isCardItem` false and is
omitted from the card back. Patching a code answer back to plain text keeps
`isCardItem` true. New-card and patch writes compare card facts before the text
write and again after `setIsCardItem`. On a mismatch, that `answerLines` entry has
`verified: false` and `error` set to the receipt message, and the receipt is not
verified. A passed line has `verified: true`. After apply, `answerLines` reports
each answer's `remId`, `isCardItem`, `hasCardStructure`, and `verified`. Preview
omits `answerLines`.

Use `--summary` on task apply and `verify scope` when only IDs/hashes, scopes, counts
and failures are needed. It does not change exit or recovery semantics. Wiki batch
receipts certify `verificationScope:affected_objects`, not the whole Wiki. After
the last Wiki mutation, explicitly verify the complete Wiki root with `zeroCards`
and `noCardStructure:true`; later Wiki changes invalidate that proof. Answer-only
patches do not cause a Wiki scan. Reuse already-reviewed content only if unchanged.

Task commands do not look up dates or create daily documents. The caller validates
the intended date before new batches/after midnight; same-key replay retains its
original diary. Wiki plain-node/duplicate/grouped-index guards remain mandatory.
There is no task rollback guarantee.

Keep evidence metadata-only: IDs, counts, checks and hashes, not KB titles,
text, aliases or review-history bodies. Exact semantic text readback is still
required before acceptance. See [read receipts](../../docs/guides/read-receipts.md)
and [task plans](../../docs/guides/task-plans.md).

## Recovery

Exit 0 means success; 1 includes validation, connection and incomplete-receipt
failures. Preserve available receipts on failure.

A timed-out or disconnected write may have taken effect. Preserve its exact plan,
key and local journal. Inspect known IDs and reconcile the outcome before another
authorized operation. Never blind-retry, change a plan under its key or remove a
journal/create a new key to bypass uncertainty.

For connection failures, check the exact KB, pairing, permissions and occupied
port. The plugin normally waits between commands. Bring RemNote to the foreground
for a read-only status retry if background timer throttling is suspected. Do not
stop arbitrary listeners, weaken KB binding or disable browser security.

Capabilities are fetched live per command. Journals and ID-only paging snapshots
are private local state, not an offline copy of the knowledge base.
