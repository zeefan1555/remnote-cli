# remnote-cli Command Reference

`remnote-cli` is automation-first: JSON is the default output mode. Use `--text` for human-readable output.

## Invocation

```bash
remnote-cli [global-options] <command> [command-options]
```

Live commands require RemNote open with the authenticated RemNote CLI Bridge enabled.
`sync read`, `sync save`, `sync status`, `sync lint`, `sync diff`, `sync format` and `sync relocate` operate offline. A live command owns a
short-lived loopback connection; no daemon or MCP endpoint is used.
Run `remnote-cli pair --kb-id ID` once and enter its private token in the plugin.
See [configuration](configuration.md) for permissions and private pairing-file handling.

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
| `--port <number>` | paired port (3002 by default) | Loopback WebSocket listener port |
| `--kb-id <id>` | paired KB | Require this exact knowledge base |
| `--allow-destructive` | off | Explicitly authorize destructive SDK calls in addition to plugin gates |
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

The private Obsidian vault is the content authority. Users in Obsidian and agents
edit the **same Markdown files**; native review history remains RemNote-owned.
Ordinary sync publishes local changes against a verified baseline. Native-only
body, tag or child changes block publication rather than merge into local source.
The receipts below describe the current source contract;
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
| Local deletion | Remove bound content locally and run `remnote-cli sync apply DIR`; selected exact mirrored identities are removed after conflict and permission checks |
| Guarded local edit | `remnote-cli sync read DIR PATH`, then optionally `sync save DIR PATH --content-file FILE --expected-file-hash HASH`; offline, not a daily prerequisite |
| Input-bound native audit | `remnote-cli sync apply DIR --path PATH --expected-file-hash HASH`; exactly one file, full native proof and output outline from this invocation |
| Format conversion | `remnote-cli sync format DIR`; convert or canonically re-render a clean sealed publication, zero backend calls |
| Missing baseline observations | `remnote-cli sync baseline-align DIR [--path PATH]`; read-only native preview, then `--apply --plan-hash HASH` for exact local publication |
| Explicit one-time native source adoption | `remnote-cli sync baseline-align DIR --accept-native-source --path 'Exact.md'`; exact approved files only, preview then exact `--apply --plan-hash HASH`, zero native writes |
| Interrupted outgoing sync | `remnote-cli sync resume DIR --plan-hash HASH`; exact original plan and IDs only, no new scope/path selectors, never replay an uncertain write |
| Local publication recovery | `remnote-cli sync recover DIR` only finishes verified local publication; preserve exact plans, journals and IDs |

### Scope and path selection

Plan and apply share `--scope changed|all` (default `changed`) and repeatable
`--path PATH`. Path selects files/directories; no path means the entire vault.
Changed scope reconciles bound IDs in selected locally dirty documents, including
deleted identities and necessary verification dependencies. All scope reconciles
every bound ID in selected documents. Observed remote-only content and direct-tag
edits are conflicts, not incoming edits. Changed scope first probes public snapshots and
`getTagRems` in bounded batches, reading full flags/cards only for changed Rems and
write dependencies. All scope additionally audits full native snapshots for every
selected Rem. A clean changed invocation performs no full card/history reads.
Neither scope is a remote changes-since API or discovers unbound roots.

Verification-only dependencies may have uncollected direct tags (absent/null),
which are not an observed empty set. Changed sync freshly reads that membership
and all newly reached sealed tag dependencies before either later public check.
Known membership, content and structure still must match; missing dependency
baselines fail closed. These proof observations do not expand the selected publication
scope or refresh unpublished records and clocks.

Paths are vault-relative Markdown files or directories, not globs or native IDs.
Repeated/equivalent paths such as `Folder` and `./Folder` are normalized and
deduplicated. Previously tracked missing Markdown files can be selected as deletion
intent. Other missing paths, paths outside the vault, symlinks and non-content
files are rejected. An existing directory with no content Markdown is a valid
empty selection: it returns offline `unchanged`, `remoteChecked: false`, with no
remote reads. Path filtering is not hunk selection; existing unsynced edits in a
selected file remain in scope. Out-of-scope changes are not absorbed into the
baseline or overwritten by publication.

Every selection still runs full-vault local lint, identity validation and frozen
file checks. A scoped command cannot bypass invalid content elsewhere.
`sync diff DIR` accepts the same path filter but is offline and has no scope selector.
Status/lint inspect the whole vault. Local deletions obey the same scope/path filters.
There are no root sync actions, push/pull aliases, force,
since, daemon or arbitrary conflict-winner options.

