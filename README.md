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
0.25.0 is compatible. Product versions do not need to match; protocol 1 and the
SDK catalog do.

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

The sync design supports editing in both a private Markdown + native-YAML vault
and RemNote, including card edits during review. Users in Obsidian and agents
edit the same local files. A shared baseline supports per-Rem semantic three-way
merging without whole-file last-write-wins. Keep
content outside code Git, optionally in a separate local-only Git repository
without a network remote. Sync does not configure Git or upload content to a remote.

```bash
remnote-cli --kb-id KB_ID sync import /PRIVATE/vault --root-id ROOT_ID
remnote-cli sync status /PRIVATE/vault
remnote-cli sync lint /PRIVATE/vault
remnote-cli sync diff /PRIVATE/vault
remnote-cli sync /PRIVATE/vault
remnote-cli sync /PRIVATE/vault --apply --plan-hash PREVIEW_HASH
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

The current candidate implements preview/apply with `incoming`, `outgoing`,
`converged` and conflict receipts; native acceptance is separate. There is no
trustworthy local per-Rem edit clock, so divergent same-content edits currently
preserve both versions as `untrusted-edit-order` instead of guessing a winner.
This includes independent front/back edits to the same basic card: the current
merge unit is a whole Rem, not individual fields.
Legacy `pull`/`push` aliases are removed. Continuous discovery is limited to bound
IDs (`discoveryScope: "bound-ids"`, `globalDiscoveryComplete: false`), read in
batches of at most 50. Unknown children, missing Rems and reparenting fail or
conflict; new top-level roots are not discovered by this scope. An initial archive
import does not prove continuous whole-library coverage.

Ordinary nested Markdown lists use stable Obsidian block IDs, mapped explicitly to
Rem IDs in YAML for every node. Full-path wikilinks can identify a file root or an
exact block. Renames preserve native identity; unresolved links, ambiguous links
and invalid native metadata fail lint before any remote write. Edit nested YAML
in Obsidian Source mode, not the Properties GUI. Display aliases/tags do not
replace native Rem ID relationships; embeds are not native references or Portals.
Existing unsupported structures, including native Portals, remain lossless and
read-only. Mapping a property is not proof that it is writable.

Keep the vault root 0700; Obsidian-saved Markdown may be 0644, CLI-created Markdown
is 0600, and private sidecars/state remain 0600. Exclude `.obsidian/`, `.trash/`
and `.DS_Store` from content scans, frozen plans and Git; also ignore `.sync/`,
locks and credentials in Git. Existing Rem/card IDs, parent/order and review
history are protected; file removal is not a delete or move instruction. For
native syntax, explicit deletion and recovery, see the
[sync reference](docs/guides/remnote-cli-command-reference.md#sync).
Writes are sequential, not atomic. Pre/post revision hashes are client optimistic
checks, not native conditional setters; the check-write window remains. Native
transactions stay disabled. On an unknown result, preserve the original
plan/journal and reconcile exact IDs; `sync recover` finishes verified local
publication, never retries remote writes.

- [Command reference](docs/guides/remnote-cli-command-reference.md)
- [Development](docs/guides/development-setup.md)
- [Integration testing](docs/guides/integration-testing.md)
- [Troubleshooting](docs/guides/remnote-cli-troubleshooting.md)
- [Changelog](CHANGELOG.md)

MIT License. See [LICENSE](LICENSE).
