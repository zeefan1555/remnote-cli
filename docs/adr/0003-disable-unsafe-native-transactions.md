# Reject Unsafe Native Transactions

Status: regression safety fix, 2026-10-02.

## Evidence

The installed official SDK 0.0.46 does not send a callback response when an
`app.transaction` callback rejects. The host transaction stays open and can
block the RemNote editor. The direct bridge additionally waited for that
transaction before admitting another session. Unlike the old plugin-local
business callbacks, the direct begin/end scope made connection loss, request
expiry and CLI decoding errors trigger the broken abort path.

[remnote-cli-bridge](https://github.com/zeefan1555/remnote-cli-bridge)
`test/unit/sdk-callback.test.ts` reproduces the SDK behavior
offline. It is not native rollback acceptance and does not patch the SDK.

## Decision

Supersede only the native begin/end transaction mechanism in ADR 0001. Do not
open native transactions over the bridge. Reject remaining transaction-dependent
commands (`update`, `replace`, property writes and TODO apply) before their callback
or any mutation runs; do not silently execute those callbacks non-atomically.
In particular, destructive replacement must not become a partially committed
operation merely to restore connectivity.

Additive `create`, `journal` and `insert` use explicit sequential writes instead.
Write a private metadata-only recovery journal before the first SDK mutation,
including daily-document lookup which can create a document. Save known parent,
created Rem IDs immediately when returned, before follow-up mutations.
Failure reports the recovery key and known IDs and stops without rollback, cleanup
or replay. These commands do not promise atomicity or automatic idempotent replay;
the existing task API remains the stable-key interface.

The existing journaled flashcard task is already a non-atomic, recoverable
workflow. Its scaffold uses the public `createTreeWithMarkdown` call without an
outer native transaction. Save any returned IDs before follow-up work. On failure
retain `started`/`unknown`, IDs and the original key, then stop without replay or
automatic cleanup. Final success still requires exact native readback.

The SDK remains pinned. No callback executor, private transport patch, global
Undo, compensating rollback or old MCP runtime is introduced. SDK object results
without a valid ID fail at the plugin boundary with the originating capability;
they must not become apparently valid remote objects.

## Native Alias Values

Desktop testing also confirmed that `getAliases` returns objects with `.text`
but no Rem ID. The native UI shows the alias, while the owning Rem has no alias
children. RemNote explicitly rejects built-in `getPowerupPropertyAsRem` because
built-in properties are no longer Rems. The old plugin only checked the truthiness
of alias creation; the new bridge incorrectly required a Rem identity, which
triggered the broken transaction abort.

Materialize `getAliases` and `getOrCreateAliasWithText` as bounded `{text}` values,
declared as `aliasText` in the generated catalog. Never synthesize an ID or expose
Rem methods on an alias. Journal the owning Rem and verify alias text. Other
Rem/Card results still require real IDs. Atomic alias updates/removal remain
unavailable with the other transaction-dependent commands.

## Verification

Check rejected begin/end requests, reconnect and status after rejection, CLI
transaction refusal before callback execution, malformed object IDs, and
journaled scaffold failure/replay. Run both package quality gates and builds.
After desktop reload, reconcile the earlier unknown alias creation before new
writes, then verify real card creation, exact readback and same-key replay.

Native atomic commands remain unavailable until an official SDK can acknowledge
abort and passes independent desktop persistence tests. Do not rerun the known
hanging abort against the user's knowledge base or describe this removal as a
successful rollback test.