### Initial import and privacy

`sync import` publishes the human-readable format by default. It requires explicit global `--kb-id` and a new directory without
content or a prior manifest. It establishes the initial common baseline; even a
clean existing vault cannot be re-imported. Later local edits are desired source;
native-only source changes require a separate explicitly authorized adoption.
Ordinary sync never selects a winner by timestamp or overwrites local source from native.

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

Ordinary sync probes bound IDs using public `findMany` batches of at most 50.
New native descendants remain structural conflicts; they are not recursively read
or imported by the publisher. Receipts report `discoveryScope: "bound-ids"` and
`globalDiscoveryComplete: false`, distinct from the initial import receipt.
Incomplete reads, missing objects and reparenting are explicit failures or
conflicts, not silently omitted content. New top-level roots are not
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

Workspace writers hold a nonblocking OS advisory lock on the permanent
`.sync/writer.lock` inode. Initialization publishes the complete version marker
atomically; the file remains after success, failure and process death. A paused
writer still owns the lock. Confirmed process exit releases kernel ownership,
so the next command can acquire it without deleting metadata. Legacy JSON,
incomplete/unknown markers, unsafe paths and changed identities are refused
unchanged; there is no PID/TTL takeover, migration or existence-lock fallback.
Use a single host and a local filesystem. The local verification baseline is
macOS/APFS; shared/network filesystems and power-loss recovery are not verified.
Native-addon loading and unsupported locking errors fail closed.

Lock availability proves only local ownership has ended, not that an outstanding
SDK request has completed. Preserve pending journals and known IDs: `sync recover`
still requires verified outcomes, and `sync resume --plan-hash HASH` still uses the
exact original plan and readback proof. Unknown mutations are never replayed merely
because a lock is available; uncertain before-state or a create without its
persisted ID remains a refusal.

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
new-authority/mirror readback succeeds. The same permanent lock inode moves with
the directory and remains held through readback. After process death the exact
original command can resume through that receipt; a copied or replaced directory
is refused. Do not raw-move a bound directory, rewrite its mirror, substitute
another destination or delete unknown lock metadata. Synthetic process-death
tests prove this local ownership/receipt path, not native SDK completion or
power-loss recovery.

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
For guarded editing, use `sync read DIR PATH` to obtain the complete tracked Markdown `content`
and its `fileHash` from the same read, then edit that source and call `sync save`
with the returned hash and complete `--content-file` (or `-` for stdin). `PATH` is
the exact workspace-relative Markdown path, not a native Rem ID. Both commands
are offline and report `remoteWrites: 0`; read includes fixed `contentAuthority: "local"` and returns `status: "read"`, and save
returns `status: "saved"` or `"unchanged"`, the resulting `fileHash` and changed
Rem keys. Copy the returned hash verbatim rather than substituting a file mtime.

Read also returns `outline: {schema: "remnote-outline/1", path, nodes}`. Each node
is keyed by exact native ID or local key, with effective local text/kind/parent/
children/tags and an `observed` sealed native baseline (or null for a new Rem).
Direct tag ancestors are included. `observed` is not a fresh remote claim.

For an input-bound full native audit, pass that unchanged read hash to
`sync apply DIR --path PATH --expected-file-hash HASH`. This accepts exactly one
tracked file and validates its bytes before connecting. It implies full native
verification of that file and direct-tag ancestry, including cards, complete
available review histories and previously known Powerup codes. It is deliberately
more expensive than ordinary changed-scope probing; it introduces no learning-specific
policy. A fresh zero-write audit returns `verified`, not an
offline success. The returned `outline` and `verification` bind the same invocation:

- `fileHash` is the original input hash; `planHash` is the exact applied plan.
- `nativeBefore` / `nativeAfter` map IDs to `cardIds` and `reviewHash`. The latter
  hashes CardID, owner, type, createdAt and full repetition history, sorted by ID;
  unknown history stays null. Scheduling timestamps are not history conservation.
- `observedHashes` contains only freshly verified IDs and binds their projected
  native observations, never sealed-only dependencies. Powerup values cover only
  explicitly known codes; absent facts and pinned status remain unknown.

