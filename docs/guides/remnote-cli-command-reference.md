# remnote-cli Command Reference

`remnote-cli` is automation-first: JSON is the default output mode. Use `--text` for human-readable output.

## Invocation

```bash
remnote-cli [global-options] <domain> <action> [command-options]
```

Live commands require RemNote open with the protocol 2 RemNote CLI Bridge enabled.
A live command owns a short-lived loopback connection. No daemon or MCP endpoint is used.
No pairing or initialization command is required. The CLI uses the Bridge's active
knowledge base. See [configuration](configuration.md) for permissions and state paths.

### Native Transaction Restriction

SDK 0.0.46 cannot safely abort a native transaction. Metadata-only `rem update`, `rem children
replace`, and `rem property set` fail before mutation. Native TODO status changes
use their single SDK setter and exact readback, without an outer transaction.
`rem update --content` and `rem update-answer` also use one text setter and exact
readback without an outer transaction. These content updates are not atomic.
`rem create`, `journal append` and `rem children insert` perform sequential additive writes with
private recovery journals, not atomic transactions. A failure can leave partial
content: retain the reported key/IDs and read back before retrying. Use the task
commands for stable-key replay. See [ADR 0003](../adr/0003-disable-unsafe-native-transactions.md).

## Global Options

| Flag              | Default                         | Description                         |
| ----------------- | ------------------------------- | ----------------------------------- |
| `--json`          | enabled                         | JSON output mode                    |
| `--text`          | off                             | Human-readable output mode          |
| `--verbose` | off | Emit connection and SDK timings to stderr |
| `--version`       | n/a                             | Show CLI version                    |
| `--help`          | n/a                             | Show help                           |

Live leaf commands also expose `--kb-id <id>` to require an exact active
knowledge base. Destructive leaves expose `--allow-destructive`. These options
are scoped to the leaf and must appear after its path.

### Output mode rules

- JSON is the default when no output flag is provided.
- If both `--json` and `--text` are passed, `--text` wins.
- JSON success is written to stdout as `{schemaVersion:2,ok:true,data}`.
- JSON failure is written to stderr as `{schemaVersion:2,ok:false,error}`.
- Text output is human-readable and removes ANSI and terminal control characters.
- `--verbose` diagnostics use stderr only and never corrupt JSON stdout.

See [Output and errors](output-and-errors.md) for the error types and batch
behavior.

## Offline discovery

Use `contract` for protocol and plan contracts. Use `schema` for command
arguments, options, defaults, risk and Bridge requirements.

```bash
remnote-cli contract
remnote-cli schema
remnote-cli schema rem.search
remnote-cli schema rem.powerup.get
```

See [Command schema](command-schema.md).

## Doctor

`doctor` is a read-only diagnostic for the CLI and its live Bridge.

```bash
remnote-cli doctor
remnote-cli doctor --offline
remnote-cli doctor --text
```

`--offline` checks Node, command policy and local state without opening a socket.
Warnings and skips do not fail the command. Any failing check returns exit code
3 with the complete report in `error.details`. See [Doctor](doctor.md).

## Pagination

`rem search`, `rem search-by-tag` and single-parent `rem children list` accept:

| Flag | Meaning |
| --- | --- |
| `--all` | Follow every page from the current cursor snapshot |
| `--max-pages <n>` | Explicit page bound for `--all`; requires `--all` |
| `--page-delay <ms>` | Delay between page requests |

The result always includes `paging: {complete,pages,itemCount,nextCursor?}`.
At `--max-pages`, an unfinished result keeps `hasMore=true` and its
`nextCursor`. Missing or repeated cursors fail as conflicts. Several-parent
`rem children list` keeps its raw multi-result shape because independent parent cursors
cannot be merged. See [Pagination](pagination.md).

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
| `1` | Internal failure |
| `2` | Invalid command or input |
| `3` | Configuration or connection unavailable |
| `4` | Missing target or state conflict |
| `5` | Write outcome unknown; reconcile before retrying |
| `6` | Unsupported capability |

## rem create

Create a new RemNote note or a hierarchical tree.

