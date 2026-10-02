# Preview-First Task Plans

Flashcard and Wiki task composition runs locally in `remnote-cli` using the plugin's SDK gateway.

```bash
remnote-cli flashcards apply --plan /tmp/cards.json --idempotency-key cards-batch-1
remnote-cli wiki apply --plan /tmp/wiki.json --idempotency-key wiki-batch-1
```

The CLI reads the **inner plan** from a UTF-8 JSON file or stdin (`-`), then wraps it as
`{schemaVersion:1,plan,dryRun:true,idempotencyKey}`. `--apply` explicitly sets
`dryRun:false`; preview is the default and performs no writes or persistent journal storage. Preview is not approval
to apply. Obtain normal write authorization; the [CLI skill](../../skills/remnote/SKILL.md) retains `confirm write`.

Neither preview nor apply ever looks up dates or creates daily documents. Task setters recheck the live write gate
immediately before each SDK mutation after awaited reads. This is not a transaction or rollback guarantee.

Both task commands need the Bridge's separate `KnowledgeBaseInfo: Read` permission for current-KB identity and
journal isolation; `All` content access does not include it. Existing installations require explicit permission
approval. A denied identity lookup stops preview/apply before any content write; do not bypass KB isolation.

## Shared bounds and text

- Both envelope and plan require literal `schemaVersion:1`; unknown fields are rejected
- JSON plan maximum: 100 KiB UTF-8; file/stdin input uses the same byte ceiling
- Exact IDs: nonblank strings, at most 256 characters
- Object/patch `key`: 1–64 characters matching `^[A-Za-z0-9._-]+$`, unique across all keyed entries in the plan
- `idempotencyKey`: 1–128 characters with the same pattern
- Titles/questions: nonblank, at most 1000 characters
- Aliases: at most 20 nonblank strings, at most 200 characters each
- `TextSegments`: array of 1–100 entries; each is a string (at most 10000 characters, empty allowed), or exact `{remId}`
- Wiki text additionally accepts exact `{pageKey}` objects, resolving to a page key declared in the same plan
- Flashcard text forbids `pageKey`; mixed/extra reference-object fields are invalid
- `expectedTextHash`: 64 lowercase SHA-256 hex characters, taken unchanged from the target's current raw-text hash

An answer patch has this shape:

```json
{"key":"answer-patch","cardRemId":"card-rem","remId":"answer-rem","expectedTextHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","text":["Correction with ",{"remId":"source-rem"}]}
```

The hash above is illustrative, not a real precondition. It hashes JSON-serialized current raw `text`, not the title,
rendered Markdown, or replacement. `cardRemId` identifies the card Rem and `remId` the precise answer node. A stale
hash is a conflict, not permission to bypass the guard.

## Flashcard inner plan

```json
{"schemaVersion":1,"dailyRemId":"daily-rem","homeRootId":"home-root","tagRemId":"tag-rem","title":"Topic","newCards":[{"key":"card-a","question":"Question?","answer":[["Answer."]]},{"key":"card-b","question":"Source?","answer":[["See ",{"remId":"source-rem"}]]}],"answerPatches":[],"reusedCardRemIds":[]}
```

`dailyRemId`, `homeRootId`, and `tagRemId` are required existing IDs. `newCards`, `answerPatches`,
`reusedCardRemIds`, and `title` are optional. At least one new/patch/reused card is required. `newCards` allows at most
7 entries; each requires `key`, `question`, and 1–100 answer lines, each a TextSegments array. Two or more new cards
require a cluster title. Patches and reused Rem IDs allow at most 100 each. Reuse uses Rem IDs, not native card IDs.

`dailyRemId` must be an explicit existing native `dailyDocument`. Type validation receives no date scalar and cannot
prove calendar freshness. The caller resolves/revalidates the intended calendar date before a new batch and after
midnight. Replay stays on the original recorded diary; never redirect an existing batch to a newly resolved date.

The pinned SDK 0.0.46 represents ordinary Rem type as `undefined`, so its JSON
snapshot can omit `type`. Generated CLI constants preserve that runtime value;
the published declaration alone incorrectly suggests numeric zero. Recheck this
exception on SDK upgrades. Explicit concept, descriptor or portal types still
fail ordinary-node guards; the CLI never retypes them to resume a task.

Conservative IDs/facts budget (omitted arrays count as empty):

`sum(1 + card.answer.length for each newCard) + (newCards.length > 1 ? 1 : 0) + 2 + reusedCardRemIds.length + 2 * answerPatches.length <= 1000`

## Wiki inner plan

```json
{"schemaVersion":1,"wikiRootId":"wiki-root","partitionRemId":"partition-rem","indexRemId":"index-rem","logRemId":"log-rem","pages":[{"key":"page-a","title":"Overview","aliases":["Overview alias"],"nodes":[{"key":"node-a","text":["Details: ",{"pageKey":"page-b"}]}],"summary":["Overview summary"]},{"key":"page-b","title":"Details","nodes":[],"summary":["Details summary"]}],"answerPatches":[]}
```

