# remnote-cli Command Reference

`remnote-cli` is automation-first: JSON is the default output mode. Use `--text` for human-readable output.

## Invocation

```bash
remnote-cli [global-options] <command> [command-options]
```

Commands require RemNote open with the authenticated RemNote CLI Bridge enabled. Each command
owns a short-lived loopback connection; no daemon or MCP endpoint is used.
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
plan sets it to `true` with a title and at least two new cards. Flashcard questions accept a plain string or
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