```bash
remnote-cli rem create [title] [options]
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
remnote-cli rem create "Meeting Notes"
remnote-cli rem create --title "Meeting Notes"

# Create a new note under a specific parent rem id
remnote-cli rem create --title "Meeting Notes" --parent-id <parent-rem-id>

# Create a new note with title, content, and exact tag Rem IDs
remnote-cli rem create --title "Project Plan" --content "Phase 1" --tag-ids <tag-rem-id>

# Create content that links to an existing Rem by exact ID
remnote-cli rem create --title "Compound" --content "Component [[id:<component-rem-id>]]"

# Create a title/root Rem as a document
remnote-cli rem create --title "Project Plan" --content "Phase 1" --as-document

# Create real aliases on the title/root Rem
remnote-cli rem create --title "The Shop on Main Street" --aliases "Obchod na korze"

# Create a new note with markdown content directly under parent rem id
# Note: if the content is in markdown format, --content/--content-file must be used to avoid misinterpretation of the content as command options
remnote-cli rem create --content "- Item 1\n  - Item 2" --parent-id <parent-rem-id>

# Flashcards
remnote-cli rem create --title "Photosynthesis" --content "Front :: Back"

# Hierarchical tree from file or from parsed markdown
remnote-cli rem create --title "Biology Terms" --content-file /tmp/biology.md
remnote-cli rem create --title "Biology Terms" --content "# Terms 1\n- Item 1\n  - Item 2"
```

## rem search

Search notes by text query.

```bash
remnote-cli rem search <query> [options]
```

Shared options for `rem search` and `rem search-by-tag`:

| Option                     | Default | Description                          |
| -------------------------- | ------- | ------------------------------------ |
| `-l, --limit <n>`          | `50`    | Maximum number of results            |
| `--content-mode <mode>`    | `none`  | `none`, `markdown`, or `structured`  |
| `--view <view>`            | default | `compact`, `standard`, or `full`     |
| `--ancestor-depth <n>`     | `0`     | Parent Rems to include, parent-first |
| `--depth <n>`              | `1`     | Child depth for rendered content     |
| `--child-limit <n>`        | `20`    | Max children per hierarchy level     |
| `--max-content-length <n>` | `3000`  | Max rendered content character count |

`rem search` also supports:

| Option              | Default | Description                                      |
| ------------------- | ------- | ------------------------------------------------ |
| `--parent-id <id>`  | none    | Non-empty parent Rem ID to scope search within its subtree |
| `--cursor <cursor>` | n/a     | Opaque cursor from a previous `rem search` response  |
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
remnote-cli rem search "meeting"
remnote-cli rem search "weekly" --limit 10 --content-mode structured --depth 2 --child-limit 10 --text
remnote-cli rem search "weekly" --limit 10 --cursor "search:v1:..."
remnote-cli rem search "meeting" --limit 10 --parent-id <parent-rem-id>
remnote-cli rem search "meeting" --limit 10 --parent-id <parent-rem-id> --cursor "search:v1:..."
remnote-cli rem search "TQQQ" --cards-only --include-review-stats --view full
```

## rem search-by-tag

Search notes by exact tag Rem ID (ancestor-context aware).

```bash
remnote-cli rem search-by-tag --tag-id <tag-rem-id> [options]
```

Options and output/content controls are identical to `rem search`
(`-l/--limit`, `--content-mode`, `--view`, `--ancestor-depth`, `--depth`, `--child-limit`,
`--max-content-length`).
Use `--result-mode tagged` to return directly tagged Rems instead of the default ancestor-context results.
Use `--cursor <cursor>` to continue a previous search-by-tag page. SDK calls use a fixed
15-second default deadline; the former `--timeout-ms` transport option is not accepted.

`--tag-id` is the exact Rem ID of the tag Rem. Tag names, `#name` inputs, and aliases are not accepted; exact IDs avoid
ambiguity from duplicate names, renamed tags, and aliases.

Examples:

```bash
remnote-cli rem search-by-tag --tag-id <tag-rem-id>
remnote-cli rem search-by-tag --tag-id <tag-rem-id> --result-mode tagged
remnote-cli rem search-by-tag --tag-id <tag-rem-id> --limit 10 --cursor "search_by_tag:v1:..."
remnote-cli rem search-by-tag --tag-id <tag-rem-id> --content-mode markdown --depth 2 --text
```

## rem read

Read one or more notes by Rem ID.

```bash
remnote-cli rem read <rem-id> [more-rem-ids...] [options]
```