Consumers compare those proofs themselves. No `reviewHistoryPreserved` boolean is
asserted. Before the first mutation, guarded apply seals the original plan and
`nativeBefore` in its journal. Preserve failure receipts and original inputs;
`sync resume DIR --plan-hash HASH` validates that binding and exact-ID journal
effects, then returns the same original file/plan proof with fresh nativeAfter.
It never replaces original nativeBefore with recovery-time history. Tampered or
unreconstructible proof/journals fail closed, without replaying uncertain writes.

Save validates the whole workspace and rejects stale hashes before staged local
publication, without advancing the native baseline. It generates no content
clocks. Direct editor changes are equally valid desired input. Uncertain mutation
journals block save and sync; a local-authority preview with no steps may be
replaced. Consumers must check the read authority marker before calling apply.

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

Optional frontmatter accepts display-only `title` and `aliases`, a native-mapped `tags` array,
plus `rems[shortKey].content` (`text` or `multiline`) when a new node needs an
explicit content kind. Ordinary text is the default; only a new multiline
question needs the explicit `multiline` declaration. Existing node/card kinds
come from identity-bound records and flags: edit their body directly, without
restating native metadata. Existing identity and native facts cannot be replaced
through YAML. H1 is the sole root-text authority; optional `title` is not a
second source of native text. Publication preserves display attributes.

One creation-only intent is also accepted: `rems[shortKey].cardCluster: true`
on a new ordinary text topic (not a root, cardItem or question). It adds native
`cc` within the same journal before parenting, verifies `hasPowerup('cc')` and
consumes the attribute after publication. Existing objects and false/removal
intents are refused. `sync read` exposes `intent.cardCluster: true` and effective
`powerups.cc: true` while `observed` stays null; only native readback supplies
the published observed Powerup. Normal cheap probes also verify previously
observed cc; they do not silently assume it is still enabled.

The following native facts are retained in hidden records and hydrated metadata,
not accepted as user frontmatter:

`native` records type, parent, ordered children, Document/Folder/card-item flags,
practice direction/enabled state, tags and references. Structured facts use:

- `powerups`: `{code, slots: [{slot, valueRemId, valueRichText}]}` entries.
- `propertyValues`: `{propertyId, valueRemId, valueRichText}` entries (not `properties`).
- `portal`: `{type, directlyIncludedRemIds, query?, filter?}`, or `null`. Query and
  Filter are opaque, read-only values from public search-Portal slots. An absent
  field means uncollected, while an observed empty property is `null`. These observations never authorize importing native-only Portal children.
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

A direct text leaf under a multiline question may be genuinely empty (for an
answer separator). Give it a stable short anchor; it becomes a native cardItem,
not a separate card. Empty ordinary notes, topics and questions remain invalid.

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
| Top-level YAML `aliases` | Obsidian display/search metadata; no native Alias mutation |
| Top-level YAML `tags` | This file's document/root direct native Tag memberships only |
| Bullet inline `#HOME/...` or `#Term/...` | That bullet's direct native Tag memberships only; no promotion to page tags |
| `.remnote/identity.json` `tagIds` | Sealed one-to-one Obsidian token → exact native Tag RemID binding |
| Hidden native reference metadata | Exact Rem ID relationships; ordinary wiki links use the same native IDs |
| `![[path/note]]` | An Obsidian embed, not automatically a RemNote reference or Portal |

Generated links use full vault paths. Input resolves exact paths first, then a
unique basename; `[[path/note#Current H1]]` resolves that note's sole current H1.
Broken paths, missing block IDs, ambiguous short names and
duplicate identities fail lint instead of guessing a target. Renames must leave
references resolvable. Display aliases do not change native identity. New embeds
without a verified public-SDK mapping fail the whole sync before remote writes;
existing native Portals retain their original value and are explicitly read-only.
Readonly reference display labels are sealed alongside the local baseline, not
regenerated from later target titles. Renaming a supported canonical target keeps
its reference IDs and existing readonly labels through apply, resume, recover and
format. Changing those labels still fails lint; the complete opaque projection
and native Portal guards remain enforced. An older baseline without a display
seal derives it only from verified sealed native records, never from proposed edits.
The display seal normalizes resolvable Wiki paths to their exact native target ID,
so supported file renames may update paths without changing labels or references.
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

