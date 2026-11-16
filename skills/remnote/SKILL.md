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

- RemNote desktop is open with RemNote CLI Bridge (`remnote-cli-bridge`) enabled. A plugin that still reports `zeefan-remnote-sdk-bridge` is accepted during the rename.
- CLI and plugin are paired with a private token for the exact intended KB.
- Both peers use protocol 2; the private file independently uses `schemaVersion: 1`.
  Unsupported old configuration stops before connecting and stays unchanged.
  Request explicit authorization for re-pairing or coordinated peer installation.
- Official content and `KnowledgeBaseInfo: Read` permissions are granted.
- Run `remnote-cli status` and verify plugin ID, KB, protocol, SDK and live write flags.
- No MCP endpoint or business daemon is required. Local plugin loading uses a
  file-only static host; product versions need not match.
- Never request the private token in chat or include it in evidence.

See [installation](../../docs/guides/installation.md) and
[configuration](../../docs/guides/configuration.md).

## Safety

Default to reads and previews. An explicit write request authorizes its specified
operation, target objects and scope throughout the same task; no fixed phrase or
routine per-turn reconfirmation is required. Inspection, review and preview alone
are not write consent. Clarify ambiguous targets or scope, scope expansions, or
overwriting unrecognized changes before writing. Stop on a user pause/revocation
or a real workflow Human Gate.