| Option                     | Default    | Description                          |
| -------------------------- | ---------- | ------------------------------------ |
| `-d, --depth <n>`          | `5`        | Child depth to render                |
| `--content-mode <mode>`    | `markdown` | `markdown`, `structured`, or `none`  |
| `--view <view>`            | default    | `compact`, `standard`, or `full`     |
| `--ancestor-depth <n>`     | `0`        | Parent Rems to include, parent-first |
| `--child-limit <n>`        | `100`      | Max children per hierarchy level     |
| `--max-content-length <n>` | `100000`   | Max rendered content character count |
| `--include-media-metadata` | false      | Include root image IDs for `media get` |

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
remnote-cli rem read abc123def
remnote-cli rem read abc123def def456 --content-mode none
remnote-cli rem read abc123def --content-mode none --depth 2 --child-limit 30 --max-content-length 5000 --text
remnote-cli rem read abc123def --content-mode structured --depth 2 --child-limit 30
```

## rem inspect

Read generic Rem state as JSON. One command uses one bridge session. Requested IDs are loaded
with `findMany`; descendants, tags, and ancestors use further batches in that same session.

```bash
remnote-cli rem inspect <rem-id...> [options]
remnote-cli rem inspect --from-file ids.txt --descendants 1 --expect rules.json --strict
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
`parent`, `children`, `aliases`, `sources`, `portal`, `rawCards`, `isDocument`, `isFolder`,
`isTable`, `isProperty`, `isPowerup`, `isPowerupSlot`, `isPowerupProperty`,
`isPowerupEnum`, `isPowerupPropertyListItem`.

`elements.text` and `elements.backText` each have `counts` and `items`. A code block is a
rich-text element with `code: true` and an optional `language`. `rem.isCode` is a different
flag and is false for a code element inside text, so inspect does not use it. Literal `[[`
occurrences are counted separately from rem-reference elements. One element can contribute
several items (a code span can also be bold and a cloze).

`tags[]` and `parent` are root-first `{id,name,type}` chains. `tags[].ancestors` does not
include the tag itself. `cards[]` has `id`, `type`, `due`, `nextRepetition` (the same
timestamp), `historyLength`, and `hash`. The hash covers card id, rem id, type, and
repetition history, so a due-date-only change does not change it.

`rawCards[]` has `id`, `remId`, `type`, `createdAt`, `repetitionHistory`,
`nextRepetitionTime`, `lastRepetitionTime`, and `timesWrongInRow`. Unavailable facts
are `null`. Request `--fields cards,rawCards` to read the same review facts protected
by content updates. `cards[].hash` is not a Rem text hash.

`portal` is present for a portal Rem or a Rem carrying powerup `sp`. `query` is slot `q`
and `filter` is slot `f` (search-portal queries and table filters). A recognized
`getPortalType` code sets `portalType`. Any other value is unclassified (`portalType: null`)
and kept in `portalTypeRaw`; that is not a read error. Other Rems have `portal: null`.
When `complete` is false, top-level `errors` lists the reason, including each Rem field
error as `{id, field, message}`.

Rule failures are included as `assertions` and do not change the exit code unless `--strict`.
Usage and connection errors still exit 1. See [state verification](state-verification.md).

## rem assert

Evaluate the same generic rules against a live inspect or a saved inspect file.

```bash
remnote-cli rem assert --file rules.json --strict
remnote-cli rem assert --file rules.json --against inspect.json
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

## rem powerup get

Read one powerup slot by code. Read-only.

```bash
remnote-cli rem powerup get --rem REM_ID --powerup sp --slot f
remnote-cli rem powerup get --rem REM_ID --powerup sp --slot q --as richtext
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

## card review-stats

Read native RemNote review facts from exactly one scope:

```bash
remnote-cli card review-stats <rem-id> [more-rem-ids...]
remnote-cli card review-stats --today
remnote-cli card review-stats --root-id <root-rem-id>
remnote-cli card review-stats --tag-id <tag-rem-id>
```

JSON output preserves the raw card type, creation timestamp, repetition history, last and next repetition timestamps,
and consecutive wrong count. Text output provides a compact summary. The command does not calculate mastery or change
the review schedule.

## rem outline

Preview or update folding for every non-leaf Rem below one root Rem:

```bash
remnote-cli rem outline collapse --today
remnote-cli rem outline collapse --today --apply
remnote-cli rem outline collapse --root-id <root-rem-id> --apply
remnote-cli rem outline expand --root-id <root-rem-id> --apply
```