Tags use Obsidian's case-insensitive, hierarchical token syntax (letters, digits,
underscore, hyphen and slash; not numbers alone). Registry names derive from the
native plain-text ancestor path and retain their exact-ID binding. For a never-used
existing tag, an exact complete sealed ancestor path can establish a unique candidate
binding. The plan includes its ID; fresh native target/ancestor verification precedes
all writes, and only successful publication seals the mapping. Basename matching
is not a fallback. Unknown tokens,
case-folded/native-path collisions and missing tag ancestors fail closed; sync does
not create or guess a tag entity. Literal hashtags are escaped; inline code, escaped
hashes and URL fragments are not memberships. Tags of opaque Rems remain read-only.
Direct tags are local desired memberships. Native-only tag drift blocks the batch;
there is no set merge, name-based TODO exclusion or implicit tag acknowledgement.

Removal always calls `removeTag(tagId, false)`, retaining properties, Tag Rems,
CardIDs and history. The existing Bridge marks this atomic method destructive:
apply authorizes only each exact planned mirror removal and requires both live plugin
write gates. `plan` lists exact `tagChanges` and
`requiredPermissions`. Without that gate the entire apply refuses before text,
add-tag or other writes; it never changes plugin settings. Ordinary tag additions
require only the normal write gate.

### Explicit format conversion

`sync baseline-align DIR` is an explicit one-time alignment for a complete, clean,
bound vault whose original import did not collect direct tags or Portal
query/filter fields, or did not seal readonly display. It reads only selected
bound IDs and the bound ancestors of their direct tags; it does not discover or
import roots. Missing tags must be observed as arrays; missing Portal fields must
be observed as null. Known tag, body, structure and Card-identity drift aborts
before publication. Unpublished local edits are refused rather than overwritten.
Root tags are inserted into YAML `tags`, child tags into the exact bound bullet,
without whole-file rendering. Ambiguous or hidden insertion sites fail closed.
Review `planHash` from the preview, then run the same command and selectors with
`--apply --plan-hash HASH`. Source/native observations must still match. This
operation makes zero native writes and preserves sealed Card/history/original
records; its history count reports only freshly known histories, never claims
that unknown history is empty. Interrupted local publication uses `sync recover`.

Only with explicit authorization to accept an already-reviewed exact set of new
native leaves, repeat `--accept-new-parent ID` and `--accept-new-child ID` for
the complete parent and child sets. Every parent must be bound in the selected
files and have at least one supplied child; every supplied child must be unbound,
a supported leaf and directly parented to a selected parent. The original
children must remain an ordered subsequence, and the complete difference must
equal the supplied set. The parent's content kind cannot change. New leaves are
inserted at their exact native positions using renderer-produced bullets while
all existing source bytes and node identities remain intact. Other drift still
blocks. Known or observed Portal parents are rejected before reading any new
children, including on apply verification. When the SDK omits the supplemental
reference list, an already known list is preserved; explicit drift still blocks.
Preview reports `childrenAccepted`; apply requires the same exact options
and `planHash`, with fresh proof for the parent and all new leaves. Reapplying the
set after publication refuses the now-bound IDs. This is not discovery, incoming
sync, a timestamp merge, or permission to modify native Cards or history.

When the user explicitly approves native source changes for entire named files,
use `sync baseline-align DIR --accept-native-source --path 'Exact.md'` (repeat
exact file paths as needed). This separate one-time mode requires clean local
source; directories, implicit whole-vault selection and mixed acceptance modes
are refused. It may replace the approved files with the current rendered native
text, back text, tags, references and child order, including completely read new
descendants inside those documents. Missing/deleted or reparented old nodes,
new Document/Folder boundaries, cross-file additions, changed Card identities,
existing content-kind changes and other immutable drift are refused. Existing
Cards/history, facts, original records and block identities are retained; no
outside file or verification-only dependency is adopted. Existing local body bytes
must match a lossless rendering of the old baseline and unchanged nodes must
remain unchanged; otherwise adoption refuses rather than normalize formatting.
YAML comments and unrelated fields are retained. Preview returns
`sourceChangedIds`, `sourceChanges` (field names, added-child IDs and old-order
changes), and `newIds`, never body text. Missing tag initialization is reported
separately by `tagsAligned`. Review this exact scope before `--apply --plan-hash
HASH`; fresh full observations and FrozenFiles still must match. Local staging
and `sync recover` are shared with ordinary baseline alignment. This does not
enable incoming/LWW behavior in subsequent ordinary sync.

