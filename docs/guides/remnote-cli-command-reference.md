# remnote-cli Command Reference

`remnote-cli` is automation-first: JSON is the default output mode. Use `--text` for human-readable output.

## Invocation

```bash
remnote-cli [global-options] <command> [command-options]
```

Live commands require RemNote open with the protocol 2 RemNote CLI Bridge enabled.
`sync read`, `sync save`, `sync status`, `sync lint`, `sync diff`, `sync format` and `sync relocate` operate offline. A live command owns a
short-lived loopback connection; no daemon or MCP endpoint is used.
No pairing or initialization command is required. The CLI uses the Bridge's active
knowledge base. See [configuration](configuration.md) for permissions and state paths.

### Native Transaction Restriction

SDK 0.0.46 cannot safely abort a native transaction. `update`, `replace-children`,
`set-property` and changed TODO `--apply` operations fail before mutation.
`create`, `journal` and `insert-children` perform sequential additive writes with
private recovery journals, not atomic transactions. A failure can leave partial
content: retain the reported key/IDs and read back before retrying. Use the task
commands for stable-key replay. See [ADR 0003](../adr/0003-disable-unsafe-native-transactions.md).

## Global Options

| Flag              | Default                         | Description                         |
| ----------------- | ------------------------------- | ----------------------------------- |
| `--json`          | enabled                         | JSON output mode                    |
| `--text`          | off                             | Human-readable output mode          |
| `--kb-id <id>` | active Bridge KB | Require this exact active knowledge base |
| `--allow-destructive` | off | Explicitly authorize destructive SDK calls |
| `--verbose` | off | Emit connection and SDK timings to stderr |
| `--version`       | n/a                             | Show CLI version                    |
| `--help`          | n/a                             | Show help                           |

### Output mode rules

- JSON is the default when no output flag is provided.
- If both `--json` and `--text` are passed, `--text` wins.

### Argument Quoting and Shifting

CLI environments (especially Windows shells) can sometimes "swallow" empty strings or misinterpret arguments if quoting is missing. This can lead to **argument shifting**, where a flag (like `--content`) is incorrectly interpreted as the _value_ for a preceding option (like `--title`).

To prevent this:

1. **Always quote** text values that contain spaces or special characters.
2. **Use explicit equality** for potentially empty values: `--title=""`.
3. `remnote-cli` includes **shifting detection**: if an option value matches a registered global or local flag, the command will fail early with an error message to prevent accidental mis-execution.

## Exit Codes

| Code | Meaning                                 |
| ---- | --------------------------------------- |
| `0`  | Success                                 |
| `1` | Validation, connection, command error or incomplete receipt |

## sync

The private Obsidian vault and RemNote are both editable endpoints. Users in
Obsidian and agents edit the **same Markdown files**; a user may also edit cards
during RemNote review. The candidate uses a common baseline and per-Rem semantic
three-way merging. The receipts below describe the current source contract;
offline tests are not native acceptance or a release claim. Legacy `pull`/`push`
aliases are removed.

`sync` is a pure command group. The commands below are separate entry points,
not a required pipeline. After editing, daily synchronization needs only
`sync apply DIR` within the authorized scope; it has no `--apply` flag. `DIR`
below is the authorized private vault's absolute path.

| Scenario | Command and boundary |
| --- | --- |
| Initial import | `remnote-cli --kb-id KB_ID sync import DIR --root-id ROOT_ID`, or `--export /PRIVATE/export.rem`; a new empty vault only |
| Daily local changes | `remnote-cli sync apply DIR`; defaults to `--scope changed`, plans and applies in one invocation |
| One file or directory | `remnote-cli sync apply DIR --path 'Folder/Note.md' --path 'OtherFolder'`; repeatable path filtering, not patch selection |
| Reconcile a selected area | `remnote-cli sync apply DIR --scope all --path 'Folder'`; all bound IDs inside that selection |
| Reconcile all bound IDs | `remnote-cli sync apply DIR --scope all`; no path filter, no new-root discovery |
| Preview / approved plan | `remnote-cli sync plan DIR` has zero native writes; `sync apply DIR --plan-hash HASH` requires the same frozen plan and selectors |
| Offline inspection | `remnote-cli sync diff DIR --path 'Folder'`; `sync lint DIR` and `sync status DIR` remain whole-vault |
| Explicit deletion | `remnote-cli sync delete DIR --id ID --scope-root ID` previews; execution additionally requires `--apply --plan-hash HASH`, destructive authorization and live gates |
| Guarded local edit | `remnote-cli sync read DIR PATH`, then optionally `sync save DIR PATH --content-file FILE --expected-file-hash HASH`; offline, not a daily prerequisite |
| Format conversion | `remnote-cli sync format DIR`; convert or canonically re-render a clean sealed publication, zero backend calls |
| Interrupted outgoing sync | `remnote-cli sync resume DIR --plan-hash HASH`; exact original plan and IDs only, no new scope/path selectors, never replay an uncertain write |
| Local publication recovery | `remnote-cli sync recover DIR` only finishes verified local publication; preserve exact plans, journals and IDs |

### Scope and path selection

Plan and apply share `--scope changed|all` (default `changed`) and repeatable
`--path PATH`. These are independent dimensions: scope chooses changed Rems or
all bound IDs, while path chooses the files/directories containing them. With no
path filter, the selection is the entire vault. Changed scope reads locally dirty
Rems plus necessary dependencies; all scope reconciles every bound ID in selected
documents, including remote-only edits. Neither is a remote changes-since API.

Paths are vault-relative Markdown files or directories, not globs or native IDs.
Repeated/equivalent paths such as `Folder` and `./Folder` are normalized and
deduplicated. Missing paths, paths outside the vault, symlinks and non-content
files are rejected. An existing directory with no content Markdown is a valid
empty selection: it returns offline `unchanged`, `remoteChecked: false`, with no
remote reads. Path filtering is not hunk selection; existing unsynced edits in a
selected file remain in scope. Out-of-scope changes are not absorbed into the
baseline or overwritten by publication.

Every selection still runs full-vault local lint, identity validation and frozen
file checks. A scoped command cannot bypass invalid content elsewhere.
`sync diff DIR` accepts the same path filter but is offline and has no scope selector.
Status/lint inspect the whole vault. Delete has its own exact ID/root boundary,
not scope/path filters. There are no root sync actions, push/pull aliases, force,
since, daemon or arbitrary conflict-winner options.

### Initial import and privacy

`sync import` publishes the human-readable format by default. It requires explicit global `--kb-id` and a new directory without
content or a prior manifest. It establishes the initial common baseline; even a
clean existing vault cannot be re-imported. Later edits from either endpoint are
inputs to three-way sync. Re-importing or overwriting a whole file is not a merge.

| Import option | Scope |
| --- | --- |
| `--root-id ID` | One exact native subtree in a new dedicated vault |
| `--export FILE.rem` | Official full JSON archive with original records and snapshot provenance |
| `--snapshot FILE` | Optional public SDK snapshot bound to the exact archive and KB |
| `--editable-root-id ID` | Fully inspect the selected subtree during official import before enabling supported edits |

`--snapshot` requires `--export`; `--root-id` is an independent scope, not an
editable-root modifier. Archive IDs, relationships and provenance are validated;
raw short codes do not certify writable semantics. The import receipt reports
`status: "imported"`, `complete`, `scope`, `rootIds`,
`globalDiscoveryComplete`, counts and `git: "unchanged"`. Completeness is
limited to the declared scope and snapshot time. Subtree or known-ID inspection
cannot discover new top-level roots or prove current global completeness.

Continuous sync reads bound IDs only, using public `findMany` batches of at most
50. Its receipts always report `discoveryScope: "bound-ids"` and
`globalDiscoveryComplete: false`; this is distinct from the historic initial
import receipt. Unknown children, missing objects and reparenting are explicit
failures or conflicts, not silently omitted content. New top-level roots are not
discoverable in this scope. Public `getAll` exceeds the current Bridge serializer's
1,000-item limit, and empty siblings on parentless anchors do not enumerate roots.
Global discovery needs a separately authorized Bridge change, release and device
update; it is not supplied by this CLI change.

The vault root must be 0700. Markdown saved normally by Obsidian may be 0644;
CLI-created Markdown is 0600. Native sidecars and runtime state remain 0600.
Symlinks are not a content access path. Keep a separately authorized private
content Git repository; network backup needs explicit user authorization. Sync
does not configure Git or publish files. Content must stay out of code
repositories and public evidence.

