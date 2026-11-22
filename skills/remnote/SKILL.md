---
name: remnote
description: Search, read, write, or synchronize a private Obsidian vault and RemNote through remnote-cli within the user's authorized scope.
metadata:
  openclaw:
    requires:
      bins: [remnote-cli]
---

# RemNote CLI

Repository: [zeefan1555/remnote-cli](https://github.com/zeefan1555/remnote-cli).

Use the direct CLI for ordinary knowledge-base operations. A customized
`remnote-kb-navigation` skill can supply the user's exact root IDs; do not guess
IDs from an unconfigured template.

## Preconditions

Offline `sync read|save|status|lint|diff|format|relocate` needs only the bound private workspace.
Apply the connection prerequisites below to commands that contact RemNote.

- RemNote desktop is open with protocol 2 RemNote CLI Bridge (`remnote-cli-bridge`) enabled.
- No pairing token, endpoint, port, KB selection, or Bridge write setting is required. The CLI uses the live active KB.
- Official content and `KnowledgeBaseInfo: Read` permissions are granted.
- Run `remnote-cli doctor --text` for the aggregated diagnosis. If it fails,
  inspect its named check before retrying; `doctor --offline` never opens the Bridge.
- `status` remains the focused handshake read for plugin ID, active KB, protocol 2
  and SDK catalog hash.
- No MCP endpoint or business daemon is required. Local plugin loading uses a
  file-only static host; product versions need not match.
- Treat the current operating-system user as the trust boundary. Origin checking rejects ordinary webpages, not native same-user programs.

See [installation](../../docs/guides/installation.md) and
[configuration](../../docs/guides/configuration.md).

For machine-readable schemas and capability requirements while RemNote is closed,
run `remnote-cli contract`, `remnote-cli schema` or
`remnote-cli schema rem.search`. Select one plan schema with
`remnote-cli contract --schema flashcards|wiki|workspace`.

## Output Contract

JSON success is one stdout envelope:

```json
{"schemaVersion":2,"ok":true,"data":{}}
```

JSON failure is one stderr envelope with `error.type`, `error.subtype`,
`error.message`, optional `hint`, `retryable` and optional
`details`. Exit codes are 0 success, 1 internal, 2 usage, 3 configuration or
connection unavailable, 4 missing target or conflict, 5 unknown write outcome, and
6 unsupported capability. Read task receipts from `data` on success and from
`error.details` on a failed or incomplete result.

`unknown_outcome` means a write may have changed RemNote and is never
retryable. Reconcile exact affected IDs before another write. Text mode remains
human-readable and strips terminal control characters.

## Safety

Default to reads and previews. An explicit write request authorizes its specified
operation, target objects and scope throughout the same task; no fixed phrase or
routine per-turn reconfirmation is required. Inspection, review and preview alone
are not write consent. Clarify ambiguous targets or scope, scope expansions, or
overwriting unrecognized changes before writing. Stop on a user pause/revocation
or a real workflow Human Gate.

Check live status before writes and verify the exact resulting state by semantic
readback. Destructive changes also require explicit replacement/deletion intent
and `--allow-destructive`; official RemNote scopes remain the native permission
boundary.

Prefer one `remnote-cli` process per turn. Do not shell-chain separate processes:
each process owns the loopback port, and the next process can fail with
`CLI port occupied`. Use `batch --file commands.jsonl` to run several argv
commands on one connection, in order, and read each `results[]` entry.
Each entry includes `ok`, `exitCode`, and either `result` or a
structured `error`. Help, `--version`, and usage errors stay inside that
envelope and later commands still run. Put `--allow-destructive` on
`batch` when an inner `sdk` call needs it.
`rem read` and `rem children list` also accept multiple Rem IDs in one call. One ID keeps
the previous JSON object; several IDs return `results` keyed by ID.
Prefer file payloads (`--content-file`, `--plan`, `--request`,
`--expect`, `--file`) over shell interpolation. Ordinary native content payloads
are bounded to 100 KiB; task plans have no artificial file-size or object-count
ceiling. Workspace Markdown uses the sync reference's file bound. A batch file is
bounded to 1 MB and 100 commands. Inner batch commands must not read stdin.
Use exact Rem IDs, not ambiguous tag names. Respect repository policy: live
development/acceptance tests run only through the guarded integration wrapper
after explicit authorization.

## Read And Discover

```bash
remnote-cli status
remnote-cli doctor --text
remnote-cli doctor --offline
remnote-cli schema
remnote-cli rem search "topic" --parent-id ROOT_ID
remnote-cli rem search "topic" --all
remnote-cli rem search "topic" --cards-only --include-review-stats
remnote-cli rem search-by-tag --tag-id TAG_ID
remnote-cli rem read REM_ID --content-mode structured --depth 1 --child-limit 100
remnote-cli rem read REM_ID OTHER_ID --content-mode none
remnote-cli rem children list ROOT_ID
remnote-cli rem children list ROOT_ID --all
remnote-cli rem children list ROOT_ID OTHER_ID
remnote-cli batch --file commands.jsonl
remnote-cli rem inspect REM_ID --fields elements,markdown,tags,parent,portal,cards
remnote-cli rem assert --file rules.json --strict
remnote-cli rem powerup get --rem REM_ID --powerup sp --slot q
remnote-cli card review-stats REM_ID
remnote-cli table read --rem-id TABLE_ID
remnote-cli todo list --tag-id TAG_ID
remnote-cli sdk capabilities --status supported --mode read --text
remnote-cli sdk rem object-get-children-rem --help
remnote-cli sdk call rem:getChildrenRem --target-id REM_ID --args-json '[]'
```

JSON is preferred for ID-based follow-up work. Use shallow structured reads for
navigation, Markdown for presentation. Increase bounds only when needed.
`--all` follows every cursor page; `--max-pages` is an explicit optional
bound and requires `--all`. Require `data.paging.complete=true` when the
whole snapshot is needed, and preserve `nextCursor` when it is false.
`inspect` is the generic state read: one session, many IDs, optional descendants.
Code blocks are rich-text elements with `code:true`, not `rem.isCode`. Tag and parent
chains include names, ids, and types. Portal query/filter slots are `sp`/`q` and `sp`/`f`;
the CLI maps those codes to `Query` and `Filter` before the SDK call. The plugin does not.
`assert --file rules.json` checks that JSON with generic path rules, including `rems[*].field`.
Its report includes `complete` and read `errors`; `ok` is false when the read failed.
Add `--strict` when a failed rule or an incomplete read must fail with exit 4.
Compare `cards[].hash` to a baseline file to see that card
identity and history did not change. See
[state verification](../../docs/guides/state-verification.md).
SDK group and method help comes from the versioned facts shipped with the CLI, so
it works while RemNote is closed. Execution checks the live catalog hash and support
status. `sdk call <capability-id>` is the raw escape hatch for a supported live
capability. Callback/private/stateful-handle methods are unsupported; do not
substitute arbitrary JavaScript.

## Authorized Writes

First check [ADR 0003](../../docs/adr/0003-disable-unsafe-native-transactions.md):
native transactions are disabled. Atomic update/replace/property/TODO apply commands
are unavailable. Additive create/journal/insert commands retain per-attempt recovery
keys and known IDs on failure; they are not atomic and must not be blindly replayed.

Use friendly commands when available: `rem create`, `rem update`,
`rem children insert`, `rem tags update`, `rem property set` and `journal append`.
`rem document status`, `rem move`, `rem outline`, `todo complete|reopen`,
`card apply` and `wiki apply` default to preview and need `--apply`.

Prefer additive `rem children insert`. `rem children replace` destroys child identities
and requires `--allow-destructive`; an empty payload clears content children.
Use stale-state guards where provided. Existing title/card/document identity and
exact tag/property semantics are documented in the
[command reference](../../docs/guides/remnote-cli-command-reference.md).

## Task Plans

Use `rem context --request FILE` for bounded exact-ID metadata, then
`rem verify scope --expect FILE` for fresh proof. Raw text appears only for explicit
`remIds`; request it narrowly. Required subtree and inverse-tag scopes must not
be narrowed merely to pass. Incomplete evidence is not success.
Read a successful receipt from `data`. Failed or incomplete receipts use
`error.type=conflict` with the receipt preserved in `error.details`.
`error.type=unknown_outcome` with exit 5 is reserved for a write whose affected
objects cannot be identified.

`card apply` and `wiki apply` take an inner schema-1 plan and stable
`--idempotency-key`. Preview first, then authorized apply. Existing text patches
require the current raw-text hash. Semantic receipt keys identify returned Rems;
never infer IDs from creation order. Multi-card flashcards do not receive the
Card Cluster powerup unless the plan sets `cardCluster: true` together with a
title and at least two new cards. Omitted or `false` leaves `cc` unset.
Patch-only and reuse-only flashcard plans omit `dailyRemId`, `homeRootId`,
`tagRemId`, `parentRemId`, `title`, `cardCluster`, and `tags`; they target exact
existing card/answer Rems and do not consult daily or creation context.
The boundary parser normalizes flashcards to explicit `create`, `patch`, `reuse`,
or `mixed` variants with only the fields for their operations. Each variant
declares required official SDK capabilities; the live catalog is checked before
preview reads or the first mutation, and `missing_capability` is a hard stop.
Optional flashcard `tags` declares tags by semantic key, e.g.
`"tags":{"root":[],"card:a":["TAG_ID"]}`; then omit `homeRootId`/`tagRemId`. Every
created Rem ends with exactly its declared tags (none if undeclared), and a
`parentRemId` topic need not carry a tag. Declare final tags in the plan instead of
`rem tags update` afterwards, which breaks same-key replay. New-card plans without
`tags` use the implicit HOME tag plus `homeRootId` and `tagRemId`.
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

Task plans have no artificial card, answer, patch, page, node, alias or plan-file
size ceiling. Scaffold creation is partitioned before it reaches the transport.
When the command already has 32 SDK requests in flight, additional requests wait
instead of failing. Do not pre-split a valid reviewed plan merely to stay under an
implementation limit.

Use `--summary` on task apply and `verify scope` when only IDs/hashes, scopes, counts
and failures are needed. It does not change exit or recovery semantics. Wiki batch
receipts certify `verificationScope:affected_objects`, not the whole Wiki. After
the last Wiki mutation, explicitly verify the complete Wiki root with `zeroCards`
and `noCardStructure:true`; later Wiki changes invalidate that proof. Answer-only
patches do not cause a Wiki scan. Reuse already-reviewed content only if unchanged.

Within one `batch` process, `context` and `inspect` share a command-local read
session. Repeated exact Rem and field reads are de-duplicated with bounded concurrency;
any mutation clears it before later commands read again. The session never survives
the batch process.

Flashcard and workspace writes use the same mutation kernel: `started` is durable
before the native call, and only readback sets `verified`. A flashcard scaffold
becomes `applied` when every exact ID is durably saved; a later binding or content
failure is `partial` and resumes safely under the same key. `unknown` is reserved
for outcomes whose affected objects cannot be identified. Preserve the exact
plan/journal and reconcile IDs instead of blindly replaying.

Task commands do not look up dates or create daily documents. The caller validates
the intended date before new batches/after midnight; same-key replay retains its
original diary. Wiki plain-node/duplicate/grouped-index guards remain mandatory.
There is no task rollback guarantee.

Keep evidence metadata-only: IDs, counts, checks and hashes, not KB titles,
text, aliases or review-history bodies. Exact semantic text readback is still
required before acceptance. See [read receipts](../../docs/guides/read-receipts.md)
and [task plans](../../docs/guides/task-plans.md).

## Local-file synchronization

For local Markdown editing/import, read the [sync command reference](../../docs/guides/remnote-cli-command-reference.md#sync)
before creating a vault. Users in Obsidian and agents with file tools edit the same
human-readable Markdown files; RemNote is also an editable endpoint. Use a
common baseline for per-Rem semantic three-way merge. One-sided changes propagate,
equal changes converge and edits to different Rems merge. For conflicting
edits, use newer content only when trustworthy version evidence is comparable;
otherwise preserve both versions. Never use whole-file mtime, sync capture time or
review time to pick a winner. Review history and scheduling remain RemNote-owned;
local snapshots are read-only and must not be sent back.
Use an authorized private directory excluded from code Git. A separate private
Git repository may track content; network backup needs explicit user authorization.
To rename/move the vault, stop its other writers and use `sync relocate OLD NEW`.
It moves the directory and rebinds the private manifest offline, preserving dirty
files, identities and historical records. Never use a raw filesystem move or edit
the manifest mirror. Pending publication/writes, locks and an existing destination
are refused. After interruption, inspect both paths and the retained private receipt;
the same command only resumes its exact inode-bound operation. Unknown/stale locks
are never broken automatically. Repository remotes and Obsidian recent-vault lists
are outside this command's scope.
Ignore `.sync/`, locks and credentials. Exclude `.obsidian/`, `.trash/` and `.DS_Store` from content scans,
frozen plans and Git. Preserve user configuration and trash.

Use `sync import DIR` with an explicit KB and declared subtree or official archive
only for a new empty vault. Verify reported scope and completeness; repeated
import is not a merge. `sync` is a pure command group: use `sync plan DIR` for a
zero-native-write preview and `sync apply DIR` for execution, with no `--apply`
flag on apply. Do not restore root actions or `pull`/`push` aliases.
Preview/apply reports `incoming`, `outgoing`,
`converged`, `metadataRefresh` and archived `resolutions`. Continuous reads cover bound IDs only (batches
of at most 50), with `globalDiscoveryComplete: false`; new top-level roots are
outside scope. Missing objects, unknown children and reparenting must fail or
conflict. Direct Markdown edits followed by one `sync apply DIR` are the daily
path; no manual read/save/lint/diff/preview pipeline is required. When controlled
Agent edit clocks are needed, optionally use `sync read DIR PATH`, then
`sync save DIR PATH --content-file FILE --expected-file-hash HASH` with the same
read's hash. Save binds clocks only to changed semantic Rem versions and stays
offline. Same-Rem divergence uses whole-Rem
`version-time-lww` only with comparable, hash-bound clocks; otherwise it preserves
both versions as `untrusted-edit-order`. Direct file edits have no trusted clock,
and a no-op save cannot stamp them retroactively. Read the reference's version-time
limits: RemNote `updatedAt` is not a text-only clock. Inspect both archived versions
and the selected winner in `resolutions` before applying within the user's scope.
Edit supported list nodes only within the supported surface.
Keep the single hidden `<!-- remnote:document-key -->` before H1 and existing short
block anchors. No user attributes means no YAML. Optional title/aliases/tags are
display-only; only new multiline questions need `rems.<short-key>.content: multiline`
and a matching question anchor with direct leaf answer bullets. Existing types
come from identity-bound native records. Ordinary new bullets need no manual YAML
or anchors. Tracked `.remnote/identity.json` holds only KB/document/block identity;
native records, originals and card/history facts stay hidden and read-only.
Unknown YAML fields fail lint; unmappable native fields remain preserved sidecars.
Generated links use full paths; unique basenames and the named document's current H1 fragments resolve, while
ambiguous or broken targets fail. Local file moves do not move native Rems.
Portals and auxiliary reference areas are not ordinary diagnostic note text or
Obsidian dynamic queries. Unverified new embeds fail lint before remote writes.

New imports publish the human format. Explicit offline `sync format DIR` converts
only a complete, clean sealed legacy publication with no pending write journal,
preserving native/original records and making zero backend calls. Clean already-human
input is validated and canonically re-rendered while preserving attributes, anchors,
native records and clocks; `already-formatted` means no publication was needed.
Dirty input and damaged identity are refused, not recreated. This is not a
daily-sync fallback or a way to discard local edits.

Run `sync apply DIR` once within the user's write scope; it performs whole-vault
lint, fresh planning, guarded apply and verification. Plan/apply default to
`--scope changed` for locally dirty Rems and necessary dependencies. Repeat
`--path PATH` to filter vault-relative files/directories, not globs or patches;
confirm existing edits in a selected file are authorized too. `--scope all`
reconciles all bound IDs in the selected paths; no path means the entire vault.
Scope and path are independent, out-of-scope edits remain intact, and full-vault
local lint/identity/freeze still run. Changed scope is not a remote changes-since
feed. Offline `sync diff DIR` supports path filtering; status/lint stay full-vault.
Verification-only dependencies do not advance their native baseline or clocks;
later all-scope reconciliation must still discover their remote-only edits.
Clean changed/empty selections make no native calls. Layout-only apply may publish
selected files offline (`localPublished: true`, `remoteChecked: false`) while
preserving unselected bytes, all native records/clocks and a separate pending plan.
This receipt does not establish remote freshness.

`sync apply DIR --plan-hash HASH` requires a previously reviewed frozen plan with
matching normalized selectors, selected documents/IDs and all frozen vault files;
never reuse it for a materially different selection. The plan can include incoming
and outgoing changes; recheck both endpoints and advance the common baseline only
after semantic verification. Pre/post checks are optimistic, not an atomic native
conditional write: concurrent edits can still fall into the check-write window.
Native transactions stay disabled. Any lint error blocks the whole sync. Preserve opaque
content, native identity, parent/order and review history. Local renames preserve
Rem identity; missing files or remote objects are not automatic deletion or movement requests.
Deletion is independent: `sync delete DIR --id ID --scope-root ID` previews by
default; execution also requires `--apply --plan-hash HASH`, destructive
authorization and live write gates. It accepts no scope/path filters.
Finish with exact-ID semantic readback; represented metadata alone is not proof of
native writability or full import coverage.

Preserve journals on partial/unknown writes. `sync recover` only finishes local
publication after verified writes, with no remote replay; it is not permission
to retry an uncertain mutation. See the reference for recovery and live-test
entrypoints.

## Recovery

Exit 0 means success. Exit 3 means configuration or connection unavailable, 4 a
missing target/conflict/incomplete receipt, 5 an unknown write outcome, 2 invalid
input, 6 an unsupported capability, and 1 an internal failure. Parse the stderr
envelope for `error.type`, `error.hint` and `error.details`; preserve
available receipts on every failure.

A timed-out or disconnected write may have taken effect. Preserve its exact plan,
key and local journal. Inspect known IDs and reconcile the outcome before another
authorized operation. Never blind-retry, change a plan under its key or remove a
journal/create a new key to bypass uncertainty.

For connection failures, run `remnote-cli doctor --text` once and inspect the
named failing checks. Continue with protocol 2, official permissions and occupied
port checks only when the doctor report leaves them unresolved. The plugin normally
waits between commands. Bring RemNote to the foreground
for a read-only status retry if background timer throttling is suspected. Do not
stop arbitrary listeners, weaken KB binding or disable browser security.

Capabilities are fetched live per command. Journals and ID-only paging snapshots
are private local state. An explicitly authorized `sync` directory is a separate
authoring vault with the privacy boundary described above.