`sync format DIR` is an explicit offline conversion of a clean, sealed legacy
publication to human Markdown, or canonical rendering of a clean already-human
publication. It requires a complete manifest, no pending remote
journal or local publication, unchanged published source hashes, complete document
coverage and intact native records. It preserves native/original record bytes,
publishes short anchors and tracked identity through staged local publication,
then validates the resulting vault. It makes zero backend calls and performs no
remote write. There is no legacy parse fallback in daily sync.

A vault without sealed `tagIds` refuses ordinary sync until explicit format enables
the projection on a clean baseline. Existing nonempty display-only YAML tags are
refused for an explicit user decision, not silently reinterpreted or discarded.

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

Native Folder/Document/Tag entity changes, existing Power-up changes, moves, new embeds/media and complex
rich-text edits are outside this write surface. Existing native content is kept
losslessly and displayed read-only as faithfully as supported. Portal metadata
records its native type and directly included Rem IDs; it does not grant Portal
write support. Raw-record preservation, metadata mapping, writable support and
live/UI verification are separate coverage claims.

In ordinary publication, new native-only children are structural drift, not incoming source. No recursive
subtree discovery is performed during publication. Explicit import is available
only as bootstrap into a new empty directory. Existing moves remain unsupported.

### Local desired content and convergence

For each bound Rem compare verified baseline B, local desired L and native R,
including front/back text and exact direct tags. R=B permits local changes;
L=R converges without content writes. R differs from both B and L produces
`remote-content-drift`, archives local and remote snapshots and blocks the whole
batch before any native setter. Parent/children/type or readonly Portal/layout
drift is `remote-structure`.
No timestamp, review event or whole-file mtime selects a winner. Publication checks
the selected source graph again and rejects native body/tag/children/readonly-projection backfill,
even if a caller misclassifies it as metadata refresh.

Read, plans and execution receipts expose fixed `contentAuthority: "local"`, not
a configuration option. Native runtime facts, cards, histories and scheduling
remain read-only sidecar snapshots; their refresh preserves local source bytes,
including comments and formatting. Ordinary publication never scans or acknowledges
TODO feedback; explicit feedback processing must first change local source and
verify publication before its separate exact acknowledgement layer.

Old persisted clock fields are preserved verbatim as sealed evidence only.
New plans and successful journals generate none. Legacy or mixed-authority pending
journals are readable for reconciliation but cannot apply, resume or recover
content automatically. Errors retain the exact journal reference; do not delete
state, migrate hashes or replay an old staged two-way publication.

Before/final native hashes and frozen files provide optimistic checks, not native
compare-and-set. There remains a check-write race window and no native transaction.
Partial/unknown writes preserve identity and original evidence for exact-ID handling.

### Lint, preview and apply

`lint` returns `ok`, `complete` and diagnostics with `path`, one-based
`line`, stable `code` and `message`. Text mode prints
`path:line / CODE / message`. Any diagnostic blocks the **entire** sync before
remote calls. Metadata unsupported by the current write matrix is read-only,
not silently dropped. Existing Rem/card identity, parent/order and review history
are protected. Missing files, nodes or remote objects do not authorize movement
or automatic deletion.

`status` and `diff` inspect local state without applying changes. `sync plan DIR`
previews with zero native writes. `sync apply DIR` performs whole-workspace lint, fresh local-desired planning,
guarded apply and verification in one invocation, without requiring a separate preview.
Use `sync apply DIR --plan-hash HASH` to require an exact previous preview instead.
The hash binds normalized scope/path selectors, selected documents,
reconciliation/verification IDs and all frozen vault files, including files
outside the selection. A changed scope, materially different selection, stale
file, native content or hash is refused, not silently accepted as a new plan.
Equivalent normalized selectors reuse the same selection, not a bypass of content
freshness checks.
Either apply path binds a frozen plan, unchanged candidate files, matching KB and native
state, with live writes enabled for outgoing changes. Native content is never accepted
as replacement local source. SDK writes are
sequential, not atomic; there is no server-side CAS or exactly-once guarantee.
Unknown or partial journal outcomes remain blocked for exact-ID reconciliation;
omitting `--plan-hash` is not a retry or recovery bypass. Mirror deletions still require
the actual plugin write and replace permission gates.