Ignore `.sync/`, locks and credentials in content Git. Exclude `.obsidian/`,
`.trash/` and `.DS_Store` from content scanning, candidate freeze and Git.
Do not delete user configuration or Trash to make validation pass. Private CLI
state holds authoritative manifests and metadata journals; vault state is not
independent permission to bypass those guards.
Only root `AGENTS.md` and exact `.agents/skills/remnote-obsidian/SKILL.md` are excluded
from content parsing as tooling documents; they are still scanned and frozen.
Other `README.md` or `SKILL.md` files are not silently exempt from content lint.

`sync relocate OLD NEW` moves the existing private directory and rebinds its
authoritative manifest offline. Stop all other filesystem writers first: Node's
rename is not atomic no-replace, so destination prechecks do not close the external
check/rename race. Content, dirty files,
identity records, Git files and historical `.sync/` records are moved unchanged;
only the current manifest's directory binding and mirror change. RemNote receives
zero calls. Existing destinations (including orphaned CLI manifests), symlink
aliases, nested paths, different filesystems, incomplete baselines and pending
publication/native journals are refused. The command does not change Git remotes
or Obsidian's recent-vault list.

A durable private relocation receipt binds the exact paths, source inode/device
and original state hash before rename. After failure, inspect both paths and the
receipt before rerunning the same command. Recovery accepts only that directory
and the exact original/new manifests and mirror; the old manifest remains until
new-authority/mirror readback succeeds. Unknown writer locks are never broken
automatically: inspect their recorded process and pending outcome first. Do not
raw-move a bound directory, rewrite its mirror, or substitute another destination.
Caught failures release the same owned lock inode; a hard kill can leave a lock
and requires manual outcome inspection. Failure-injection tests are not proof of
automatic recovery after process death or power loss.

Lossless native records live in `.remnote/records/ID.json`; imported payloads
live under `.remnote/originals/{rems,cards,public}/`. These read-only sidecars
belong in private content Git and are hidden in Obsidian's normal file tree.
They are not disposable cache or part of `.sync/` runtime state.
Tracked `.remnote/identity.json` is a schema/KB/document/block-to-Rem identity
projection, derived from the authoritative manifest; it does not duplicate native
records, card history or scheduling. Native truth stays in records/originals.

Markdown, individual native/original records and other ordinary files are limited
to 4 MiB each. Only the aggregate `.remnote/identity.json`, `.remnote/originals/manifest.json` and
`.sync/state.json` use a 32 MiB bound, matching the private CLI manifest and
publication stores. Import/publication prechecks the final serialized UTF-8 bytes
of every payload, the state mirror and the complete publication ledger before
writing any staging content. Staged/displaced files inherit their destination's
bound; reading, freezing, integrity checks and recovery enforce the same limits.
Oversized metadata is rejected without truncation or relaxing individual-file limits.

### Guarded local editing

Users and agents may edit the same Markdown directly, then run `sync apply DIR`
once. Separate read/save/lint/diff/preview commands are not a required daily pipeline.
For guarded editing and trusted local version clocks, use `sync read DIR PATH` to obtain the complete tracked Markdown `content`
and its `fileHash` from the same read, then edit that source and call `sync save`
with the returned hash and complete `--content-file` (or `-` for stdin). `PATH` is
the exact workspace-relative Markdown path, not a native Rem ID. Both commands
are offline and report `remoteWrites: 0`; read returns `status: "read"`, and save
returns `status: "saved"` or `"unchanged"`, the resulting `fileHash` and changed
Rem keys. Copy the returned hash verbatim rather than substituting a file mtime.

Save validates the entire workspace and rejects a stale hash before publication.
Only Rems whose semantic front/back content changed receive a millisecond local
version timestamp bound to their content hash. New Rems use engine-generated temporary keys in the same
path and lose those temporary clocks after verified native-ID assignment. No-op
or formatting-only saves do not retime content. The source and clock metadata use
the existing staged publication/recovery mechanism, without advancing the native
baseline; `sync recover` finishes an interrupted save with its original timestamp.

Obsidian or direct file edits remain valid one-sided sync input, but do not gain
a trusted per-Rem clock. Saving an already-edited file unchanged cannot add one
retroactively. Use guarded save for Agent edits when automatic same-Rem resolution
is needed. Uncertain mutation journals still block save and sync; a prior preview
with no write steps can be replaced by a fresh preview.

### Human Markdown and stable identities

The vault uses ordinary nested Markdown lists plus document/Folder notes and
wikilinks. It is not one file per Rem, and a Markdown file or directory does not
by itself establish native Document or Folder status. With no user attributes,
there is no YAML. One hidden `<!-- remnote:document-key -->` before H1 binds the
document; short anchors bind existing ordinary Rems. Native identity, type,
parent/order, card shape, tags, references and Power-ups are hydrated through
`.remnote/identity.json` and sealed native records, not copied into user YAML.
Unknown native `null`, missing facts and `false` remain distinct; unsupported
native data stays lossless and read-only. Unknown user YAML fields instead fail
lint before remote calls. Mapping a field does not certify writable support.

Folder layout is `Name/Name.md`; a Document or top-level plain Rem uses `Name.md`.
Child Documents live under the same stem directory, such as `Name/Child.md`.
Folder wins when both native capabilities are present. Existing `.md` titles do
not receive a second extension; collisions receive a stable-ID suffix. Pages are
not all named `index.md`. Auto-opening a folder's description note on folder click
is not an Obsidian core feature; sync does not install a plugin for that behavior.

Existing list items place a short Obsidian anchor at the end of their first
paragraph, such as ` ^r-a1b2c3d4`. Keys contain 1–64 ASCII letters, digits or
hyphens; H1 has no anchor. The tracked identity projection uses
`schema: remnote-identity/1`, `kbId` and `documents[documentKey]` with `rootId`
and a `blocks` map from short keys to native Rem IDs. It is not a user-editable
native property database. Assigning a newly created Rem ID preserves its
existing short key. Renaming a file preserves native identities rather than
deleting and recreating them; it does not authorize native movement or reparenting,
which remains unsupported and is rejected.

Optional frontmatter accepts a display-only `title` string, `aliases` and `tags` arrays,
plus `rems[shortKey].content` (`text` or `multiline`) when a new node needs an
explicit content kind. Ordinary text is the default; only a new multiline
question needs the explicit `multiline` declaration. Existing node/card kinds
come from identity-bound records and flags: edit their body directly, without
restating native metadata. Existing identity and native facts cannot be replaced
through YAML. H1 is the sole root-text authority; optional `title` is not a
second source of native text. Publication preserves display attributes.

The following native facts are retained in hidden records and hydrated metadata,
not accepted as user frontmatter:

`native` records type, parent, ordered children, Document/Folder/card-item flags,
practice direction/enabled state, tags and references. Structured facts use:

- `powerups`: `{code, slots: [{slot, valueRemId, valueRichText}]}` entries.
- `propertyValues`: `{propertyId, valueRemId, valueRichText}` entries (not `properties`).
- `portal`: `{type, directlyIncludedRemIds}`, or `null`.
- `cards`: exact `id`, `remId`, forward/backward or `{clozeId}` type, `createdAt`,
  `repetitionHistory`, `nextRepetitionTime`, `lastRepetitionTime`, `timesWrongInRow`.
  History and scheduling fields are read-only.
  SDK history snapshots accept plain or null-prototype objects only and omit
  undefined object properties recursively, preserving defined JSON values,
  unknown fields and array order. Undefined array elements, array holes and
  other non-JSON values remain invalid.

Nullable orthogonal details preserve list/quote/code/TODO/table, property and
Power-up flags; `embeddedQueueViewMode`, `todoStatus`, `fontSize`, `highlightColor`,
`propertyType` (including numeric `0`), `aliasRemIds`, `sourceRemIds`, `createdAt`,
`localUpdatedAt` and `updatedAt`. `collected` is the set of explicitly read native
field names: it distinguishes unknown `null` from a known-null observation.
Unknown facts remain `null`; they are not permission to invent a value or an edit
timestamp. Hydrated `readOnly.record` binds `.remnote/records/ID.json`; `readOnly.public` and
`readOnly.original` bind the corresponding imported public/native record paths,
or `null` when absent.

