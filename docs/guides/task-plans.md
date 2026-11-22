# Preview-First Task Plans

Flashcard task composition runs locally in `remnote-cli` using the plugin's SDK gateway.

```bash
remnote-cli card apply --plan /tmp/cards.json --idempotency-key cards-batch-1
```

The CLI reads the **inner plan** from a UTF-8 JSON file or stdin (`-`), then wraps it as
`{schemaVersion:1,plan,dryRun:true,idempotencyKey}`. `--apply` explicitly sets
`dryRun:false`; preview is the default and performs no writes or persistent journal storage. Preview is not approval
to apply. Apply only within the user's explicitly authorized operation, targets and scope;
see the [CLI skill](../../skills/remnote/SKILL.md#safety) for authorization and safety rules.

Neither preview nor apply ever looks up dates or creates daily documents. Task setters recheck the active KB and official authorization
immediately before each SDK mutation after awaited reads. This is not a transaction or rollback guarantee.

`card apply` needs the Bridge's separate `KnowledgeBaseInfo: Read` permission for current-KB identity and
journal isolation; `All` content access does not include it. Existing installations require explicit permission
approval. A denied identity lookup stops preview/apply before any content write; do not bypass KB isolation.

## Flashcard Plan Variants

The flashcard boundary parser returns one explicit normalized variant:

- `create`: creation fields plus at least one new card.
- `patch`: answer patches only.
- `reuse`: existing card Rem IDs only.
- `mixed`: two or more of creation, patch, and reuse operations, with only the fields for those operations.

Patch-only and reuse-only plans do not carry daily, HOME, term, title, or creation fields.
The executor consumes the parsed variant and does not repeat field-shape validation.
Each variant declares the official SDK capabilities it needs. The live catalog is
checked once before preview reads and before the first mutation; a missing capability
returns `missing_capability` without writing.

Flashcard mutations use `OperationKernel`. It persists `started`
before the native call and records `verified` only after readback. Each task step
owns one mutation boundary: a created scaffold is `applied` as soon as its exact
IDs are durably saved, while binding and content writes remain separate. Failure
after an `applied` mutation is `partial` and can resume under the same key.
`unknown` is reserved for receipts that cannot identify the affected objects.

## Shared bounds and text

- Both envelope and plan require literal `schemaVersion:1`; unknown fields are rejected
- Exact IDs: nonblank strings, at most 256 characters
- Object/patch `key`: 1–64 characters matching `^[A-Za-z0-9._-]+$`, unique across all keyed entries in the plan
- `idempotencyKey`: 1–128 characters with the same pattern
- Titles and plain-string questions: nonblank, at most 1000 characters
- Question `TextSegments`: combined literal text at most 1000 characters and either nonblank text or a native reference
- Aliases: nonblank strings, at most 200 characters each
- `TextSegments`: array of 1–100 entries; each is a string (at most 10000 characters, empty allowed), or exact `{remId}`
- A flashcard answer line may instead be one code-block segment: `{"code":"line1\nline2","language":"plaintext"}`. `code` is 1–10000 characters and may contain newlines. `language` is optional, defaults to `plaintext`, and matches `^[A-Za-z0-9_+#.-]{1,64}$` (`python`, `c++`, and `c#` are valid). A code segment cannot share its line with other segments. Questions do not accept code segments.
- Apply stores that line as one RichText element `{i:"m",text,code:true,language}` with `language` defaulting to `plaintext` (the SDK `richText.code` shape). The identity check and `answerLines.verified` rules are in Receipt and exit status.
- Reference objects require exactly one `remId`. Extra fields are invalid.
- `expectedTextHash`: 64 lowercase SHA-256 hex characters, taken unchanged from the target's current raw-text hash
- Task plans have no artificial card, answer, patch, or plan-file
  size ceiling. The executor persists progress, partitions internal scaffold calls,
  and queues transport requests when the live connection reaches in-flight capacity.

An answer patch has this shape:

```json
{"key":"answer-patch","cardRemId":"card-rem","remId":"answer-rem","expectedTextHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","text":["Correction with ",{"remId":"source-rem"}]}
```

The hash above is illustrative, not a real precondition. It hashes JSON-serialized current raw `text`, not the title,
rendered Markdown, or replacement. `cardRemId` identifies the card Rem and `remId` the precise answer node. A stale
hash is a conflict, not permission to bypass the guard.

## Flashcard inner plan

```json
{"schemaVersion":1,"dailyRemId":"daily-rem","homeRootId":"home-root","tagRemId":"tag-rem","title":"Topic","newCards":[{"key":"card-a","question":"Question?","answer":[["Answer."]]},{"key":"card-b","question":["How does ",{"remId":"source-rem"}," apply?"],"answer":[["See ",{"remId":"source-rem"}]]}],"answerPatches":[],"reusedCardRemIds":[]}
```

When `newCards` is present, `dailyRemId` names the existing daily document and `homeRootId` plus `tagRemId` are
required unless the plan uses `tags` (see below), in which case both are forbidden. `newCards`, `answerPatches`,
`reusedCardRemIds`, `parentRemId`, `title`, `cardCluster`, and `tags` are optional. At least one new/patch/reused card is required. Each new card requires
`key`, a plain string or TextSegments `question`, and at least one answer line.
There is no artificial card, answer-line, patch or reuse count limit. Plain-string
questions containing `[[` or `]]` are rejected because RemNote stores those
brackets as literal text. Native reference IDs in questions and answers are
checked before any write. Two or more new cards require a cluster title unless
`parentRemId` is set. Reuse uses Rem IDs, not native card IDs.

Patch-only and reuse-only plans update existing card identities and therefore omit `dailyRemId`, `homeRootId`,
`tagRemId`, `parentRemId`, `title`, `cardCluster`, and `tags`. Their target is the exact `cardRemId`/`remId` in the
patch or the explicit reused Rem IDs; no daily or creation context is consulted.

```json
{"schemaVersion":1,"answerPatches":[{"key":"fix","cardRemId":"card-rem","remId":"answer-rem","expectedTextHash":"<sha256>","text":["Corrected"]}]}
```

```json
{"schemaVersion":1,"reusedCardRemIds":["card-rem"]}
```

`parentRemId` is optional and names an existing topic Rem: a non-card, non-folder, non-document Rem that is a
direct child of `dailyRemId` and already carries `tagRemId` (for example the titled parent created by an earlier
plan). New cards are then created as its last direct children, in plan order, and receive no tag of their own; there
is no `root` binding, and the receipt `ids` include `parent`. With `parentRemId`, `title` is rejected, `cardCluster`
cannot be `true`, two or more new cards do not need a title, and at least one new card is required. Verification
checks each card's parent, that the topic keeps `tagRemId` and lists the new cards among its children in plan order,
and that no new card repeats `tagRemId`. Use it for overflow cards after the first titled 7-card plan instead of
single-card plans followed by `rem move` and tag removal. Preflight rejects any other parent before a write.

`tags` is optional and replaces the implicit HOME tagging above with explicit tags:

```json
{"schemaVersion":1,"dailyRemId":"daily-rem","title":"Topic","newCards":[{"key":"card-a","question":"Question?","answer":[["Answer."]]},{"key":"card-b","question":"Other?","answer":[["Answer."]]}],"tags":{"root":[],"card:a":["tag-1"],"card:b":["tag-1","tag-2"]}}
```

Keys are receipt semantic keys: `root` or `card:<key>` for a new card in this plan; values contain distinct
existing tag Rem IDs. `answer:` keys and unknown keys are rejected. A `parentRemId` plan has no root, so `root` is
rejected there. In a single-card plan without `parentRemId` the root is the card itself; `root` and `card:<key>` may
both appear only with the same IDs. When `tags` is present (an empty object counts), `homeRootId` and `tagRemId`
must be omitted and the CLI applies no HOME rule: it does not tag the root implicitly, does not check HOME ancestry
or exclusivity, and a `parentRemId` topic need not carry any tag (its tags are neither changed nor checked; the
non-card, non-folder, non-document, direct-child-of-`dailyRemId` checks still apply). Declared tags are added inside
the creation step, before the created-tag baseline is recorded, so same-key replay stays consistent. After writing,
every created Rem (root, cards, answer lines) must carry exactly its declared tag IDs, or none if undeclared; each
yields a `tags` check in the receipt and a mismatch fails the apply. Receipt `ids` then omit `tag`. Tag IDs added
later with `rem tags update` change that baseline and make a same-key replay conflict, so declare final tags in the plan.
For new-card plans without `tags`, implicit HOME tagging is unchanged.

`cardCluster` is an optional boolean and defaults to off. A multi-card plan still creates a titled parent Rem, but
apply adds and verifies the Card Cluster powerup (`cc`) only when `cardCluster` is `true`. That opt-in also requires
the title and at least two new cards. Omitted or `false` never calls `addPowerup('cc')`, and verification does not
require `cc: true`.

For new-card plans, `dailyRemId` must be an explicit existing native `dailyDocument`. Type validation receives no date
scalar and cannot prove calendar freshness. The caller resolves/revalidates the intended calendar date before a new
batch and after midnight. Replay stays on the original recorded diary; never redirect an existing batch to a newly
resolved date.

The pinned SDK 0.0.46 represents ordinary Rem type as `undefined`, so its JSON
snapshot can omit `type`. Generated CLI constants preserve that runtime value;
the published declaration alone incorrectly suggests numeric zero. Recheck this
exception on SDK upgrades. Explicit concept, descriptor or portal types still
fail ordinary-node guards; the CLI never retypes them to resume a task.

## Receipt and exit status

Required fields: `schemaVersion:1`, `kind:flashcards`, `batchKey`, SHA-256 `planHash`, `status`, `complete`, `ids`,
`facts`, `created`, `updated`, `reused`, `skipped`, `steps`, `checks`, `readWindow:{startedAt,finishedAt}`, and
`errors:[{remId?,code,message}]`.

- `status`: `preview`, `verified`, `partial`, `unknown`, `incomplete`, or `conflict`
- `created`/`updated`/`reused`/`skipped`: arrays of `{key,remId}`
- `steps`: `{key,state,remIds,error?}`; state is `started`, `applied`, `verified`, `unknown`, `conflict`, `failed`, or `incomplete`
- `checks`: `{kind,remId,status:passed|failed|incomplete,expected?,actual?,message?}`
- `ids`: mappings from semantic keys to exact Rem IDs. Use returned keys such as `daily`, `tag`, `root`,
  `card:<key>`, `answer:<key>:<zero-based-index>`
- `facts`: selected `{remId,textHash,cardIds,reviewHash}` records for owned/changed/reused Rems; both hashes
  are 64-character lowercase SHA-256. No title/text/native review-history body is included
- `answerLines` is added only when flashcard apply records a new-card or flashcard-patch answer line. Each entry is `{key,remId,isCardItem,hasCardStructure,verified,error?}`. Keys are `answer:<cardKey>:<zero-based-index>` or `patch:<patchKey>`. `hasCardStructure` is `hasCardStructure(text, backText, isCardItem)`. `verified` is `false` when the line is recorded and becomes `true` only after the identity check below passes. `error` is present only when that check fails. Preview receipts omit `answerLines`. `--summary` keeps the array, including `verified` and `error`.
- For each new-card answer line, apply takes `before = contentHash(canonical(cardFacts(cardRem)))` immediately before `createdText` of that answer. For each answer patch, it takes that hash immediately before `patch`. `canonical` sorts object keys recursively and maps arrays in order. `cardFacts` returns `{remId, textHash, parentRemId, children, tags, cards}`. `textHash` is `contentHash` of the card Rem's raw text. `parentRemId` is `(await getParentRem())?._id`. `children` is `nativeIds(getChildrenRem())`. `tags` is `nativeIds(getTagRems()).sort()`. Each `cards` entry from `getCards()` is `{cardId: _id, type, createdAt, repetitionHistory: repetitionHistory ?? [], nextRepetitionTime, lastRepetitionTime, timesWrongInRow}`. `contentHash` is lowercase hex SHA-256 of `JSON.stringify(value ?? null)`, which omits object keys whose values are `undefined`. On an answer patch only, `before` is stored with `cardBaselines[cardRemId] ??=` and a different stored baseline throws TaskError code `conflict`, message `Card identity or review facts changed`, `remId` the card Rem id, before the text write. New cards do not write `cardBaselines`.
- After `createdText` on a new answer, or after `patch` on an answer patch, apply throws TaskError code `incomplete`, message `Card identity or history changed while writing an answer line`, and `remId` set to the card Rem id, when the hash differs. That throw happens before `noteAnswer`, so that line is not in `answerLines`.
- `noteAnswer` then appends the line with `verified: false`. A sole code segment must already equal `{i:"m", text: code, code:true, language: language ?? "plaintext"}`; otherwise it throws TaskError code `incomplete`, message `Code-block answer readback mismatch`, `remId` the answer Rem id, and does not append. When `isCardItem()` is false it calls `setIsCardItem(true)` and re-reads. If `isCardItem()` is still false or the text differs, it throws TaskError code `incomplete`, message `Code-block answer is not a card item`, `remId` the answer Rem id, and does not append. Plain text, including a code line patched back to plain text, does not call `setIsCardItem(false)`. The entry copies the re-read `isCardItem` and `hasCardStructure(text, backText, isCardItem)`.
- Apply then repeats `contentHash(canonical(cardFacts(cardRem)))` against the same `before`. A mismatch sets that entry's `verified` to `false` and `error` to `Card identity or history changed while writing an answer line`, then throws TaskError code `incomplete` with that message and `remId` the card Rem id. A match sets `verified` to `true` and deletes `error`. On a flashcard patch, `facts([cardRemId, answerRemId])` runs only after that match. On new cards, `facts(scaffoldIds)` runs only after every new answer line matches, and after cluster powerup and scope verification. The apply catch sets `status` from the error code: `conflict` stays `conflict`; an unreconciled journal step in `started` or `unknown` becomes `unknown`; otherwise `partial` when `created` or `updated` is non-empty, otherwise `incomplete`. The create step becomes `applied` immediately after all exact scaffold IDs are durably saved. A binder, content or verification failure after that point is therefore `partial`, and replay under the same key resumes without creating the scaffold again. `status` is not `verified` and `complete` is `false`.

Facts come from postwrite verification of created trees and answers plus exact patched or reused target reads. Use
these observed hashes/card IDs for the next stage without another broad read just to reconstruct the receipt. Never
guess created-ID ordering or invent absent semantic keys. Receipt hashes do not replace semantic final-text review
using selected exact IDs. Keep persistent workflow evidence metadata-only, never KB text/titles/aliases/history.

The CLI emits the complete receipt in JSON and text modes before exit. Zero requires `complete:true`, no errors,
and `status:preview` for preview or `status:verified` for apply. All other outcomes are non-success. Applied steps
alone are not a verified batch. A transport failure can occur before a receipt is returned.

`card apply --summary` keeps status, IDs,
hashes, read window, all identity arrays/steps and errors, add counts, and omit
passing check detail. Recovery identities are never discarded, even on partial writes.
Omit the flag for full detail. Summary
is output-only: it never changes execution, proof requirements or exit status.

Each SDK call has a 15-second default deadline, with no command-wide task deadline.
Interrupted applies may have changed data. Preserve the exact reviewed plan and
stable key, inspect current receipts/IDs, and reconcile known outcomes before
another authorized action. A known scaffold with all exact IDs can be structurally
reconciled and resumed under the same key. A creation result without exact IDs is
never blindly replayed. Do not change a plan under its key or generate a new key to
bypass partial/unknown/conflict. Private metadata-only idempotency journals live
under the standard CLI state directory at
`state/<KB hash>/`; they are durable before writes and are not transactional rollback. Required full-card proof scopes stay intact; report incomplete if blocked.