Only reads are parallel: up to 16 local file reads and 4 exact-ID remote batches
of 50. Each native batch snapshots at most 4 Rems concurrently, each with up to
12 independent SDK flags (192 in-flight flag reads at the composed maximum).
Every workspace structural observation, including cheap probes, full reads,
guards and discovery, reads the public SDK `getChildrenRem()` entity list. The
optional public `children` field is not proof of emptiness: when present, it must
be a complete ordered subsequence of that list. Entity IDs must be valid, unique
and owned by the requested parent. Unknown, malformed or failed entity reads are
errors, never an empty-list fallback. Newly observed child IDs cause structural
drift; they are not traversed or imported. Later additions are concurrent changes,
not an invitation to expand an in-progress write.
Cheap probes still omit Card/history and full native-flag reads.
Ordinary `--scope changed` probes bound IDs in locally dirty selected documents
and required dependencies. A clean invocation makes no remote calls and does not
detect remote-only changes; use `--scope all` to reconcile them. It is not
a remote changes-since API. Later public checks are narrowed to the
actual publication/mutation set and its complete before/observed/intended
dependency closure, including ancestors, references, tag paths and Portal/card
relationships inside the selection. Full native/Card/permission/pre-mutation
guards remain in force; unknown native flags remain unknown. `all` and guarded
apply retain their complete proof scopes.
Read results retain input order; failures stop their pool and drain in-flight
work before returning, without passing partial reads into writes. Parsed source
and bytes are reused only within one operation. Full content hashes, safe paths,
permissions and metadata are freshly checked at the write/publication boundaries;
mtime is never a freshness shortcut. There is no persistent parse cache.

Current receipt fields (arrays contain exact Rem IDs unless noted):

| Status | Fields and meaning |
| --- | --- |
| `preview` | `complete: true`, `planHash`, numeric `creates` / `updates`, `converged`, `outgoing`, `metadataRefresh`, optional `deletion`, `atomic: false`; new outgoing entries use `new:key` |
| `verified` | `complete: true`, `planHash`, `ids` mapping `new:key` to native ID, existing `updated`, `converged`, native-ID `outgoing`, `metadataRefresh`, `deleted`, `nativeCards`, `atomic: false`. A deletion reports `checkedSurvivingCardIdentitiesPreserved` and exact `checkedSurvivingRemIds`; a non-deletion may report `cardsPreserved`. |
| `unchanged` | `complete: true`, `changes: 0`; no content or metadata publication needed |
| planning `conflict` | Exit 1, `complete: false`, `planHash`, `conflicts`, any archived `remoteWrites: 0`; no apply is authorized by this receipt |

Read `remoteChecked` as actual remote-read evidence, not a constant: an empty
selection can return offline `unchanged`
with `remoteChecked: false` and no checked IDs. Bound-ID planning reports
`discoveryScope: "bound-ids"`,
`globalDiscoveryComplete: false`; even an all-scope
success cannot establish global discovery. `diff` is local-only and reports
`remoteChecked: false`; it cannot establish remote freshness or convergence.
`checkedIds` / `checkedCount` describe the bound IDs and verification set,
not the number of SDK calls or repeated reads. Created IDs have separate `ids`
and readback receipts. `selection` records canonical `paths`, selected `files`,
actual local-key `outgoingKeys`, `reconcileIds` and disjoint `verificationIds`.
Verification-only dependencies do not advance their baseline. Unselected bytes
and unassigned bullets stay intact. Only local outgoing/converged content,
selected runtime metadata and assigned creations publish; structural-only parents
receive verified children only. A late unrelated body/tag edit is left for the
next selected probe, not silently absorbed. Previews/conflicts do not create clocks.
Layout-only publication preserves native records and any independent pending plan.
All these receipts include `contentAuthority: "local"`.
The acceptance driver records wall time and native mutation steps separately;
SDK transport calls are explicitly `not-instrumented`.
Each planning conflict records `id`, `path`, `reason` (`remote-content-drift`,
`remote-structure` or `remote-missing`), `baseHash`, `localHash`, nullable
`remoteHash` / `remoteUpdatedAt`, a private `localSnapshot` path and a
`remoteSnapshot` path or `null`. The local version remains in place; opaque local
snapshots preserve the real baseline content rather than their display placeholder.
A mutation-stage failure may also use status
`conflict`, but carries `journalKey`, known `ids` and `steps` instead of the
planning `remoteWrites: 0` guarantee: inspect that evidence before any next action.