The command defaults to preview mode. `--apply` requires Bridge writes to be enabled and verifies each changed Rem in
its actual display context. Nested Document content uses that Document, Portal content uses the Portal Rem ID, and the
selected root itself is not changed.

## todo

List native RemNote TODOs and change their native status:

```bash
remnote-cli todo list --root-id <root-rem-id>
remnote-cli todo list --root-id <root-rem-id> --status finished
remnote-cli todo list --root-id <root-rem-id> --status all
remnote-cli todo complete <rem-id>
remnote-cli todo complete <rem-id> --apply
remnote-cli todo reopen <rem-id> --apply
```

`list` scans one required exact root Rem and its descendants. It returns Rems
where native `isTodo()` is true and defaults to `Unfinished`.
`complete` and `reopen` preview by default. Apply calls `setTodoStatus()` on
the exact native TODO and reads the status back. TODO tags and TODO text do not
identify or change these Rems.

## SDK commands

The Plugin SDK is available through one first-level `sdk` command. Its second level
contains capability discovery, a raw capability escape hatch and 19 SDK namespaces.
The CLI derives navigation from the versioned SDK facts shipped with its build, so
group and method help works while RemNote is closed:

```text
capabilities  app        card       date       editor
event         focus      kb         messaging  powerup
queue         reader     rem        rich-text   scheduler
search        settings   storage    widget      window
```

Use `sdk capabilities` to search the full inventory. Running a namespace without a method lists that namespace's
commands; adding `--help` to a method prints its SDK signature, mode, target requirements, unsupported reason, and
example. Live capability state is checked again before execution.

```bash
remnote-cli sdk --help
remnote-cli sdk capabilities --status supported --mode read --text
remnote-cli sdk rem
remnote-cli sdk rem object-collapse --help
remnote-cli sdk app get-platform --args-json '[]'
remnote-cli sdk rem object-collapse --target-id REM_ID --args-json '["PORTAL_ID"]'
remnote-cli sdk messaging broadcast --args-file ./args.json
remnote-cli sdk call rem:getChildrenRem --target-id REM_ID --args-json '[]'
```

- Positional SDK arguments come from either `--args-json` or `--args-file`, never both.
- Argument files/stdin are UTF-8 and capped at 100 KB; CLI input validation also limits calls to 100 JSON arguments.
- RemObject and Card methods require `--target-id`.
- Prefer friendly commands when they cover the workflow.
- Use `sdk call <capability-id>` when a live Bridge exposes a supported method
  before the local generated navigation has been updated. It still requires the
  exact live capability, live catalog hash, target ID where required, support
  status and destructive approval.
- Use `--allow-destructive` only after explicit user intent and only for a command whose help reports
  `Mode: destructive`.
- Callback, event-listener, scheduler, Widget registration, and stateful RichTextBuilder operations remain
  discoverable but report `unsupported` because they cannot cross a one-shot JSON command boundary. Supported rich-text factories return the result of native `value()` in one call.

## media get

Save one RemNote-managed image to a local file:

```bash
remnote-cli media get <rem-id> --field <text|backText> --media-id <id> --output <path>
```

Discover the required IDs with `remnote-cli rem read <rem-id> --include-media-metadata`. Existing destinations are
protected; pass `--force` only when overwriting is intentional. `--max-inline-bytes` can lower or raise the per-call
limit up to the CLI's 10 MiB hard maximum. JSON/text output reports metadata and the absolute saved path, never the
base64 payload.

## table read

Read one Advanced Table by exact title or Rem ID.

```bash
remnote-cli table read (--title <title> | --rem-id <id>) [options]
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
remnote-cli table read --title "Projects"
remnote-cli table read --rem-id abc123def --limit 10
remnote-cli table read --title "Projects" --properties "Status,Owner" --text
```

## rem update

Update note metadata or replace only its own text. Children are preserved.

```bash
remnote-cli rem update <rem-id> [options]
```

| Option                       | Default | Description                                                  |
| ---------------------------- | ------- | ------------------------------------------------------------ |
| `--title <text>`             | none    | Replace title/headline; supports `[[id:<remId>]]`             |
| `--content <text\|->`        | none    | Replace own text with Markdown/native references; `-` reads UTF-8 stdin |
| `--expected-text-hash <sha256>` | none | Required with content; SHA-256 of current raw rich text, 64 lowercase hex characters |
| `--add-aliases <text...>`    | none    | Add real aliases if not already present                       |
| `--remove-aliases <text...>` | none    | Remove aliases by exact whitespace-normalized, case-sensitive match |