Check live status before writes and verify the exact resulting state by semantic
readback. Destructive changes also require explicit replacement/deletion intent,
both plugin write gates and `--allow-destructive`.

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
100 KiB for native content commands; workspace Markdown uses the sync reference's
file bound. A batch file is bounded to 1 MB and 100 commands. Inner batch commands
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
remnote-cli inspect REM_ID --fields elements,markdown,tags,parent,portal,cards
remnote-cli assert --file rules.json --strict
remnote-cli powerup get --rem REM_ID --powerup sp --slot q
remnote-cli review-stats REM_ID
remnote-cli read-table --rem-id TABLE_ID
remnote-cli todo list --tag-id TAG_ID
remnote-cli sdk capabilities --status supported --mode read --text
remnote-cli sdk rem object-get-children-rem --help
```

JSON is preferred for ID-based follow-up work. Use shallow structured reads for
navigation, Markdown for presentation. Increase bounds only when needed.
`inspect` is the generic state read: one session, many IDs, optional descendants.
Code blocks are rich-text elements with `code:true`, not `rem.isCode`. Tag and parent
chains include names, ids, and types. Portal query/filter slots are `sp`/`q` and `sp`/`f`;
the CLI maps those codes to `Query` and `Filter` before the SDK call. The plugin does not.
`assert --file rules.json` checks that JSON with generic path rules, including `rems[*].field`.
Its report includes `complete` and read `errors`; `ok` is false when the read failed.
Add `--strict` when a failed rule or an incomplete read must exit 1. Compare `cards[].hash` to a baseline file to see that card
identity and history did not change. See
[state verification](../../docs/guides/state-verification.md).
SDK command help comes from the live catalog. Callback/private/stateful-handle
methods are unsupported; do not substitute arbitrary JavaScript.

## Authorized Writes

For content bound to a local-authoritative sync workspace, edit the local file
and publish it with `sync apply`; do not use direct native write commands on that
content. Exact feedback capture and post-publication acknowledgement follow the
separate procedure below. The direct commands in this section apply only outside
that mirrored content.

First check [ADR 0003](../../docs/adr/0003-disable-unsafe-native-transactions.md):
native transactions are disabled. Atomic update/replace/property/TODO apply commands
are unavailable. Additive create/journal/insert commands retain per-attempt recovery
keys and known IDs on failure; they are not atomic and must not be blindly replayed.

Use friendly commands when available: `create`, `update`, `insert-children`,
`update-tags`, `set-property` and `journal`.
`set-document-status`, `move-note`, `outline`,
`flashcards apply` and `wiki apply` default to preview and need `--apply`.

Prefer additive `insert-children`. `replace-children` destroys child identities
and requires `--allow-destructive`; an empty payload clears content children.
Use stale-state guards where provided. Existing title/card/document identity and
exact tag/property semantics are documented in the
[command reference](../../docs/guides/remnote-cli-command-reference.md).

## Explicit Feedback

Ordinary learning edits local source and uses the guarded publisher; ordinary sync
never captures TODOs. For an explicitly requested feedback task, use
`sync feedback capture DIR --id ID --target-id TARGET`, edit the returned target's
local file, then publish that file with `sync apply --path PATH --expected-file-hash HASH`.
Only after complete local publication, use
`--allow-destructive sync feedback ack DIR --receipt HASH --plan-hash HASH`.
Ack never publishes content; retry the same ack after an unknown outcome, not the
publisher. It recognizes only the exact recorded after-state and otherwise stops.

This path requires prior `sync feedback bind DIR --todo-tag-id ID --done-tag-id ID`:
clean, already-aligned source and exact sealed role identities. Bind records roles
only; unknown per-Rem tags and partitions remain unknown. Bind never edits
Markdown or initializes missing native evidence; existing authored role tokens
are a reported blocker. Only with explicit baseline-initialization authorization,
use `sync baseline-align DIR [--path PATH]` to preview missing observations, then
the same selectors with `--apply --plan-hash HASH`; see the command reference.
After role binding, alignment refuses TODO/DONE lifecycle tags, unknown direct
tags, nonempty feedback partitions and physical-child drift before local writes.
Before role binding, alignment refuses unknown nonempty native tags; an observed
empty set is allowed. Native-source and exact-new-child adoption are disabled:
unbound content can be TODO feedback even without a tag. Capture requires clean source, one separate direct
physical non-card TODO subtree, and a preexisting exact native reference plus
reciprocal backlink to each canonical target in one file. Plain feedback without
that native link, canonical TODO nodes, Portals/cards, and no-change confirmation
are unsupported. Capture is private evidence, never imported content. Ack requires
a later verified target-content publication, fresh card/history/link proof and
both live write gates; it durably finishes checkbox, adds DONE, removes TODO
without deleting properties. Unknown history, changed revisions and old/no-op
publisher proofs block all acknowledgment writes. `todo list` is read-only;
the old transaction-based complete/reopen writer has been removed.

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
Optional flashcard `tags` declares tags by semantic key, e.g.
`"tags":{"root":[],"card:a":["TAG_ID"]}`; then omit `homeRootId`/`tagRemId`. Every
created Rem ends with exactly its declared tags (none if undeclared), and a
`parentRemId` topic need not carry a tag. Declare final tags in the plan instead of
`update-tags` afterwards, which breaks same-key replay. Without `tags` the implicit
HOME tagging is unchanged.
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

## Local-file synchronization

For local Markdown editing/import, read the [sync command reference](../../docs/guides/remnote-cli-command-reference.md#sync)
before creating a vault. Users in Obsidian and agents with file tools edit the same
human-readable Markdown files. After explicit empty-vault import, local source is
the sole content authority and RemNote is the publishing/review target. Compare
baseline B, local L and native R: publish L when R=B; accept equal L=R; otherwise
archive native content/tag drift and stop the whole batch with zero writes.
Native-only children are structural conflicts, never recursive source imports.
Review history, scheduling and native runtime flags remain remote-owned snapshots,
not fields to write. Timestamps never choose content.
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
Read, plan and execution receipts declare fixed `contentAuthority: "local"`.
Automated callers must verify it on `sync read` before applying; absence rejects
an older CLI before it can run a two-way write. Preview/apply reports `outgoing`,
`converged`, `metadataRefresh` and archived `remote-content-drift` conflicts.
Read selected bound IDs only; do not discover/import native-only descendants.
Missing objects, movement and reordering remain explicit failures/conflicts.
Direct Markdown edits followed by one `sync apply DIR` are the daily path.
For guarded edits use `sync read DIR PATH`, then `sync save DIR PATH
--content-file FILE --expected-file-hash HASH`. Save stays offline and binds bytes,
not clocks. Old clock fields are retained as sealed evidence, never read as policy.
Old pending journals without local authority or with incoming/winner evidence
must remain intact and fail closed; do not migrate or delete them to resume.
A normal publish never scans TODOs. Explicit feedback processing is a separate
caller workflow: read exact feedback, change local source, publish and verify,
then acknowledge. This layer does not implement native TODO acknowledgement.
Edit supported list nodes only within the supported surface.
Keep the single hidden `<!-- remnote:document-key -->` before H1 and existing short
block anchors. No user attributes means no YAML. Optional title/aliases are
display-only. YAML tags map only document/root memberships; bullet inline tags map
only that Rem's direct memberships through sealed exact-ID `tagIds`. An unused
existing tag resolves only by a complete unique sealed native ancestor path:
no basename guesses or tag creation. Candidate bindings join the frozen plan;
their native targets/ancestors are checked before any write and the registry is
updated only on successful publication. Unknown or colliding tokens fail before connection.
New multiline questions need `rems.<short-key>.content: multiline`
and a matching question anchor with direct leaf answer bullets. Existing types
come from identity-bound native records. Edit an existing answer's text in place;
adding or deleting individual answers of an existing multiline card is unsupported.
A new multiline card can include answers when created. A direct text answer leaf may be empty
with a stable anchor; it is a cardItem, never an empty topic/question or standalone card.
Ordinary new bullets need no manual YAML
or anchors. Tracked `.remnote/identity.json` holds KB/document/block and tag-token identity;
native records, originals and card/history facts stay hidden and read-only.
Unknown YAML fields fail lint; unmappable native fields remain preserved sidecars.
Generated links use full paths; unique basenames and the named document's current H1 fragments resolve, while
ambiguous or broken targets fail. Local file moves do not move native Rems.
Portals and auxiliary reference areas are not ordinary diagnostic note text or
Obsidian dynamic queries. Unverified new embeds fail lint before remote writes.
Existing explicit reference labels in readonly projections are sealed local
presentation: target renames preserve them, including during canonical rendering
and publication recovery. Editing those labels still fails lint before writes;
native reference IDs, surrounding content and Portal structure remain sealed too.

New imports publish the human format. Explicit offline `sync format DIR` converts
only a complete, clean sealed legacy publication with no pending write journal,
preserving native/original records and making zero backend calls. Clean already-human
input is validated and canonically re-rendered while preserving attributes, anchors,
native records and sealed evidence; `already-formatted` means no publication was needed.
Dirty input and damaged identity are refused, not recreated. This is not a
daily-sync fallback or a way to discard local edits.
Missing `tagIds` requires this explicit clean format step; old nonempty display-only
YAML tags require a user decision rather than automatic reinterpretation.

Run `sync apply DIR` once within the user's write scope; it performs whole-vault
lint, fresh planning, guarded apply and verification. Plan/apply default to
`--scope changed` probes locally dirty selected documents and required dependencies,
then reads full native detail only where needed. Repeat
`--path PATH` to filter vault-relative files/directories, not globs or patches;
confirm existing edits in a selected file are authorized too. `--scope all`
also audits full native flags/cards in the selected paths; no path means the entire vault.
Scope and path are independent, out-of-scope edits remain intact, and full-vault
local lint/identity/freeze still run. Changed scope is not a remote changes-since
feed. Offline `sync diff DIR` supports path filtering; status/lint stay full-vault.
Verification-only dependencies do not advance their native baseline;
later selected reconciliation still detects their remote-content drift.
Clean changed or empty selections make no native calls and cannot establish remote
freshness. For a shared checker that needs
input-bound native evidence, use `sync read DIR PATH` and then exactly one
`sync apply DIR --path PATH --expected-file-hash HASH`. This audits the exact file
and direct-tag ancestors and returns the outline plus same-invocation native
before/after proofs described in the reference. Unknown facts remain unknown.
For a new ordinary text topic only, declare `rems.<short-key>.cardCluster: true`.
The same sync journal calls `addPowerup('cc')`, verifies `hasPowerup` and consumes
the creation intent after publication. Root/cardItem/question and existing-object
capability changes are refused. Before apply, outline `intent.cardCluster` denotes
intent and `observed` remains null; after apply cc must be a native observation.
Never pretend that a tag named cc is the Powerup. Normal probes verify known cc too.
Guarded journals preserve original nativeBefore and input binding before writes;
exact-plan resume returns that original proof plus fresh nativeAfter, never
fabricating a before-history from recovery-time values.
Default apply checks fresh SDK histories of the actually affected surviving Cards
before any mutation, including a changed answer's owning question. Unknown
Card/history blocks; an observed empty history array is valid. Guarded callers
may repeat `--require-history-rem ID` for other exact existing selected Cards.
Automated callers pass `--require-sdk-history-guard` to reject older CLIs before
apply. Verify `historyVerification` before/after over its exact `checkedRemIds`;
it describes only SDK-returned arrays, not all server history or atomic writes.

Direct tags are local desired memberships, not set-merged feedback. Tag removal keeps native properties
via `removeTag(id, false)`. Each exact planned removal is narrowly authorized and
still requires both live plugin write gates. Check `plan.tagChanges` and `requiredPermissions`;
missing permission refuses all writes, including prior text/add operations.

`sync apply DIR --plan-hash HASH` requires a previously reviewed frozen plan with
matching normalized selectors, selected documents/IDs and all frozen vault files;
never reuse it for a materially different selection. The plan contains local outgoing changes and verified convergence; recheck both endpoints and advance the common baseline only
after semantic verification. Pre/post checks are optimistic, not an atomic native
conditional write: concurrent edits can still fall into the check-write window.
Native transactions stay disabled. Any lint error blocks the whole sync. Preserve opaque
content, native identity, parent/order and review history. Local renames preserve
Rem identity; missing tracked local nodes or files are deletion intent within the
selected scope. `sync apply DIR` removes the exact verified mirror identities;
remote absence or drift is not inferred as local deletion. Both plugin write gates
remain mandatory, unknown outcomes are never retried automatically.
Deletion requires existing, exact TODO/DONE roles bound in advance, with observed
empty feedback partitions and no TODO/DONE tag on every deleted Rem and surviving
parent; unknown or changed evidence stops deletion. Never guess or create tags to
bypass this. Native-source adoption is disabled regardless of binding. Ordinary edits do not
require feedback binding. These checks are optimistic, not atomic CAS.
Missing directories, identity collisions, and an entire multi-document directory
disappearing fail closed; directory deletion is unsupported. Any new nodes
alongside deletion are ambiguous and must be synchronized separately; deleting only an existing multiline answer
is blocked because surviving Card identity is not proven stable. Locally retained
references are checked, including opaque content, but unselected/unbound native
backlinks and uncollected relationships are not globally discovered. Deletion receipts only claim preservation
of checked surviving Card identities, not deleted cards or review history.
Finish with exact-ID semantic readback; represented metadata alone is not proof of
native writability or full import coverage.

Preserve journals on partial/unknown writes. `sync recover` only finishes local
publication after verified writes, with no remote replay; it is not permission
to retry an uncertain mutation. See the reference for recovery and live-test
entrypoints.

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
are private local state. An explicitly authorized `sync` directory is a separate
authoring vault with the privacy boundary described above.