Deleting a bound outline node or tracked document locally expresses deletion intent.
`sync plan DIR` previews exact `deletion.roots` and descendant `deletion.ids`;
`sync apply DIR` performs the selected deletion with fresh conflict checks and
exact absence verification. A dirty parent document outside the selection blocks
deletion of its mounted child until that parent is selected. Unknown identities,
unverified parents, unsupported native structures, remote drift, disabled plugin
gates and incomplete journal outcomes fail closed. The global `--allow-destructive`
flag is not needed for mirror deletion or association-only tag removal; other SDK
operations keep their existing permission rules.
Any new node alongside a deletion is ambiguous with a lost or mistyped identity
and stops before any native call, even if the new node has an anchor. Restore the
identity or separate deletion and creation into different synchronizations. An
unrelated selected content edit can still proceed without publishing unselected
creation/deletion. A sync is bounded to 100
deleted identities; imported scope roots and targets referenced by surviving
local nodes cannot be deleted. Individual answers of a surviving multiline card
cannot be deleted: native Card identity preservation has not been proven. Delete
the whole card when intended; do not claim its deleted history is preserved.
Missing or replaced parent directories, identity collisions, and the loss of all
tracked documents in a directory containing multiple documents are ambiguous and
stop before native writes. Directory deletion is not supported.
The parent directory identity and complete file set are rechecked before and
after every destructive mutation; a mid-batch change stops the remainder and
leaves its journal for exact reconciliation. These checks are optimistic, not an
atomic filesystem/native transaction. A missing single document in an existing
directory remains authorized deletion intent, not proof against every possible
mount failure that predates inspection.

Local reference checks include known native relationships and surviving opaque projections, but do not discover
remote-only references in unselected or unbound Rems. `partial` and
`globalDiscoveryComplete: false` explicitly prevent a full-KB safety claim.
`checkedSurvivingCardIdentitiesPreserved` covers id/remId/type only for the exact
`checkedSurvivingRemIds`, not deleted cards, unselected content or review history;
guarded deletion resume does not make this preservation claim.

`sync read DIR PATH` always returns `deletion: {roots, ids}` for that exact
tracked file. A missing tracked file returns `content: null`, `fileHash: hash(null)`
and an empty outline. Guarded `sync apply DIR --path PATH --expected-file-hash HASH`
returns `deleted` only after native absence verification. Its `deletionParents`
contains each observed surviving parent; `verification.observedHashes` binds the
same parent revision. Guarded resume rechecks absence and these observations.

Deleting a Rem does not promise to purge all historical Card records. Never
delete review history to make an acceptance test pass.

The verified receipt reports outgoing/converged changes and identity/card
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
Recovery verifies the exact recorded identities and final hashes; it never
expands the selected graph or discovers native-only descendants.
The final journal separately seals exact native verification hashes, bounded
`publicationIds`, and `publishedBaselineHash` over the complete original relevant
resulting semantic baseline (including unchanged records and deleted identities,
excluding remote-owned review history/scheduling and arrival timestamps). Its
integrity hash binds those fields to the original plan, selection, inputs and
assigned IDs. Missing or inconsistent proof is refused without migration.
Old content-version evidence is not executable recovery policy. Missing local
authority or legacy incoming/winner records stop recovery before native access or
local stage publication, keeping the exact original journal intact.
These checksums detect corruption and mismatches, not malicious writers able to
rewrite the same journal and recompute its checksum.
Recovery reads frozen verification IDs without rediscovery and validates the
projected baseline before publication; it performs zero native mutations.
Interrupted staged sync publications retain that exact journal binding even
after the next manifest is installed and `pending` disappears. Under the same
writer lock, recovery checks all staged/backup integrity before activating the
backend, verifies the frozen native proof and resulting baseline, then rechecks
the unchanged ledger/content before finishing. Local-only import/save/format
recovery remains offline. Neither path provides a native/local atomic transaction.

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
   those same identities. Repeating an ordinary published plan returns `already-complete`
   with zero native calls/writes while its published baseline still matches.
   A guarded plan instead makes fresh exact-ID proof reads and returns `verified`
   with the original input/nativeBefore binding, never duplicate writes.

The bounded resume implementation accepts outgoing-only plans that reconstruct
exactly; it does not resume deletion or converged plans. Legacy incoming/LWW
journals are evidence only, never an executable fallback.
Different source bytes, malformed/noncontiguous steps or concurrent native edits
require reconciliation outside this command. Do not delete state to bypass a
refusal. A verified remote journal delegates to publication recovery; guarded
resume then refreshes exact native proof without replaying mutations.