At least one update option is required. Alias additions/removals are idempotent, and the same normalized alias cannot
be requested in both operations.

`--title` and `--content` are mutually exclusive. `--expected-text-hash` is valid
only with `--content`. Obtain the target's `textHash` through `rem context --request`
with that Rem in `remIds`. Hash the raw rich text, not the rendered title or Markdown.

Content updates compare that hash before writing, parse Markdown and native
`[[id:<remId>]]` references as `rem create` does, call the text setter once, and
read back exact raw text, parent, children, and card-item status. If the target is
a card or a card-item answer, they also preserve CardIDs, creation time, scheduling,
and available review history. Missing history remains `null` in `rawCards`.

The success receipt has `status: "verified"`, `remId`, optional `cardRemId`,
`parentRemId`, `beforeTextHash`, `textHash`, `isCardItem`, `childrenRemIds`,
`cardIds`, `rawCards`, and `verification`. It also keeps the existing `titles` and
`remIds` fields. A pre-write conflict makes no write. A write or readback failure
reports `unknown_outcome` with exact IDs. It never retries or rolls back the setter.
Inspect before another write. Native compare-and-swap and transactions are unavailable.

Use the dedicated commands below for child content and tag writes.

Examples:

```bash
remnote-cli rem update abc123def --title "Updated Title"
remnote-cli rem update abc123def --title "See also [[id:<target-rem-id>]]"
remnote-cli rem update abc123def --add-aliases "Original Title" --remove-aliases "Old Title"
remnote-cli rem update QUESTION_REM_ID --content "New question" --expected-text-hash CURRENT_RAW_TEXT_HASH
```

## rem update-answer

Replace an existing card-item answer's own text and preserve its card facts.

```bash
remnote-cli rem update-answer <answer-rem-id> --card-id <card-rem-id> --content <text|-> --expected-text-hash <sha256>
```

All three options are required. `--card-id` is the exact card-generating parent Rem
ID, not a generated CardID. The answer must be its direct child, already be a
card-item, and the parent must generate at least one card. No card is created or
converted. `--content -` reads UTF-8 stdin. Content uses the same Markdown and
`[[id:<remId>]]` conventions as `rem create`.

Hash validation, write/readback checks, receipt facts, and unknown-outcome handling
match `rem update --content`. `rem inspect --fields cards,rawCards` reads the
protected CardIDs, types, creation time, scheduling, and available history.
`card apply` retains its existing plan and replay behavior during migration.

## rem document status

Preview or set document status on an existing Rem. The command is a dry-run unless `--apply` is provided. Concept/card
status is preserved.

```bash
remnote-cli rem document status <rem-id> --document
remnote-cli rem document status <rem-id> --document --expected-old-rem-type concept --apply
remnote-cli rem document status <rem-id> --no-document --apply
```

| Option                          | Default | Description                                                   |
| ------------------------------- | ------- | ------------------------------------------------------------- |
| `--document`                    | none    | Mark the Rem as a document                                    |
| `--no-document`                 | none    | Remove document status from the Rem                           |
| `--apply`                       | false   | Perform the change instead of dry-run preview                 |
| `--expected-old-rem-type <type>` | none    | Reject stale context before changing document status          |

Accepted `--expected-old-rem-type` values: `folder`, `document`, `dailyDocument`, `concept`, `descriptor`, `portal`, `text`.

## rem children list

List direct children under one or more parents without rendering a whole subtree.

```bash
remnote-cli rem children list <parent-rem-id> [more-parent-ids...] --limit 50 --ancestor-depth 1
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
remnote-cli rem children list parent-a parent-b --limit 50
```

## rem children insert

Insert child Rems under a parent at an explicit position.

Newly created non-leaf Rems are collapsed automatically in their nearest containing Document, daily note, or Portal.

```bash
remnote-cli rem children insert <parent-rem-id> --content <text> --position <first|last|before|after>
```

| Option                    | Default | Description                                      |
| ------------------------- | ------- | ------------------------------------------------ |
| `--content <text>`        | none    | Content to insert                                |
| `--content-file <path>`   | none    | Read inserted content from UTF-8 file (`-` stdin) |
| `--position <position>`   | none    | `first`, `last`, `before`, or `after`             |
| `--sibling-rem-id <id>`   | none    | Required for `before` and `after`                 |