New ordinary bullets need neither YAML nor an anchor; successful apply assigns
their native identity and publishes short anchors. A valid unique manual short
key is also accepted. New multiline questions require a short question anchor
and matching `rems` attribute; direct leaf answer bullets may omit anchors.
Creating those answers sets native `isCardItem: true`. New basic cards remain
unsupported. Engine-generated `new:key` values in receipts are temporary keys,
not frontmatter users must type. References to unpublished targets are rejected
until native identity exists.

This synthetic note needs no YAML; preserve its real imported document binding
and existing anchors when editing:

```markdown
<!-- remnote:doc-a1 -->
# Example

- A topic ^topic-a1
  - A child ^child-a1
- A new ordinary note, without a hand-written identity.

- [[path/note|Example]]
- [[path/note#^child-a1|This child]]
```

For a new multiline question in an existing imported note, preserve its document
binding and other content, and add only the needed declaration and bullets:

```markdown
---
rems:
  question-1:
    content: multiline
---

<!-- remnote:doc-a1 -->
# Example

- A new question ^question-1
  - An answer
```

| Input | Meaning |
| --- | --- |
| `[[path/note|label]]` | Full vault-relative note path resolves to its document/root Rem |
| `[[path/note#^short-key|label]]` | That note's tracked identity mapping resolves to an ordinary Rem |
| Top-level YAML `aliases` / `tags`, or `#tag` | Obsidian display/search metadata; no automatic native Alias/Tag change |
| Hidden native Tag/reference metadata | Read-only exact Rem ID relationships, never inferred from display labels |
| `![[path/note]]` | An Obsidian embed, not automatically a RemNote reference or Portal |

Generated links use full vault paths. Input resolves exact paths first, then a
unique basename; `[[path/note#Current H1]]` resolves that note's sole current H1.
Broken paths, missing block IDs, ambiguous short names and
duplicate identities fail lint instead of guessing a target. Renames must leave
references resolvable. Display aliases do not change native identity. New embeds
without a verified public-SDK mapping fail the whole sync before remote writes;
existing native Portals retain their original value and are explicitly read-only.
Auxiliary reference/Portal areas are distinct from actual multiline answer items;
they are not flattened into diagnostic body text or presented as working
Obsidian dynamic queries.