Outgoing journals do not record the creation-time Card identities of newly made Rems.
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
stable-block checks, local outgoing publication, same-result convergence,
remote body/tag/children drift and zero-write archived conflict cases. The deliberate conflict must prove zero remote writes and preserve both
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
Missing or null history yields `historyLength:null` and `hash:null`; only an explicitly
empty array yields zero reviews and a history hash. `rawCards[].repetitionHistory` is
likewise null when unknown. Malformed history produces a field error, not empty evidence.

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
In JSON, unknown review history is `null`; an explicit empty array means known zero reviews.

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

List exact-tag todos (read-only):

```bash
remnote-cli todo list --tag-id <todo-tag-rem-id>
```

The old transaction-based `complete`/`reopen` commands and `update_todo` operation
are removed. Explicit local-source feedback processing uses:

```bash
remnote-cli sync feedback bind DIR --todo-tag-id TODO_ID --done-tag-id DONE_ID
remnote-cli sync feedback capture DIR --id FEEDBACK_ID --target-id TARGET_ID
# Edit the exact local file, then publish its current hash through the existing publisher.
remnote-cli sync apply DIR --path PATH --expected-file-hash HASH
remnote-cli --allow-destructive sync feedback ack DIR --receipt CAPTURE_HASH --plan-hash PLAN_HASH
```

`bind` requires complete, clean, already-aligned local source, existing sealed role
IDs and known direct-tag evidence. It only seals exact roles and necessary private
metadata; zero Markdown and zero native writes. Authored role tokens are rejected
with their paths. It does not initialize or repair missing native baselines.

`capture` reads only the exact separate feedback attachment and explicit targets
(`--target-id` is repeatable, all in one file), under a reciprocal canonical physical
parent. The attachment must be an unfinished native checkbox with the exact TODO
role, an observed non-card plain-text/reference subtree and an existing native
reference plus reciprocal backlink to each target. A parent edge alone is not a
reference. Canonical TODO nodes remain content; they are not capture candidates.
Cards/cardItems, Portals, cycles, canonical descendants and unknown shapes fail
closed. The private receipt binds KB, workspace, ID, revision, target path/IDs,
clean source baseline and the publisher execution cursor. It contains feedback
evidence but never creates a Markdown entry. Repeated capture of the same revision
keeps its original receipt and binding.

`ack` requires a subsequent real verified target-content change, its exact guarded
publisher journal and fully completed local publication, with fresh native
content/card/history and reference proof. Old journals, same-source/no-op or
unrelated edits cannot acknowledge feedback. It preflights destructive permission
and both live gates before durably executing checkbox Finished → add DONE → remove
TODO (`removeTag(tagId, false)`, no property deletion). Unknown outcomes retain the
receipt: repeat the same ack to recognize an exact after-state, never replay the
uncertain atom or republish content. Changed/unknown evidence stops. Repeating a
finished ack makes zero writes. Ordinary sync only classifies unexpected exact
children; it never globally queries TODOs or captures feedback. Physical child
order is preserved, while validated TODO/DONE attachments stay outside canonical
Markdown and identity membership.

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
an inner stdin payload, and do not put `--port`, `--kb-id`, `--allow-destructive`, or `--verbose` on an inner command.
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

- Authenticates the plugin and checks the exact KB and live SDK catalog.
- JSON output includes KB ID/name, protocol, SDK version/catalog hash, plugin/CLI versions,
  live write-policy flags and connection timing metadata.
- Product versions are informational; there is no `version_warning` or minor-version coupling.
- Text output shows connection, plugin/CLI versions, KB and protocol. Failures exit 1.

```bash
remnote-cli status --text
remnote-cli --port 3005 status --text
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
the original diary. Live write gates are rechecked immediately before each SDK mutation after awaits; known-created
Wiki objects must remain plain/ordinary/untagged non-card. Existing grouped-index entries use the full bounded tree;
missing/new grouped entries fail before writes and require reviewed exact-section fallback. Do not flatten/guess.

SDK discovery fetches and verifies the live catalog once per command. Calls carry the
expected catalog hash and fail on drift. There is no persistent metadata cache or offline
fallback. Task journals and ID-only paging snapshots are private CLI state scoped to the KB.