Examples:

```bash
remnote-cli rem children insert cEZH8DJYED3RQIB7k --content "description: Use for Codex app/CLI/skills/ExecPlans notes." --position first
remnote-cli rem children insert cEZH8DJYED3RQIB7k --content "Related [[id:<target-rem-id>]]" --position last
remnote-cli rem children insert cEZH8DJYED3RQIB7k --content-file /tmp/child.md --position before --sibling-rem-id abc123def
```

## rem delete

Preview or permanently delete one exact Rem and all descendants.

```bash
remnote-cli rem delete <rem-id>
remnote-cli rem delete <rem-id> --apply --expected-title "Exact title" --allow-destructive
```

Preview returns the current title. Apply requires that exact title, explicit
destructive authorization and a successful absence readback. The durable journal
records the exact target. An uncertain response is `unknown_outcome`; read the ID
before trying again.

## rem move

Move an existing Rem and its subtree under a new parent. The command is a dry-run unless `--apply` is provided.

```bash
remnote-cli rem move <rem-id> --new-parent-rem-id <parent-rem-id>
remnote-cli rem move <rem-id> --new-parent-rem-id <parent-rem-id> --expected-old-parent-rem-id <old-parent-rem-id> --apply
```

| Option                         | Default | Description                                  |
| ------------------------------ | ------- | -------------------------------------------- |
| `--new-parent-rem-id <id>`     | none    | New parent Rem ID                            |
| `--position <position>`        | `last`  | `first`, `last`, `before`, or `after`        |
| `--sibling-rem-id <id>`        | none    | Required for `before` and `after`            |
| `--apply`                      | false   | Perform the move instead of dry-run preview  |
| `--expected-old-parent-rem-id` | none    | Reject stale parent context before moving    |
| `--ancestor-depth <n>`         | `0`     | Parent Rems to include before/after the move |

## rem children replace

Replace all direct content child Rems under a parent while preserving parent identity, title, aliases, document status,
tags, and properties. This is destructive for existing content-child Rem IDs and can be blocked by bridge policy.

```bash
remnote-cli rem children replace <parent-rem-id> --content-file <path> --allow-destructive
```

| Option                  | Default | Description                                                                      |
| ----------------------- | ------- | -------------------------------------------------------------------------------- |
| `--content <text>`      | none    | Replacement content                                                              |
| `--content-file <path>` | none    | Read replacement content from UTF-8 file (`-` stdin; empty file clears content children) |

Replacement content supports `[[id:<remId>]]` for exact inline references to existing Rems.
Newly created non-leaf replacement Rems are collapsed automatically in their nearest containing Document, daily note,
or Portal.

## rem tags update

Add or remove tags by exact tag Rem ID. Removing tags requires `--allow-destructive`.

```bash
remnote-cli rem tags update <rem-id> --add-tag-ids <tag-rem-id...>
```

| Option                          | Default | Description              |
| ------------------------------- | ------- | ------------------------ |
| `--add-tag-ids <tag-rem-id...>`    | none    | Exact tag Rem IDs to add |
| `--remove-tag-ids <tag-rem-id...>` | none    | Exact tag Rem IDs to remove |

Use exact IDs for production tagging workflows. Name-based tag mutation is intentionally not exposed.
The CLI checks destructive authorization before it adds or removes any tag.

## rem property set

Set or clear a tag/table property value by exact IDs.

```bash
remnote-cli rem property set <rem-id> --tag-id <tag-rem-id> --property-id <property-rem-id> (--value <text> | --rem-reference-id <id> | --clear)
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
remnote-cli rem property set abc123def --tag-id tag123 --property-id prop123 --value "People" --text
remnote-cli rem property set abc123def --tag-id tag123 --property-id prop123 --value "See [[id:<target-rem-id>]]" --text
remnote-cli rem property set abc123def --tag-id tag123 --property-id prop123 --rem-reference-id option123 --text
remnote-cli rem property set abc123def --tag-id tag123 --property-id prop123 --clear --text
```

## journal append

Append to today's daily document.