The four root/partition/index/log IDs and `pages` array are required. `pages` permits 0–10 entries; optional
`answerPatches` permits at most 100. At least one page or patch is required; patch/reference-only plans use `pages:[]`.

Each page requires `key`, `title`, `nodes` (0–100 entries), and `summary` (TextSegments). Optional page `remId` targets
an existing page whose title must match; optional `aliases` follows shared bounds. Each node requires `key` and
`text`. Existing nodes require both `remId` and `expectedTextHash`; new nodes must omit both. No rename, move,
child-list replacement, or deletion is supported. Known-created/recovered Wiki objects must still be ordinary,
plain, untagged non-card text before mutation; prior creation metadata is not enough.

Canonical-name/alias duplicate checks cover the selected partition and current plan. Agent-owned semantic/whole-WIKI
deduplication remains necessary. Existing index entries are searched through the complete bounded entity tree,
including grouped sections, and retain their parent.

Optional page `indexParentRemId` selects the exact index root or one of its existing descendants for that page's
index entry. A selector must agree with an existing entry's parent; it never moves the entry or creates a section.
Without a selector, an existing entry keeps its parent and a new entry goes directly under a structurally flat
index. If the index contains nested entries, a missing/new entry requires an explicit selector before any writes.
For example, add `"indexParentRemId":"EXACT_SECTION_ID"` to the page object after reviewing the section ID.
Foreign/missing targets and parent conflicts fail before writes. Ancestry is rechecked before each index mutation
and the selected parent is included in final proof. These reads are not an atomic snapshot or rollback guarantee;
late external changes can leave a partial batch that must be reconciled using its original key and IDs.
Never flatten, guess a group, or shrink the uniqueness scan. Incomplete bounded traversal is a blocker. Patch/reference-only
and no-op Wiki work does not write a Wiki log; only actual Wiki page/index changes do.

Conservative IDs/facts budget (including patched card and answer pairs):

`2 * pages.length + sum(page.nodes.length) + 1 + 2 * answerPatches.length <= 1000`

## Receipt and exit status

Required fields: `schemaVersion:1`, `kind:flashcards|wiki`, `batchKey`, SHA-256 `planHash`, `status`, `complete`, `ids`,
`facts`, `created`, `updated`, `reused`, `skipped`, `steps`, `checks`, `readWindow:{startedAt,finishedAt}`, and
`errors:[{remId?,code,message}]`.

- `status`: `preview`, `verified`, `partial`, `unknown`, `incomplete`, or `conflict`
- `created`/`updated`/`reused`/`skipped`: arrays of `{key,remId}`
- `steps`: `{key,state,remIds,error?}`; state is `started`, `applied`, `verified`, `unknown`, `conflict`, `failed`, or `incomplete`
- `checks`: `{kind,remId,status:passed|failed|incomplete,expected?,actual?,message?}`
- `ids`: at most 1000 semantic-key → exact Rem ID mappings; use returned keys such as `daily`, `tag`, `root`,
  `card:<key>`, `answer:<key>:<zero-based-index>`, `page:<key>`, `node:<key>`, `index:<pageKey>`, and `log:batch`
- `facts`: at most 1000 `{remId,textHash,cardIds,reviewHash}` records for selected owned/changed/reused Rems; both hashes
  are 64-character lowercase SHA-256. No title/text/native review-history body is included

Facts come from postwrite verification of created trees/pages/answers and exact patched/reused target reads. Use
these observed hashes/card IDs for the next stage without another broad read just to reconstruct the receipt. Never
guess created-ID ordering or invent absent semantic keys. Receipt hashes do not replace semantic final-text review
using selected exact IDs. Keep persistent workflow evidence metadata-only, never KB text/titles/aliases/history.

The CLI emits the complete receipt in JSON and text modes before exit. Zero requires `complete:true`, no errors,
and `status:preview` for preview or `status:verified` for apply. All other outcomes are non-success. Applied steps
alone are not a verified batch. A transport failure can occur before a receipt is returned.

Each SDK call has a 15-second default deadline, with no task timeout input field. Interrupted applies
may have changed data. Preserve the exact reviewed plan and stable key, inspect current receipts/IDs, and reconcile
known outcomes before another authorized action. Unknown creation outcomes are never blindly replayed. Do not
change a plan under its key or generate a new key to bypass partial/unknown/conflict. Private metadata-only idempotency journals live beside the CLI pairing file under
`state/<KB hash>/`; they are durable before writes and are not transactional rollback. Required whole-WIKI/full-card proof scopes stay intact; report incomplete if blocked.
