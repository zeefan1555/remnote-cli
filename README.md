# RemNote CLI

Command-line access to a RemNote knowledge base. Each command opens a loopback
WebSocket, talks to the [RemNote CLI Bridge](https://github.com/zeefan1555/remnote-cli-bridge)
plugin, and closes the connection.

```text
remnote-cli <-> authenticated loopback WebSocket <-> RemNote CLI Bridge <-> RemNote SDK
```

There is no MCP endpoint, stdio proxy, resident daemon, or cloud relay.
`batch --file` keeps one listener open across a list of commands so back-to-back
calls do not collide on the CLI port. Keep RemNote open with the paired plugin
enabled. An idle plugin waiting for a CLI command is normal.

[Native rollback acceptance remains blocked](docs/acceptance.md).

## Install

Use Node.js 22.13.0 or newer. Node.js 24 matches `.nvmrc`.

```bash
git clone https://github.com/zeefan1555/remnote-cli.git
cd remnote-cli
npm ci
npm run build
./link-cli.sh
remnote-cli --version
```

`./link-cli.sh` registers `remnote-cli` with the current npm prefix. A later
`npm run build` in this repository updates that command. `./unlink-cli.sh` removes
the link.

## Pairing

Install **RemNote CLI Bridge** from the RemNote marketplace. Its manifest id is
`remnote-cli-bridge`. Enable it in RemNote desktop and grant content access plus
**KnowledgeBaseInfo: Read**.

```bash
remnote-cli pair --kb-id YOUR_KNOWLEDGE_BASE_ID
```

The knowledge-base id is in the RemNote knowledge-base URL. Pairing writes
`~/.config/remnote-cli/connection.json` with mode 0600 and does not print the
token. Paste that token once into the plugin setting **CLI pairing token**. Set
**CLI loopback WebSocket URL** to `ws://127.0.0.1:3002`, or to the port you passed
with `--port`. Enable **Accept write operations** only when writes are intended.

```bash
remnote-cli status --text
```

A plugin that still reports id `zeefan-remnote-sdk-bridge` or the name
RemNote SDK Bridge remains accepted while that build is replaced. Plugin version
numbers are informational. Both peers must implement protocol 2 and the verified
SDK catalog; protocol-1 builds are rejected before SDK dispatch. Pairing files
use `schemaVersion: 1`, independently of the wire version. Old `protocolVersion`
configuration is rejected without modification; re-pairing needs explicit authorization.

See [installation](docs/guides/installation.md) and
[configuration](docs/guides/configuration.md).

## Basic usage

```bash
remnote-cli search "topic"
remnote-cli read REM_ID --content-mode structured --depth 1
remnote-cli list-children PARENT_ID
remnote-cli status --text
```

JSON is the default. `--text` is the human-readable form. A lost response does
not prove that no data changed: read the returned ids before retrying a write.

## Shared Obsidian vault and two-way editing

The sync design supports editing in both a private human-readable Markdown vault
and RemNote, including card edits during review. Users in Obsidian and agents
edit the same local files. A shared baseline supports per-Rem semantic three-way
merging without whole-file last-write-wins. Keep
content outside code Git, optionally in a separate private content repository;
network backup needs explicit user authorization. Sync does not configure Git or
upload content to a remote.

```bash
remnote-cli --kb-id KB_ID sync import /PRIVATE/vault --root-id ROOT_ID
remnote-cli sync status /PRIVATE/vault
remnote-cli sync apply /PRIVATE/vault
```

Import establishes the initial baseline in a new empty directory, from a declared
subtree or official `.rem` archive. Subsequent sync plans may contain incoming and
outgoing changes together; re-import is not a substitute for merging. Compared to
the shared baseline, one-sided changes propagate, equal changes converge, and
edits to different Rems merge. Conflicting edits may select a newer value only
with trustworthy comparable version evidence; unknown/equal times preserve both
versions. File mtime, sync capture time and review time are not content authority.
Review history and scheduling remain RemNote-owned and never flow back from a
local snapshot. Missing content on either side does not imply deletion.

Daily editing needs one `sync apply DIR` invocation: it validates, plans,
applies and verifies without a manual read/save/lint/diff/preview pipeline.
Use `sync plan DIR` for a preview with zero native writes, or add
`--plan-hash HASH` to apply a previously reviewed frozen plan. `sync` is only a
command group; `apply` has no `--apply` flag. Neither apply form retries uncertain
writes automatically.

Plan/apply default to `--scope changed`: every bound Rem in the selected files
gets a lightweight public-content/direct-tag probe, so remote-only edits are
detected in the same command. Only changed Rems and write dependencies need full
native snapshots. Repeat `--path 'Folder/Note.md'` or `--path 'Folder'` to select
vault-relative files/directories, not globs or individual patches. `--scope all`
also audits full native flags/cards for every selected ID; omit `--path` to select
the entire vault. Out-of-scope local edits
are preserved, while local lint, identity validation and freezing still cover the
whole vault. Changed scope is not a remote changes-since feed or proof of global
freshness. `sync diff DIR` is offline and accepts `--path`; status/lint stay
whole-vault. Frozen plan hashes bind the normalized selectors, actual selection
and full-vault frozen inputs, so a materially changed selection cannot reuse one.
Dependencies are checked for safety, not merged as incoming content or given new
baseline clocks. A later all-scope sync still sees their remote-only edits.
Only empty selections stay offline. A clean nonempty changed selection reports
`unchanged` after probing, not a fresh review-history audit. Unselected source
bytes, native records and clocks stay unchanged.

The current candidate reports `incoming`, `outgoing`,
`converged` and conflict receipts; native acceptance is separate. The offline
`sync read` / `sync save` workflow binds controlled local edits to each changed Rem
version's content hash and save time. Divergent same-Rem edits use whole-Rem
`version-time-lww` only with comparable, hash-bound local/native clocks, after
archiving both versions. Direct file edits do not establish a trusted local clock;
missing, equal, or invalid clocks preserve both versions as `untrusted-edit-order`.
Independent front/back edits to the same basic card still share one whole-Rem
merge unit, not individual fields.
Legacy `pull`/`push` aliases are removed. Continuous discovery follows the native
children of selected bound Rems in batches of at most 50. Fully observed new
descendants, including empty Rems, nested Documents/Folders and Portal/query
children, join the frozen plan as `selection.addedIds`. Their exact identities,
native cards, tags and collected raw facts are preserved. Existing children must
keep their parent and relative order; deletion, movement, reordering and concurrent
local/remote insertion under one parent fail or conflict. Receipts use
`discoveryScope: "bound-descendants"` when additions are found, otherwise
`"bound-ids"`; both keep `globalDiscoveryComplete: false`. New top-level roots
and children of unselected Rems are outside scope. An initial archive import does
not prove continuous whole-library coverage.

Ordinary nested Markdown lists use short, stable Obsidian anchors; a single
hidden `<!-- remnote:document-key -->` before H1 binds each imported document.
There is no YAML when no user attributes are needed. Optional `title` and
`aliases` are display metadata. YAML `tags` maps only the document/root's
direct native tags; bullet inline tags map only that Rem's direct tags. Exact
token-to-RemID bindings live in the sealed identity registry. An unused native tag
can be selected by its complete unique sealed ancestor path; new bindings are
verified remotely and published only after success. Missing or ambiguous tokens fail.
A new multiline question needs an explicit
`rems.<short-key>.content: multiline` attribute. Existing card types are recovered
through identity-bound native records. New ordinary bullets need no hand-written
YAML or anchor; verified publication assigns identity.

For a new ordinary topic only, `rems.<short-key>.cardCluster: true` requests native
`addPowerup('cc')` in that same sync journal. It is checked with `hasPowerup`, not
inferred from a name or tag, and consumed after publication. Existing capabilities
cannot be changed this way.

Tracked `.remnote/identity.json` maps KB, document and short block keys to Rem IDs;
the one-to-one `tagIds` registry is included. Native records, originals, card identity and history stay in hidden read-only
sidecars, not user YAML. Generated links use full vault paths; unique basenames and
the named document's current H1 fragment also resolve on input. Broken or ambiguous links, invalid
identity and unknown YAML fields fail lint before remote writes. Local file moves
do not move native Rems. Portals and auxiliary reference areas remain read-only
native structures, not diagnostic note text or working Obsidian dynamic queries.

New imports use this human format. For a clean previously published native-YAML
vault, explicit offline `sync format DIR` converts its projection with zero backend
calls, preserving native records and originals. Dirty source, incomplete baselines,
pending journals or damaged identity are refused; daily sync has no legacy fallback.
The same explicit command can canonically re-render a clean already-human vault,
including empty-note block anchors, without changing native records or clocks.
It reports `already-formatted` only when no publication is needed.
See the [sync reference](docs/guides/remnote-cli-command-reference.md#sync) for exact
format and write boundaries.

Keep the vault root 0700; Obsidian-saved Markdown may be 0644, CLI-created Markdown
is 0600, and private sidecars/state remain 0600. Exclude `.obsidian/`, `.trash/`
and `.DS_Store` from content scans, frozen plans and Git; also ignore `.sync/`,
locks and credentials in Git. Existing Rem/card IDs, parent/order and review
history are protected; file removal is not a delete or move instruction. Preview
deletion separately with `sync delete DIR --id ID --scope-root ID`; execution
also requires `--apply --plan-hash HASH`, destructive authorization and live write
gates. Delete accepts no scope/path filters. For
native syntax, explicit deletion and recovery, see the
[sync reference](docs/guides/remnote-cli-command-reference.md#sync).
Writes are sequential, not atomic. Pre/post revision hashes are client optimistic
checks, not native conditional setters; the check-write window remains. Native
transactions stay disabled. On an unknown result, preserve the original
plan/journal and reconcile exact IDs. Explicit `sync resume DIR --plan-hash HASH`
can continue the same outgoing-only plan after proving its complete attempted
prefix by exact-ID readback. It reuses known creation IDs and never replays an
uncertain write. Changed local/remote evidence, an unknown creation without an ID,
or an unproven effect is refused. `sync recover` only finishes verified local
publication. See the reference for the new-card identity evidence boundary.

- [Command reference](docs/guides/remnote-cli-command-reference.md)
- [Development](docs/guides/development-setup.md)
- [Integration testing](docs/guides/integration-testing.md)
- [Troubleshooting](docs/guides/remnote-cli-troubleshooting.md)
- [Changelog](CHANGELOG.md)

MIT License. See [LICENSE](LICENSE).