Top-level aliases and tags use standard Obsidian properties. Edit the optional
nested content-kind attributes in **Source mode**: the Properties GUI does not support nested properties.
These conventions use Obsidian's documented [links](https://help.obsidian.md/links),
[embeds](https://help.obsidian.md/embeds),
[properties](https://help.obsidian.md/properties) and
[aliases](https://help.obsidian.md/aliases). Obsidian readability is not proof of
RemNote semantic acceptance.

### Explicit format conversion

`sync format DIR` is an explicit offline conversion of a clean, sealed legacy
publication to human Markdown, or canonical rendering of a clean already-human
publication. It requires a complete manifest, no pending remote
journal or local publication, unchanged published source hashes, complete document
coverage and intact native records. It preserves native/original record bytes,
publishes short anchors and tracked identity through staged local publication,
then validates the resulting vault. It makes zero backend calls and performs no
remote write. There is no legacy parse fallback in daily sync.

Success returns `status: "formatted"`, `complete: true`, `remoteWrites: 0`,
document/Rem counts, `identityPath`, previous/current manifest hashes and
`originals: "unchanged"`. Already-human input preserves attributes and stable
anchors, native/original bytes and all content clocks while canonical rendering
can repair empty-note anchor presentation. `status: "already-formatted"` means
validation found nothing to publish. Invalid or forged identity is refused, not
silently rebuilt. Dirty or semantically divergent source is preserved and refused
rather than reformatted from stale records; reconcile that work first.

### Supported write boundary

The first write surface is plain text, bold/italic text, inline and fenced code,
exact wikilinks, basic-card back text, new plain Rems, multiline cards and explicit
bounded deletion. A multiline question is an ordinary bullet with answer child
bullets. Existing type comes from identity-bound records; a new question uses the
explicit multiline attribute, and each actual answer has native `isCardItem`.
Auxiliary Portal/reference children are not answer items. For a basic card, the first paragraph is the front and a blockquote inside
the same list item is the back, not a new Rem. Literal `===` and `>>` in ordinary
text do not declare cards.

Native Folder/Document/Tag/Power-up changes, moves, new embeds/media and complex
rich-text edits are outside this write surface. Existing native content is kept
losslessly and displayed read-only as faithfully as supported. Portal metadata
records its native type and directly included Rem IDs; it does not grant Portal
write support. Raw-record preservation, metadata mapping, writable support and
live/UI verification are separate coverage claims.

### Common baseline and convergence

Compare semantic content for each stable Rem across baseline, local and remote.
One-sided edits propagate to the other endpoint; identical results converge;
edits to different Rems merge, including a local question edit and a remote
answer edit in the same file. The merge unit is a whole Rem: for a basic card,
the selected version supplies both front and back, never a field-wise hybrid.
For divergent versions, `version-time-lww` compares the local `cli-save` timestamp
with the observed native `rem-updated-at` timestamp only when each is bound to the
matching semantic content hash. The greater timestamp wins. Missing, equal,
invalid, decreasing or more-than-five-minutes-future timestamps preserve both
versions as `untrusted-edit-order`. Markdown file mtime and sync capture time
are not version evidence.

Remote `updatedAt` is epoch milliseconds and describes a native Rem version,
not a text-only edit log. Once observed, unchanged content retains its version
timestamp across later metadata/review changes. A controlled local or observed
remote A→B→A revert is a new version; A→A is not. Publication consumes those
change markers, so a resolved revert does not trigger repeated writes. This is
version-time ordering, not guaranteed physical edit chronology across devices:
an unobserved review or metadata update can affect the native timestamp before
the changed content is first observed.

Before any automatic winner overwrites either endpoint, the preview stores an
immutable `.sync/conflicts/` record containing both semantic versions, their
hashes/timestamps and the decision. Archive failure or mismatched existing history
blocks writes. The preview's `resolutions` include exact `historyPath` and
`historyHash`; apply verifies and reuses the same evidence.

The target sync plan can contain incoming and outgoing changes together. Recheck
both endpoints before apply; publish only the planned semantic result and advance
the common baseline only after verification. Frozen-file checks guard local
publication, and remote pre/post hashes detect observed version changes. These
are client optimistic checks: the SDK has no native conditional setter, so they
cannot eliminate the check-write lost-update window. Native transactions remain
disabled. Partial or uncertain results retain the baseline, both versions and
recovery evidence rather than claiming atomic convergence.

Review history and scheduling are exclusively owned by RemNote. Local copies are
read-only snapshots and never become outgoing updates. Missing files, nodes or
remote objects are not automatic deletion requests; absence must be distinguished
from incomplete reads. Deletion remains explicit and bounded in either direction.

### Lint, preview and apply

`lint` returns `ok`, `complete` and diagnostics with `path`, one-based
`line`, stable `code` and `message`. Text mode prints
`path:line / CODE / message`. Any diagnostic blocks the **entire** sync before
remote calls. Metadata unsupported by the current write matrix is read-only,
not silently dropped. Existing Rem/card identity, parent/order and review history
are protected. Missing files, nodes or remote objects do not authorize movement
or automatic deletion.

`status` and `diff` inspect local state without applying changes. `sync plan DIR`
previews with zero native writes. `sync apply DIR` performs whole-workspace lint, fresh bidirectional planning,
guarded apply and verification in one invocation, without requiring a separate preview.
Use `sync apply DIR --plan-hash HASH` to require an exact previous preview instead.
The hash binds normalized scope/path selectors, selected documents,
reconciliation/verification IDs and all frozen vault files, including files
outside the selection. A changed scope, materially different selection, stale
file, native content or hash is refused, not silently accepted as a new plan.
Equivalent normalized selectors reuse the same selection, not a bypass of content
freshness checks.
Either apply path binds a frozen plan, unchanged candidate files, matching KB and native
state, with live writes enabled for outgoing changes. Incoming changes are merged
semantic results, not arbitrary remote snapshot overwrites. SDK writes are
sequential, not atomic; there is no server-side CAS or exactly-once guarantee.
Unknown or partial journal outcomes remain blocked for exact-ID reconciliation;
omitting `--plan-hash` is not a retry or recovery bypass. Deletion still requires
its explicit ID, scope boundary and destructive permission gates.

Only reads are parallel: up to 16 local file reads and 4 exact-ID remote batches
of 50. Each native batch snapshots at most 4 Rems concurrently, each with up to
12 independent SDK flags (192 in-flight flag reads at the composed maximum).
Read results retain input order; failures stop their pool and drain in-flight
work before returning, without passing partial reads into writes. Parsed source
and bytes are reused only within one operation. Full content hashes, safe paths,
permissions and metadata are freshly checked at the write/publication boundaries;
mtime is never a freshness shortcut. There is no persistent parse cache.

Current receipt fields (arrays contain exact Rem IDs unless noted):

| Status | Fields and meaning |
| --- | --- |
| `preview` | `complete: true`, `planHash`, numeric `creates` / `updates`, `incoming`, `converged`, `outgoing`, `metadataRefresh`, `resolutions`, optional `deletion`, `atomic: false`; new outgoing entries use `new:key` |
| `verified` | `complete: true`, `planHash`, `ids` mapping `new:key` to native ID, existing `updated`, `incoming`, `converged`, native-ID `outgoing`, `metadataRefresh`, `resolutions`, `deleted`, `nativeCards`, `cardsPreserved: true`, `atomic: false` |
| `unchanged` | `complete: true`, `changes: 0`; no content or metadata publication needed |
| planning `conflict` | Exit 1, `complete: false`, `planHash`, `conflicts`, any archived `resolutions`, `remoteWrites: 0`; no apply is authorized by this receipt |
| offline layout `preview` / `verified` | `remoteChecked: false`, `remoteWrites: 0`, `planHash`, empty direction arrays; `localPublished` is false for preview and true after apply |

Read `remoteChecked` as actual remote-read evidence, not a constant: an empty
selection or changed scope with no candidates can return offline `unchanged`
with `remoteChecked: false` and no checked IDs. Bound-ID planning reports
`discoveryScope: "bound-ids"`, `globalDiscoveryComplete: false`; even an all-scope
success cannot establish global discovery. `diff` is local-only and reports
`remoteChecked: false`; it cannot establish remote freshness or convergence.
`checkedIds` / `checkedCount` describe the initial bound-ID verification set,
not the number of SDK calls or repeated reads. Created IDs have separate `ids`
and readback receipts. `selection` records canonical `paths`, selected `files`,
actual local-key `outgoingKeys`, `reconcileIds` and disjoint `verificationIds`.
Verification-only dependencies do not advance their shared native baseline or
content clocks. Unselected bytes and unassigned bullets remain intact. Selected
layout-only apply advances only local layout/file hashes and display attributes;
it preserves all native records/clocks and any separate pending native plan.
The acceptance driver records wall time and native mutation steps separately;
SDK transport calls are explicitly `not-instrumented`.
Each planning conflict records `id`, `path`, `reason` (`untrusted-edit-order`,
`remote-structure` or `remote-missing`), `baseHash`, `localHash`, nullable
`remoteHash` / `remoteUpdatedAt`, a private `localSnapshot` path and a
`remoteSnapshot` path or `null`. The local version remains in place; opaque local
snapshots preserve the real baseline content rather than their display placeholder.
A mutation-stage failure may also use status
`conflict`, but carries `journalKey`, known `ids` and `steps` instead of the
planning `remoteWrites: 0` guarantee: inspect that evidence before any next action.

Deletion is explicit and separate from file absence. Keep the local outline
intact for preview:

```bash
remnote-cli sync delete /PRIVATE/vault --id CARD_ID --scope-root ROOT_ID
remnote-cli --allow-destructive sync delete /PRIVATE/vault --id CARD_ID --scope-root ROOT_ID --apply --plan-hash PREVIEW_HASH
```

Delete previews by default; unlike `sync apply`, its execution requires both
`--apply` and `--plan-hash`. It accepts no scope/path selectors.
The target must be a strict descendant of the exact scope root. Review the
bounded exact descendant IDs. Native Document/Folder deletion is unsupported;
global `--allow-destructive` is required; official RemNote scopes remain the native permission boundary.
Deleting a Rem does not promise to purge all historical Card records. Never
delete review history to make an acceptance test pass.

The verified receipt distinguishes incoming/outgoing changes and identity/card
checks after baseline publication. Read back exact semantic state:
exit 0, a Markdown card shape or a Rem ID alone is not native-card acceptance.

### Failure, recovery and development acceptance

Preserve the exact plan/hash, journal and known IDs after `unknown`,
`conflict` or `publication-incomplete`. A lost response does not prove that
a write failed. Do not change its key, remove its journal, recreate objects or
start a new test batch to bypass uncertainty.

Recovery finishes only already-verified publication and must not replay remote
mutations. Exact-ID reads may be needed before local publication. Acknowledged
writes followed by validation or publication failure are not a zero-write failure
and must be reconciled. A recovered local publication reports `status: "recovered"`,
`complete: true`, `remoteWrites: 0` and the existing `ids`; it does not mean the
original operation had zero remote writes.

`sync resume DIR --plan-hash HASH` is a separate, explicit write entry point,
not an automatic retry by `apply`. Ensure the original CLI writer has stopped;
keep the source files, sealed baseline and original journal unchanged. Resume:

1. Reconstructs the original plan offline from its bound local files, baseline
   and selectors, requiring the same complete plan hash. Current remote edits
   cannot silently turn this into a new plan.
2. Folds the contiguous verified journal prefix and at most one final uncertain
   step into its expected graph. It verifies the original immutable/Card guard,
   exact native IDs, fields, flags, tags and both sides of ordered parent links.
3. Recognizes an uncertain step only when its complete intended effect already
   exists. Known creation IDs are reused; an unknown creation without an ID or a
   setter still showing its before-state is refused, never replayed. A delayed
   old SDK request cannot be ruled out merely by reading a before-state.
4. Continues only never-attempted steps under the same journal, then uses normal
   native verification and staged publication. A second interruption retains
   those same identities. Repeating a published plan returns `already-complete`
   with zero native calls/writes while its published baseline still matches.

The bounded resume implementation accepts outgoing-only plans that reconstruct
exactly; it does not resume deletion, incoming/converged or LWW-resolution plans.
Different source bytes, malformed/noncontiguous steps or concurrent native edits
require reconciliation outside this command. Do not delete state to bypass a
refusal. A verified remote journal delegates to local-only recovery.

Old journals do not record the creation-time Card identities of newly made Rems.
Resume therefore validates their constructor/default shape plus recorded effects,
including explicitly collected empty tags, and establishes their Card identity
baseline at this exact readback. It does **not** prove those new Card IDs are the
same as at the original creation; use any independent original receipt to check
that history. The resumed receipt reports `resumed: true`, `recognizedSteps`,
`existingCardsPreserved: true`, `newCardIdentityBaseline: "resume-readback"`, and
`remoteWrites` counting mutation attempts in this invocation only. Already
verified or recognized steps do not inflate that count. Newly observed Card IDs
are protected during continuation. Review/scheduling metadata remains native-owned.
All writes remain `atomic: false`: optimistic read-before/read-after checks are
not server-side compare-and-set or an exactly-once promise.

Development acceptance needs a frozen candidate, exclusive live ownership and
the guarded integration wrapper. Exercise `scripts/sync-agent-acceptance.mjs`
against current-format fixtures before any authorized native run. Acceptance must
use a new synthetic subtree with guarded local new-card saves, current-format
stable-block checks, incoming-only, mixed-direction, same-result convergence,
both version-time winners with pre-apply archives and same-Rem conflict
cases. The deliberate conflict must prove zero remote writes and preserve both
versions before resolving only local synthetic text to the observed remote value.
Cleanup requires fresh exact root text/parent/children plus a recorded intent.
SDK `findMany` may filter missing IDs; deletion proof uses `inspect --strict` and
accepts exit 1 only for the exact expected `missing: true` records, no truncation
and no other read errors. It does not assume null padding or equate any failed read
with deletion.
Card lookup records returned and unreturned IDs separately, rejects duplicate or
out-of-scope IDs, and makes no historical-card purge claim from an absent result.
Its `node --import tsx scripts/sync-agent-acceptance.mjs --self-test` checks
synthetic codec/receipt boundaries offline, without live calls or file writes.
Preserve existing failed batches for their owner's reconciliation; never treat
another batch's repair or cleanup as this driver's acceptance. A new live run
requires approval and native/UI evidence; offline checks do not establish it.

## create

Create a new RemNote note or a hierarchical tree.

```bash
remnote-cli create [title] [options]
```

| Option                  | Default | Description                                          |
| ----------------------- | ------- | ---------------------------------------------------- |
| `--title <text>`        | none    | Note title                                           |
| `-c, --content <text>`  | none    | Initial content (markdown supported)                 |
| `--content-file <path>` | none    | Read initial content from UTF-8 file (`-` for stdin) |
| `--parent-id <id>`      | none    | Parent Rem ID                                        |
| `--tag-ids <id...>`     | none    | Exact tag Rem IDs to add                             |
| `--as-document`         | false   | Mark the created title/root Rem as a document        |
| `--aliases <text...>`   | none    | Real aliases to add to the explicit title/root Rem   |

Behavior rules:

- `title` and `content` are both optional, but **at least one must be provided**.
- Title input support positional `[title]` and `--title <text>`.
- Title and content input support `[[id:<remId>]]` for exact inline references to existing Rems.
- Content input from `-c`/`--content`/`--content-file` supports RemNote's native markdown syntax for creating nested hierarchies and flashcards inline.
- `--content` and `--content-file` are mutually exclusive.
- Content loaded from file/stdin is passed verbatim (no templating/interpolation).
- Write content from `--content-file` and stdin is capped at 100 KB.
- If `parent-id` is not provided, the note will be created under the default root rem in the setting.
- Tag Rem IDs are applied only to the top-level Rems created. Tag names are not accepted.
- `--as-document` requires a title/root Rem and preserves any flashcard/concept status created by markdown syntax.
- `--aliases` requires a title. Values are whitespace-normalized and deduplicated; matches to the primary title are
  ignored while Unicode and case are preserved.
- Newly created non-leaf Rems are collapsed automatically in their nearest containing Document, daily note, or Portal.

Examples:

```bash
# Simple note with title only, either by positional argument or --title option, create under default root rem
remnote-cli create "Meeting Notes"
remnote-cli create --title "Meeting Notes"

# Create a new note under a specific parent rem id
remnote-cli create --title "Meeting Notes" --parent-id <parent-rem-id>

# Create a new note with title, content, and exact tag Rem IDs
remnote-cli create --title "Project Plan" --content "Phase 1" --tag-ids <tag-rem-id>

# Create content that links to an existing Rem by exact ID
remnote-cli create --title "Compound" --content "Component [[id:<component-rem-id>]]"

# Create a title/root Rem as a document
remnote-cli create --title "Project Plan" --content "Phase 1" --as-document

# Create real aliases on the title/root Rem
remnote-cli create --title "The Shop on Main Street" --aliases "Obchod na korze"

# Create a new note with markdown content directly under parent rem id
# Note: if the content is in markdown format, --content/--content-file must be used to avoid misinterpretation of the content as command options
remnote-cli create --content "- Item 1\n  - Item 2" --parent-id <parent-rem-id>

# Flashcards
remnote-cli create --title "Photosynthesis" --content "Front :: Back"

# Hierarchical tree from file or from parsed markdown
remnote-cli create --title "Biology Terms" --content-file /tmp/biology.md
remnote-cli create --title "Biology Terms" --content "# Terms 1\n- Item 1\n  - Item 2"
```

## search

Search notes by text query.

```bash
remnote-cli search <query> [options]
```

Shared options for `search` and `search-by-tag`:

| Option                     | Default | Description                          |
| -------------------------- | ------- | ------------------------------------ |
| `-l, --limit <n>`          | `50`    | Maximum number of results            |
| `--content-mode <mode>`    | `none`  | `none`, `markdown`, or `structured`  |
| `--view <view>`            | default | `compact`, `standard`, or `full`     |
| `--ancestor-depth <n>`     | `0`     | Parent Rems to include, parent-first |
| `--depth <n>`              | `1`     | Child depth for rendered content     |
| `--child-limit <n>`        | `20`    | Max children per hierarchy level     |
| `--max-content-length <n>` | `3000`  | Max rendered content character count |

`search` also supports:

| Option              | Default | Description                                      |
| ------------------- | ------- | ------------------------------------------------ |
| `--parent-id <id>`  | none    | Non-empty parent Rem ID to scope search within its subtree |
| `--cursor <cursor>` | n/a     | Opaque cursor from a previous `search` response  |
| `--cards-only` | off | Return only Rems that generate cards |
| `--include-review-stats` | off | Include native card review facts on each result |

Behavior rules:

- In `--text` mode, each line includes headline/title and Rem ID.
- JSON output preserves paging metadata (`hasMore`, `nextCursor`, `truncated`, and `truncationReason`).
- In `--text` mode, `nextCursor` is printed after results when another page is available.
- Tags are shown in `--text` mode when the bridge returns them as `[tags: tag1 [tagRemId1], tag2 [tagRemId2]]`.
- Parent context is appended in text output when available as `<- Parent Title [parentRemId]`.
- Ancestors are appended when `--ancestor-depth` is used.
- `--depth`, `--child-limit`, and `--max-content-length` are most relevant when content rendering is enabled.
- `tags` is optional and present when the matched Rem has readable tag identity metadata. JSON output preserves
  `{ tagRemId, name }` objects.
- `--cursor` is bound to the specific search `query`, `--parent-id`, and `--cards-only` value. A cursor must be reused
  with the exact same query and scope.

Examples:

```bash
remnote-cli search "meeting"
remnote-cli search "weekly" --limit 10 --content-mode structured --depth 2 --child-limit 10 --text
remnote-cli search "weekly" --limit 10 --cursor "search:v1:..."
remnote-cli search "meeting" --limit 10 --parent-id <parent-rem-id>
remnote-cli search "meeting" --limit 10 --parent-id <parent-rem-id> --cursor "search:v1:..."
remnote-cli search "TQQQ" --cards-only --include-review-stats --view full
```

## search-by-tag

Search notes by exact tag Rem ID (ancestor-context aware).

```bash
remnote-cli search-by-tag --tag-id <tag-rem-id> [options]
```

Options and output/content controls are identical to `search`
(`-l/--limit`, `--content-mode`, `--view`, `--ancestor-depth`, `--depth`, `--child-limit`,
`--max-content-length`).
Use `--result-mode tagged` to return directly tagged Rems instead of the default ancestor-context results.
Use `--cursor <cursor>` to continue a previous search-by-tag page. SDK calls use a fixed
15-second default deadline; the former `--timeout-ms` transport option is not accepted.

`--tag-id` is the exact Rem ID of the tag Rem. Tag names, `#name` inputs, and aliases are not accepted; exact IDs avoid
ambiguity from duplicate names, renamed tags, and aliases.

Examples:

```bash
remnote-cli search-by-tag --tag-id <tag-rem-id>
remnote-cli search-by-tag --tag-id <tag-rem-id> --result-mode tagged
remnote-cli search-by-tag --tag-id <tag-rem-id> --limit 10 --cursor "search_by_tag:v1:..."
remnote-cli search-by-tag --tag-id <tag-rem-id> --content-mode markdown --depth 2 --text
```

## read

Read one or more notes by Rem ID.

```bash
remnote-cli read <rem-id> [more-rem-ids...] [options]
```

| Option                     | Default    | Description                          |
| -------------------------- | ---------- | ------------------------------------ |
| `-d, --depth <n>`          | `5`        | Child depth to render                |
| `--content-mode <mode>`    | `markdown` | `markdown`, `structured`, or `none`  |
| `--view <view>`            | default    | `compact`, `standard`, or `full`     |
| `--ancestor-depth <n>`     | `0`        | Parent Rems to include, parent-first |
| `--child-limit <n>`        | `100`      | Max children per hierarchy level     |
| `--max-content-length <n>` | `100000`   | Max rendered content character count |
| `--include-media-metadata` | false      | Include root image IDs for get-media |

Behavior rules:

- `--text` mode prints metadata when present: title/headline, ID, type, parent, aliases, tags, card direction, and content
  stats.
- If `content` exists, it is printed after a blank line.
- In structured mode, use JSON output (default) to preserve `contentStructured` rem IDs and child hierarchy.
- `--content-mode none` suppresses rendered content.
- `tags` is optional and present when the returned Rem has readable tag identity metadata. JSON output preserves
  `{ tagRemId, name }` objects.
- One Rem ID returns the same JSON object as before.
- Two to fifty IDs return `{"results":{"<id>": <note or {"error":"..."}>}}` in request order. Options apply to every ID.
  A per-ID miss stays in `results` and the command exits 1. Duplicate IDs are rejected.

Examples:

```bash
remnote-cli read abc123def
remnote-cli read abc123def def456 --content-mode none
remnote-cli read abc123def --content-mode none --depth 2 --child-limit 30 --max-content-length 5000 --text
remnote-cli read abc123def --content-mode structured --depth 2 --child-limit 30
```

## inspect

Read generic Rem state as JSON. One command uses one bridge session. Requested IDs are loaded
with `findMany`; descendants, tags, and ancestors use further batches in that same session.

```bash
remnote-cli inspect <rem-id...> [options]
remnote-cli inspect --from-file ids.txt --descendants 1 --expect rules.json --strict
```

| Option | Default | Description |
| --- | --- | --- |
| `--from-file <path\|->` | none | JSON array or whitespace-separated IDs, combined with positional IDs |
| `--descendants <n>` | `0` | Include descendants to this depth (0-20, at most 1000 Rems) |
| `--fields <list>` | all | Comma-separated fields to fetch and return |
| `--summary` | off | Omit `text`, `backText`, and markdown unless `--fields` is set |
| `--expect <path\|->` | none | Evaluate a rules file against this result |
| `--strict` | off | Exit 1 when a rule fails or the read is incomplete |

`id` is always returned. Field names: `type`, `text`, `backText`, `elements`, `markdown`,
`isCardItem`, `hasCardStructure`, `practiceDirection`, `enablePractice`, `cards`, `tags`,
`parent`, `children`, `aliases`, `sources`, `portal`.

`elements.text` and `elements.backText` each have `counts` and `items`. A code block is a
rich-text element with `code: true` and an optional `language`. `rem.isCode` is a different
flag and is false for a code element inside text, so inspect does not use it. Literal `[[`
occurrences are counted separately from rem-reference elements. One element can contribute
several items (a code span can also be bold and a cloze).

`tags[]` and `parent` are root-first `{id,name,type}` chains. `tags[].ancestors` does not
include the tag itself. `cards[]` has `id`, `type`, `due`, `nextRepetition` (the same
timestamp), `historyLength`, and `hash`. The hash covers card id, rem id, type, and
repetition history, so a due-date-only change does not change it.

`portal` is present for a portal Rem or a Rem carrying powerup `sp`. `query` is slot `q`
and `filter` is slot `f` (search-portal queries and table filters). A recognized
`getPortalType` code sets `portalType`. Any other value is unclassified (`portalType: null`)
and kept in `portalTypeRaw`; that is not a read error. Other Rems have `portal: null`.
When `complete` is false, top-level `errors` lists the reason, including each Rem field
error as `{id, field, message}`.

Rule failures are included as `assertions` and do not change the exit code unless `--strict`.
Usage and connection errors still exit 1. See [state verification](state-verification.md).

## assert

Evaluate the same generic rules against a live inspect or a saved inspect file.

```bash
remnote-cli assert --file rules.json --strict
remnote-cli assert --file rules.json --against inspect.json
```

| Option | Description |
| --- | --- |
| `--file <path\|->` | Rules JSON, `schemaVersion` 1 |
| `--against <path>` | Saved inspect JSON. Skips the bridge |
| `--strict` | Exit 1 when a rule fails or a live read is incomplete |

A live file includes `remIds` and may include `descendants`, `fields`, and `summary`.
`--against` does not need `remIds`. The rule language has no domain-specific kinds:

| Op | Meaning |
| --- | --- |
| `equals` | Deep-equal the selected value to `expect` |
| `contains` | Substring, or an array element deep-equal to `expect` |
| `startsWith` | String prefix |
| `regex` | `RegExp` test (search). Invalid patterns are a usage error |
| `notContains` | Literal substring or element is absent. A missing path fails |
| `count` | Array length, or a number, equals `expect`. Optional `match` filters objects first |
| `all` / `any` / `none` | Partial object match on listed keys, or scalar equality. `all` requires a non-empty array |
| `hashEquals` | Selected string equals a baseline file or `expect` |

Paths use dots. `[0]` is an index. `[field=value]` keeps matching array items.
`rems[id=REM][0].markdown` selects one Rem. A property after an array maps that property.
`[*]` visits every element and flattens one nested array, so `rems[*].isCardItem` and
`rems[*].tags[*].name` do not need a path per index. Child ids are strings;
`rems[*].isCardItem` checks every loaded Rem, including descendants included in `rems`.

The report is `{ok, complete, errors, rules}`. `complete` and `errors` come from the inspect
document (`errors` also lists each Rem's field errors). `ok` is false when a rule fails,
`complete` is false, or `errors` is non-empty. `--strict` exits 1 in that case.
Each rule result is `{id, status: pass|fail, actual, expected}`.

## powerup get

Read one powerup slot by code. Read-only.

```bash
remnote-cli powerup get --rem REM_ID --powerup sp --slot f
remnote-cli powerup get --rem REM_ID --powerup sp --slot q --as richtext
```

| Option | Description |
| --- | --- |
| `--rem <id>` | Rem that carries the slot |
| `--powerup <code>` | Powerup code, such as `sp` |
| `--slot <code>` | Slot code or name, such as `q`, `Query`, `f`, or `Filter` |
| `--as <kind>` | `value` (default), `richtext`, or `rem` |

SDK 0.0.46 looks up built-in slots by name (`Filter`) and drops a raw code (`f`), which the
host reports as `powerupSlot parameter: Required`. The CLI maps a known code to that name
and calls `rem.getPowerupProperty`. The plugin passes the arguments through unchanged.
A name, a custom powerup, or an unknown code is sent as given, and the host error is returned.
`getPowerupByCode("sp")` can return undefined for a built-in powerup; read the slot on the
Rem that carries it. This command does not open RemNote's local database.

## review-stats

Read native RemNote review facts from exactly one scope:

```bash
remnote-cli review-stats <rem-id> [more-rem-ids...]
remnote-cli review-stats --today
remnote-cli review-stats --root-id <root-rem-id>
remnote-cli review-stats --tag-id <tag-rem-id>
```

JSON output preserves the raw card type, creation timestamp, repetition history, last and next repetition timestamps,
and consecutive wrong count. Text output provides a compact summary. The command does not calculate mastery or change
the review schedule.

## outline

Preview or update folding for every non-leaf Rem below one root Rem:

```bash
remnote-cli outline collapse --today
remnote-cli outline collapse --today --apply
remnote-cli outline collapse --root-id <wiki-rem-id> --apply
remnote-cli outline expand --root-id <root-rem-id> --apply
```

The command defaults to preview mode. `--apply` requires Bridge writes to be enabled and verifies each changed Rem in
its actual display context. Nested Document content uses that Document, Portal content uses the Portal Rem ID, and the
selected root itself is not changed.

## todo

List exact-tag todos and synchronize native checkbox state with TODO/DONE tags:

```bash
remnote-cli todo list --tag-id <todo-tag-rem-id>
remnote-cli todo complete <rem-id> --todo-tag-id <todo-tag-rem-id> --done-tag-id <done-tag-rem-id>
remnote-cli todo complete <rem-id> --todo-tag-id <todo-tag-rem-id> --done-tag-id <done-tag-rem-id> --apply
remnote-cli todo reopen <rem-id> --todo-tag-id <todo-tag-rem-id> --done-tag-id <done-tag-rem-id> --apply
```

`complete` and `reopen` default to preview. Changed apply operations require atomic
native status/tag synchronization and are currently unavailable; previews remain usable.

## SDK commands

The Plugin SDK is available through one first-level `sdk` command. Its second level contains capability discovery and
19 SDK namespaces; each third-level command maps to one bridge-advertised capability:

```text
capabilities  app        card       date       editor
event         focus      kb         messaging  powerup
queue         reader     rem        rich-text   scheduler
search        settings   storage    widget      window
```

Use `sdk capabilities` to search the full inventory. Running a namespace without a method lists that namespace's
commands; adding `--help` to a method prints its SDK signature, mode, target requirements, unsupported reason, and
example.

```bash
remnote-cli sdk --help
remnote-cli sdk capabilities --status supported --mode read --text
remnote-cli sdk rem
remnote-cli sdk rem object-collapse --help
remnote-cli sdk app get-platform --args-json '[]'
remnote-cli sdk rem object-collapse --target-id REM_ID --args-json '["PORTAL_ID"]'
remnote-cli sdk messaging broadcast --args-file ./args.json
```

- Positional SDK arguments come from either `--args-json` or `--args-file`, never both.
- Argument files/stdin are UTF-8 and capped at 100 KB; CLI input validation also limits calls to 100 JSON arguments.
- RemObject and Card methods require `--target-id`.
- Prefer friendly commands when they cover the workflow.
- Use `--allow-destructive` only after explicit user intent and only for a command whose help reports
  `Mode: destructive`.
- Callback, event-listener, scheduler, Widget registration, and stateful RichTextBuilder operations remain
  discoverable but report `unsupported` because they cannot cross a one-shot JSON command boundary. Supported rich-text factories return the result of native `value()` in one call.

## get-media

Save one RemNote-managed image to a local file:

```bash
remnote-cli get-media <rem-id> --field <text|backText> --media-id <id> --output <path>
```

Discover the required IDs with `remnote-cli read <rem-id> --include-media-metadata`. Existing destinations are
protected; pass `--force` only when overwriting is intentional. `--max-inline-bytes` can lower or raise the per-call
limit up to the CLI's 10 MiB hard maximum. JSON/text output reports metadata and the absolute saved path, never the
base64 payload.

## read-table

Read one Advanced Table by exact title or Rem ID.

```bash
remnote-cli read-table (--title <title> | --rem-id <id>) [options]
```

| Option                     | Default | Description                               |
| -------------------------- | ------- | ----------------------------------------- |
| `--title <title>`          | none    | Exact Advanced Table title                |
| `--rem-id <id>`            | none    | Table Rem ID                              |
| `-l, --limit <n>`          | `50`    | Maximum rows to return                    |
| `--offset <n>`             | `0`     | Zero-based row offset                     |
| `-p, --properties <names>` | none    | Comma-separated property names to include |

Behavior rules:

- Provide exactly one of `--title` or `--rem-id`.
- JSON output includes `tableId`, `tableName`, `columns`, `rows`, `totalRows`, and `rowsReturned`.
- In `--text` mode, output prints table identity, column schema, and a simple row grid.
- `--properties` filters returned columns by property name before rows are formatted.
- Use `--limit` and `--offset` together for incremental reads of large tables.

Examples:

```bash
remnote-cli read-table --title "Projects"
remnote-cli read-table --rem-id abc123def --limit 10
remnote-cli read-table --title "Projects" --properties "Status,Owner" --text
```

## update

Update note metadata.

```bash
remnote-cli update <rem-id> [options]
```

| Option                       | Default | Description                                                  |
| ---------------------------- | ------- | ------------------------------------------------------------ |
| `--title <text>`             | none    | Replace title/headline; supports `[[id:<remId>]]`             |
| `--add-aliases <text...>`    | none    | Add real aliases if not already present                       |
| `--remove-aliases <text...>` | none    | Remove aliases by exact whitespace-normalized, case-sensitive match |

At least one update option is required. Alias additions/removals are idempotent, and the same normalized alias cannot
be requested in both operations.

Use the dedicated commands below for child content and tag writes.

Examples:

```bash
remnote-cli update abc123def --title "Updated Title"
remnote-cli update abc123def --title "See also [[id:<target-rem-id>]]"
remnote-cli update abc123def --add-aliases "Original Title" --remove-aliases "Old Title"
```

## set-document-status

Preview or set document status on an existing Rem. The command is a dry-run unless `--apply` is provided. Concept/card
status is preserved.

```bash
remnote-cli set-document-status <rem-id> --document
remnote-cli set-document-status <rem-id> --document --expected-old-rem-type concept --apply
remnote-cli set-document-status <rem-id> --no-document --apply
```

| Option                          | Default | Description                                                   |
| ------------------------------- | ------- | ------------------------------------------------------------- |
| `--document`                    | none    | Mark the Rem as a document                                    |
| `--no-document`                 | none    | Remove document status from the Rem                           |
| `--apply`                       | false   | Perform the change instead of dry-run preview                 |
| `--expected-old-rem-type <type>` | none    | Reject stale context before changing document status          |

Accepted `--expected-old-rem-type` values: `folder`, `document`, `dailyDocument`, `concept`, `descriptor`, `portal`, `text`.

## list-children

List direct children under one or more parents without rendering a whole subtree.

```bash
remnote-cli list-children <parent-rem-id> [more-parent-ids...] --limit 50 --ancestor-depth 1
```

| Option                 | Default | Description                                  |
| ---------------------- | ------- | -------------------------------------------- |
| `--limit <n>`          | `50`    | Maximum direct children per parent           |
| `--cursor <cursor>`    | none    | Continue a previous page for one parent      |
| `--view <view>`        | compact | `compact`, `standard`, or `full`             |
| `--ancestor-depth <n>` | `0`     | Parent Rems to include for each child        |

One parent returns the same `{children,hasMore,nextCursor,totalChildren}` object as before. `--cursor` is only valid
for that single-parent call. Two to fifty parents return `results` keyed by parent ID, each value the same page object
or `{"error":"..."}`. The shared limit, view, and ancestor depth apply to every parent. A per-ID error exits 1 after
printing the map. Duplicate IDs are rejected.

```bash
remnote-cli list-children parent-a parent-b --limit 50
```

## insert-children

Insert child Rems under a parent at an explicit position.

Newly created non-leaf Rems are collapsed automatically in their nearest containing Document, daily note, or Portal.

```bash
remnote-cli insert-children <parent-rem-id> --content <text> --position <first|last|before|after>
```

| Option                    | Default | Description                                      |
| ------------------------- | ------- | ------------------------------------------------ |
| `--content <text>`        | none    | Content to insert                                |
| `--content-file <path>`   | none    | Read inserted content from UTF-8 file (`-` stdin) |
| `--position <position>`   | none    | `first`, `last`, `before`, or `after`             |
| `--sibling-rem-id <id>`   | none    | Required for `before` and `after`                 |

Examples:

```bash
remnote-cli insert-children cEZH8DJYED3RQIB7k --content "description: Use for Codex app/CLI/skills/ExecPlans notes." --position first
remnote-cli insert-children cEZH8DJYED3RQIB7k --content "Related [[id:<target-rem-id>]]" --position last
remnote-cli insert-children cEZH8DJYED3RQIB7k --content-file /tmp/child.md --position before --sibling-rem-id abc123def
```

## move-note

Move an existing Rem and its subtree under a new parent. The command is a dry-run unless `--apply` is provided.

```bash
remnote-cli move-note <rem-id> --new-parent-rem-id <parent-rem-id>
remnote-cli move-note <rem-id> --new-parent-rem-id <parent-rem-id> --expected-old-parent-rem-id <old-parent-rem-id> --apply
```

| Option                         | Default | Description                                  |
| ------------------------------ | ------- | -------------------------------------------- |
| `--new-parent-rem-id <id>`     | none    | New parent Rem ID                            |
| `--position <position>`        | `last`  | `first`, `last`, `before`, or `after`        |
| `--sibling-rem-id <id>`        | none    | Required for `before` and `after`            |
| `--apply`                      | false   | Perform the move instead of dry-run preview  |
| `--expected-old-parent-rem-id` | none    | Reject stale parent context before moving    |
| `--ancestor-depth <n>`         | `0`     | Parent Rems to include before/after the move |

## replace-children

Replace all direct content child Rems under a parent while preserving parent identity, title, aliases, document status,
tags, and properties. This is destructive for existing content-child Rem IDs and can be blocked by bridge policy.

```bash
remnote-cli --allow-destructive replace-children <parent-rem-id> --content-file <path>
```

| Option                  | Default | Description                                                                      |
| ----------------------- | ------- | -------------------------------------------------------------------------------- |
| `--content <text>`      | none    | Replacement content                                                              |
| `--content-file <path>` | none    | Read replacement content from UTF-8 file (`-` stdin; empty file clears content children) |

Replacement content supports `[[id:<remId>]]` for exact inline references to existing Rems.
Newly created non-leaf replacement Rems are collapsed automatically in their nearest containing Document, daily note,
or Portal.

## update-tags

Add or remove tags by exact tag Rem ID.

```bash
remnote-cli update-tags <rem-id> --add-tag-ids <tag-rem-id...>
```

| Option                          | Default | Description              |
| ------------------------------- | ------- | ------------------------ |
| `--add-tag-ids <tag-rem-id...>`    | none    | Exact tag Rem IDs to add |
| `--remove-tag-ids <tag-rem-id...>` | none    | Exact tag Rem IDs to remove |

Use exact IDs for production tagging workflows. Name-based tag mutation is intentionally not exposed.

## set-property

Set or clear a tag/table property value by exact IDs.

```bash
remnote-cli set-property <rem-id> --tag-id <tag-rem-id> --property-id <property-rem-id> (--value <text> | --rem-reference-id <id> | --clear)
```

| Option                    | Default | Description                                           |
| ------------------------- | ------- | ----------------------------------------------------- |
| `--tag-id <id>`           | none    | Exact tag/table Rem ID that owns the property         |
| `--property-id <id>`      | none    | Exact property Rem ID under the tag/table Rem         |
| `--value <text>`          | none    | Set a plain text or markdown property value           |
| `--rem-reference-id <id>` | none    | Set a Rem reference value; use select option IDs here |
| `--clear`                 | false   | Clear the property value                              |

Examples:

```bash
remnote-cli set-property abc123def --tag-id tag123 --property-id prop123 --value "People" --text
remnote-cli set-property abc123def --tag-id tag123 --property-id prop123 --value "See [[id:<target-rem-id>]]" --text
remnote-cli set-property abc123def --tag-id tag123 --property-id prop123 --rem-reference-id option123 --text
remnote-cli set-property abc123def --tag-id tag123 --property-id prop123 --clear --text
```

## journal

Append to today's daily document.

```bash
remnote-cli journal [content] [options]
```

| Option                  | Default           | Description                                        |
| ----------------------- | ----------------- | -------------------------------------------------- |
| `--content <text>`      | none              | Journal entry content                              |
| `--content-file <path>` | none              | Read journal entry from UTF-8 file (`-` for stdin) |
| `--tag-ids <id...>`     | none              | Exact tag Rem IDs to add                           |
| `--no-timestamp`        | timestamp enabled | Disable `[HH:MM:SS]` prefix                        |

Behavior rules:

- Provide exactly one content source:
  - positional `[content]` (backward-compatible)
  - `--content <text>`
  - `--content-file <path|->`
- Content input from `--content`/`--content-file` supports RemNote's native markdown syntax for creating nested hierarchies and flashcards inline.
- Journal content supports `[[id:<remId>]]` for exact inline references to existing Rems.
- `--tag-ids` applies exact tag Rem IDs to the created journal entry root/top-level Rems. Tag names are not accepted.
- Newly created non-leaf journal Rems are collapsed automatically in today's daily-note context.

Examples:

```bash
remnote-cli journal "Finished sprint review"
remnote-cli journal --content "Quick thought" --no-timestamp --tag-ids <tag-rem-id> --text
remnote-cli journal --content-file /tmp/entry.md --text
cat /tmp/entry.md | remnote-cli journal --content-file - --text
```

## batch

Run several commands on one loopback connection. Use this instead of starting a process per command when those
processes would otherwise hit `CLI port occupied`.

```bash
remnote-cli batch --file commands.jsonl
remnote-cli batch --file commands.json --stop-on-error
cat commands.jsonl | remnote-cli batch --file -
```

Input is a JSON array of `{"argv":["read","REM_ID"]}`, a `{"commands":[...]}` object, one such object, or JSONL with
one object per line. `argv` is the command and its arguments, not the `remnote-cli` program name. The file is at most
1 MB and 100 commands. Commands run in order on one listener; later commands see earlier writes. Do not pass `-` for
an inner stdin payload, and do not put `--kb-id`, `--allow-destructive`, or `--verbose` on an inner command.
Those flags belong on `batch`. `batch --allow-destructive` is the approval for inner `sdk` calls; repeating the flag
inside `argv` is still rejected.

Help, `--version`, and usage errors (a missing option argument, or `flashcards` without `apply`) are results for that
item. They do not call `process.exit`, do not print outside the JSON envelope, and do not skip later commands.
Commander exit code 0, including root and subcommand `--help` and `--version`, is `ok: true`; the captured text is
`result`. The bridge closes after the batch finishes or fails while reading the file.

JSON output:

```json
{"schemaVersion":1,"count":2,"ok":true,"stoppedEarly":false,"results":[{"index":0,"argv":["read","REM_ID"],"ok":true,"exitCode":0,"result":{}}]}
```

`result` is the command's parsed JSON stdout, or the raw text when it was not JSON. `error` carries stderr or the
thrown message. Exit 0 only when every executed command succeeds. `--stop-on-error` returns the results collected
before the first failure and sets `stoppedEarly` when commands remain.

## status

Check bridge connection state.

```bash
remnote-cli status
```

Behavior rules:

- Uses the protocol 2 Bridge handshake and checks the active KB plus live SDK catalog.
- JSON output includes KB ID/name, protocol, SDK version/catalog hash, plugin/CLI versions,
  effective CLI write policy and connection timing metadata.
- Product versions are informational; there is no `version_warning` or minor-version coupling.
- Text output shows connection, plugin/CLI versions, KB and protocol. Failures exit 1.

```bash
remnote-cli status --text
```

## Task Composites (schemaVersion=1)

| CLI | Local business action |
|-----|-----------------------|
| `context --request <path or ->` | `inspectMany` |
| `verify scope --expect <path or -> [--summary]` | `verifyScope` |
| `flashcards apply --plan <path or -> --idempotency-key KEY [--apply] [--summary]` | `applyFlashcards` |
| `wiki apply --plan <path or -> --idempotency-key KEY [--apply] [--summary]` | `applyWiki` |

[Read receipts](read-receipts.md) documents every selector/check/receipt field and [task plans](task-plans.md) every
inner plan, bound, text segment and apply receipt. Flashcard `cardCluster` defaults off; `cc` is added only when the
plan sets it to `true` with a title and at least two new cards. Optional `parentRemId` appends new cards, untagged,
to an existing tagged topic Rem directly under the daily document; it forbids `title`. Optional `tags`
(`{"root":[...],"card:<key>":[...]}`) replaces `homeRootId`/`tagRemId`: every created Rem gets exactly its declared
tag IDs, verified in the receipt, and `parentRemId` no longer requires a tag on the topic. Flashcard questions accept a plain string or
`TextSegments`; native references use `{"remId":"EXACT_ID"}`, and plain strings containing `[[` or `]]` are rejected.
Flashcard plans that contain only `answerPatches` or `reusedCardRemIds` omit `dailyRemId`, `homeRootId`, `tagRemId`,
`parentRemId`, `title`, `cardCluster`, and `tags`; exact existing targets replace creation context.
A flashcard answer line may be one code-block segment `{"code":"...","language":"plaintext"}`. Apply stores the SDK
code-block element and sets `isCardItem` so the line is on the card back. Applied receipts include `answerLines`
with `verified`. New cards and flashcard patches compare card facts before the text write and again after
`setIsCardItem`. A mismatch sets that line's `verified` to false and `error` to
`Card identity or history changed while writing an answer line`, and the receipt is not `verified`.
Patching that line back to plain text leaves `isCardItem` true.
Leaf `--help` includes examples and schemas for
installed agents.
Read input is the whole request; apply files contain only the inner plan. Preview is default. Full receipts precede
nonzero exits on failed/incomplete reads or nonverified apply. Required WIKI/card proof scopes must not be narrowed
merely to pass. Raw context title/text/backText/aliases are limited to explicit remIds; task ids/facts contain metadata.

`--summary` keeps status, IDs/hashes, scopes, counts and failures, without content/history
bodies or passing-check detail. Exit semantics are unchanged. Wiki batch receipts use
`verificationScope:affected_objects`; after the last Wiki mutation, final task acceptance
still requires explicit whole-Wiki `verify scope` zero-card/card-structure proof.

Preview/apply never look up dates or create daily documents. Native dailyDocument type does not prove calendar
freshness without a date scalar. Caller revalidates intended dates before new batches/after midnight; replay keeps
the original diary. Active KB and official authorization are rechecked immediately before each SDK mutation after awaits; known-created
Wiki objects must remain plain/ordinary/untagged non-card. Existing grouped-index entries use the full bounded tree;
missing/new grouped entries fail before writes and require reviewed exact-section fallback. Do not flatten/guess.

SDK discovery fetches and verifies the live catalog once per command. Calls carry the
expected catalog hash and fail on drift. There is no persistent metadata cache or offline
fallback. Task journals and ID-only paging snapshots are private CLI state scoped to the KB.
