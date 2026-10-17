# State verification

`inspect` and `assert` check Rem state from JSON. They are generic: rules name paths and
comparisons, not a flashcard checklist. `context` and `verify scope` remain the bounded
task-receipt tools.

Offline unit tests cover the element summary, field filtering, and rule results. A live
RemNote session is still required to prove a portal query, a table filter, or a card hash
against the real knowledge base. These commands do not read RemNote's local database.

## Code-block answer line

A code block stored on an answer is one rich-text element `{i:"m", code:true, language, text}`
on `backText`. Detect it from that element. `rem.isCode` stays false for this shape.

```bash
remnote-cli inspect ANSWER_ID --fields elements,backText,markdown,isCardItem,hasCardStructure
```

```json
{
  "schemaVersion": 1,
  "rules": [
    {
      "id": "python-answer",
      "path": "rems[0].elements.backText.items",
      "op": "count",
      "match": { "kind": "code", "language": "python" },
      "expect": 1
    },
    {
      "id": "answer-line",
      "path": "rems[0].backMarkdown",
      "op": "contains",
      "expect": "return 1"
    },
    {
      "id": "no-literal-brackets",
      "path": "rems[0].markdown",
      "op": "notContains",
      "expect": "[["
    }
  ]
}
```

`notContains` is literal text. A missing path fails; it is not treated as "does not contain".

## Tag ancestry

`tags[].ancestors` is root-first and does not include the tag. Each node has `id`, `name`,
and `type`.

```json
{
  "id": "tag-path",
  "path": "rems[0].tags[0].ancestors",
  "op": "any",
  "expect": { "name": "Projects", "type": "document" }
}
```

`all` requires every item to match and fails on an empty list. `any` and `none` are the
other collection checks. `match` filters before `count`, `all`, `any`, and `none`.

`[*]` maps every element. One rule can cover every loaded Rem:

```json
{
  "id": "every-card-item",
  "path": "rems[*].isCardItem",
  "op": "all",
  "expect": true
}
```

`rems[*].tags[*].name` flattens one nested array. Child ids stay strings, so check a child
Rem through `rems`, not through `children[*].isCardItem`.

## Portal presence

Search portals and tables that carry powerup `sp` expose `portal`. `query` is slot `q`.
`filter` is slot `f`. An unrecognized `getPortalType` value stays in `portalTypeRaw` with
`portalType: null` and does not mark the read incomplete.

```bash
remnote-cli inspect PORTAL_ID --fields portal
remnote-cli powerup get --rem PORTAL_ID --powerup sp --slot q
remnote-cli powerup get --rem PORTAL_ID --powerup sp --slot f
```

```json
{
  "id": "search-portal",
  "path": "rems[0].portal.portalType",
  "op": "equals",
  "expect": "searchPortal"
}
```

```json
{
  "id": "includes-row",
  "path": "rems[0].portal.includedIds",
  "op": "contains",
  "expect": "ROW_ID"
}
```

The CLI maps `q` to `Query` and `f` to `Filter` before `getPowerupProperty`. The plugin
passes that name through. `getPowerupByCode("sp")` can return undefined. The slot value
lives on the portal Rem, not on a separate powerup Rem lookup.

`assert` prints `{ok, complete, errors, rules}`. `ok` is false when `complete` is false or
`errors` is non-empty, including a field error on a Rem, even if every rule passes.
`--strict` then exits 1.

## Card unchanged

`cards[].hash` is a SHA-256 of card id, rem id, type, and repetition history. `due` and
`nextRepetition` are the same timestamp and are not part of the hash.

Save the hash, do the other work, then compare:

```bash
remnote-cli inspect CARD_REM --fields cards > before.json
# read cards[0].hash into card.hash, then later:
remnote-cli assert --file unchanged.json --strict
```

```json
{
  "schemaVersion": 1,
  "remIds": ["CARD_REM"],
  "fields": ["cards"],
  "rules": [
    {
      "id": "card-unchanged",
      "path": "rems[0].cards[0].hash",
      "op": "hashEquals",
      "baseline": "card.hash"
    }
  ]
}
```

`hashEquals` compares the selected string to the file. One trailing newline is removed.
`--strict` is what makes a mismatch exit 1. Without it the JSON still reports
`status: "fail"`, `actual`, and `expected`, and the process exits 0.

`inspect --expect rules.json` runs the read and the rules in one session. `assert --against
inspect.json` evaluates a saved document and does not open the bridge.