```bash
remnote-cli journal append [content] [options]
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
remnote-cli journal append "Finished sprint review"
remnote-cli journal append --content "Quick thought" --no-timestamp --tag-ids <tag-rem-id> --text
remnote-cli journal append --content-file /tmp/entry.md --text
cat /tmp/entry.md | remnote-cli journal append --content-file - --text
```

## batch

Run several commands on one loopback connection. Use this instead of starting a process per command when those
processes would otherwise hit `CLI port occupied`.

```bash
remnote-cli batch --file commands.jsonl
remnote-cli batch --file commands.json --stop-on-error
cat commands.jsonl | remnote-cli batch --file -
```

Input is a JSON array of `{"argv":["rem","read","REM_ID"]}`, a `{"commands":[...]}` object, one such object, or JSONL with
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
{"schemaVersion":1,"count":2,"ok":true,"stoppedEarly":false,"results":[{"index":0,"argv":["rem","read","REM_ID"],"ok":true,"exitCode":0,"result":{}}]}
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

## contract

Print the offline machine-readable protocol, plan schemas, required SDK capabilities,
receipt statuses, and exit codes. This command never
opens a Bridge session and succeeds while RemNote is closed.

```bash
remnote-cli contract
remnote-cli contract --schema flashcards
```

The committed generated artifact is
[`cli-contract.generated.json`](cli-contract.generated.json).

## Task Composites (schemaVersion=1)

| CLI | Local business action |
|-----|-----------------------|
| `rem context --request <path or ->` | `inspectMany` |
| `rem verify scope --expect <path or -> [--summary]` | `verifyScope` |
| `card apply --plan <path or -> --idempotency-key KEY [--apply] [--summary]` | `applyFlashcards` |

[Read receipts](read-receipts.md) documents every selector/check/receipt field and [task plans](task-plans.md) every
inner plan, bound, text segment and apply receipt. Flashcard `cardCluster` defaults off; `cc` is added only when the
plan sets it to `true` with a title and at least two new cards. Optional `parentRemId` appends new cards, untagged,
to an existing tagged topic Rem directly under the daily document; it forbids `title`. Optional `tags`
(`{"root":[...],"card:<key>":[...]}`) replaces `homeRootId`/`tagRemId`: every created Rem gets exactly its declared
tag IDs, verified in the receipt, and `parentRemId` no longer requires a tag on the topic. Flashcard questions accept a plain string or
`TextSegments`; native references use `{"remId":"EXACT_ID"}`, and plain strings containing `[[` or `]]` are rejected.
Flashcard plans that contain only `answerPatches` or `reusedCardRemIds` omit `dailyRemId`, `homeRootId`, `tagRemId`,
`parentRemId`, `title`, `cardCluster`, and `tags`; exact existing targets replace creation context.
Flashcard task plans have no artificial object-count or task-file-size cap.
Scaffold creation is partitioned internally, and SDK requests beyond the live
in-flight window wait rather than failing.
A flashcard answer line may be one code-block segment `{"code":"...","language":"plaintext"}`. Apply stores the SDK
code-block element and sets `isCardItem` so the line is on the card back. Applied receipts include `answerLines`
with `verified`. New cards and flashcard patches compare card facts before the text write and again after
`setIsCardItem`. A mismatch sets that line's `verified` to false and `error` to
`Card identity or history changed while writing an answer line`, and the receipt is not `verified`.
Patching that line back to plain text leaves `isCardItem` true.
Leaf `--help` includes examples and schemas for
installed agents.
Read input is the whole request; apply files contain only the inner plan. Preview is default. Full receipts precede
nonzero exits on failed/incomplete reads or nonverified apply. Required full-card proof scopes must not be narrowed
merely to pass. Raw context title/text/backText/aliases are limited to explicit remIds; task ids/facts contain metadata.

`--summary` keeps status, IDs/hashes, scopes, counts, and failures without content or
history bodies. It also omits passing check detail. Exit semantics are unchanged.

Preview/apply never look up dates or create daily documents. Native dailyDocument type does not prove calendar
freshness without a date scalar. The caller revalidates the intended date before
new batches and after midnight. Replay keeps the original diary. The active KB and
official authorization are rechecked immediately before each SDK mutation after
awaited reads.

SDK discovery fetches and verifies the live catalog once per command. Calls carry the
expected catalog hash and fail on drift. There is no persistent metadata cache or offline
fallback. Task journals and ID-only paging snapshots are private CLI state scoped to the KB.
