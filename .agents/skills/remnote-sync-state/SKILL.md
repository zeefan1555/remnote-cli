---
name: remnote-sync-state
description: Check RemNote workspace sync journal recovery, unknown writes, identity retention and publication guards with TLA+ and real implementation regressions. Use when changing the mapped sync functions or reducing their read sets.
---

# RemNote sync state

The safety promise is that an interrupted write is not blindly replayed, persisted new IDs survive recovery, and publication uses an exact observed result bound to the original input. A local read footprint cannot replace full initial/final scope checks or fresh Card/history guards. Breaking these rules can duplicate notes, lose identities or publish an unproven result.

## Run

1. Compare the covered functions below with sync commit `5b69bd018a3adb17abe0aed4259061a76b10b564`. Read changed functions before trusting the model. A green checker does not automatically establish that the model still describes changed code.
2. From this repository root, run the following command with Node dependencies installed and Java 11 or later available.

   ```sh
   node .agents/skills/remnote-sync-state/check.mjs
   ```

   `REMNOTE_SYNC_JAVA` can name an isolated Java binary. `REMNOTE_SYNC_TLC_JAR` can name an already downloaded JAR. The runner otherwise downloads TLA+ tools 1.7.4 into ignored `node_modules/.cache/remnote-sync-state`. It checks SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88` before executing the JAR. This distribution reports TLC 2.19. No global configuration or real RemNote data is read or changed.
3. Require all four safe/overview configurations to pass, all eleven broken variants to fail their named invariant, the no-CAS limitation to fail `FreshAtPublication`, and the implementation regressions to pass. Unexpected verifier failures are errors, not expected counterexamples. Logs and copied models are in the printed temporary evidence directory.
4. Read every TLC result using pstack `/statechart`. It reports each invariant violation as a shortest path in plain language. Use `view.mjs` for `SyncState.tla`, `readset-detail-view.mjs` for `ReadSetScope.tla` counterexamples, and `window-view.mjs` for `PublicationWindow.tla`. For compact successful charts, use `overview.cfg` with `overview-view.mjs` and `readset-overview.cfg` with `readset-view.mjs`. Run in new scratch output directories, using the copied models from step 3. Show the Mermaid and explain each path. This skill intentionally contains no machine-specific `/statechart` command or plugin path.
5. For a proposed fix, replay the counterexample against the real implementation. Treat a non-reproducing path as a modeling error until disproved. For an intended behavior change, update the model and regression together. Move the sync commit forward only after reviewing the new mapping and rerunning this check.

Both full safe configurations exceed `/statechart`'s 500-state drawing budget. The two overview configurations exclude interruptions/interference and draw 16 and 11 arrows respectively. They are presentation views, not replacements for safe configurations. The compact views hide only transitions that keep the same chart label, principally individual field reads.

## Scope and code mapping

`SyncState` is a bounded projection of the `mutate` journal protocol, not a full valid Markdown plan. It selects one empty-node creation and one Tag addition on its existing card owner, whose footprint includes the new child. Text, attachment, parent and card-item operations between these selected writes are not simulated. Real regressions cover the full CLI plan around those operations.

| Model action or property | Covered code |
| --- | --- |
| `ReadGuardInput`, input binding | `workspace.ts` `synchronizeWorkspace`, `checkFiles`; `frozen-files.ts` `FrozenFiles.check` |
| `ReadNew`, `ReadTags`, exact guards | `workspace.ts` `readExact`, `preflight`; `sdk-backend.ts` `read`, initial `readEditGuards`; `relations.ts` `snapshotEditGuards` |
| `PersistStarted`, `SendSdkCall` | `workspace.ts` `mutate`, before `fn()` |
| `SdkCreate`, `SdkAddTag` | `sdk-backend.ts` `create`, `setTag`; one public SDK mutation each |
| `ReceiveReply`, `PersistId`, `AcceptEffect` | `workspace.ts` `mutate` and the create `after` callback; `relations.ts` `applyRelation`, `advanceEditGuard` |
| `PersistVerified`, verified-prefix skip | `workspace.ts` `mutate` |
| `Interrupt`, delayed SDK execution | `workspace.ts` failure journal and interruption boundaries; the old submitted call may still execute after disconnect |
| `ResumeOffline`, `CheckResume`, `PersistRecognized` | `resume.ts` `foldResume`, `verifyResumeReadback`; `workspace.ts` explicit resume path |
| `CheckFinalObservation`, `PersistFinal` | `workspace.ts` final `preflight`, `checkPublicRevision`, `journal.final`; `snapshots.ts` `publicationRevisionHash` |
| `AuthorizePublication` | Entry to `writeSnapshot` and `publication.ts` `stageSnapshot` frozen-input check. It models permission to publish, not atomic multi-file publication. |
| `PublicationWindow` | `workspace.ts` final observation, separate journal persistence and `writeSnapshot` call |
| `ReadSetScope` `SelectReadSet`, `Required`, `Before`, `After` | `selection.ts` `mutationReadIds`, `verificationClosure`; `workspace.ts` first/full `preflight`, `mutate` before/after footprint union, final `preflight()` |
| `ReadSetScope` primitive observations and `CheckObserved` | `sdk-backend.ts` `read`, `snapshot`, `cardsSnapshot`; `relations.ts` `snapshotEditGuards` checks the raw batch before `withNativeSnapshot` can merge old supplemental facts |
| `ReadSetScope` Card/history invariants | `relations.ts` `editGuard`, `cardEvidence`; `workspace.ts` initial sealed Card-ID comparison and final `nativeBefore`/`nativeAfter` receipt |

Each metadata persistence step is the atomic record replacement performed by `LocalState.setLocal`. SDK mutation, returned acknowledgement, ID persistence and verified persistence are separate transitions. Readback of the new ID and the Tag set are separate SDK observations. A complete `readExact` or `readEditGuards` operation is not claimed to be an atomic native snapshot. Unmodeled fields remain stable in this bounded projection.

Bounds are two selected SDK mutations, two possible created IDs, one interruption and explicit resume, at most two attempts per mutation in broken variants, one external Tag addition and one local-input change. Pending calls can execute after interruption or after the CLI stops. The model distinguishes a known exact ID from a title search, and never observes an unknown orphan by discovery.

`ReadSetScope` is a separate finite projection with three existing Rems and two acknowledged Tag writes: remove the first Rem's Tag, then add a Tag on an independent branch. The old Tag target must remain in the first write's after-footprint; the independent branch may stay unread until its own step or the final full read. It checks the full frozen scope before the first write and before publication. At most one external revision/Card-ID/history change or missing Tag/Powerup response occurs. Content, one `getCards` response, Tag and one known Powerup are separate observations. The history value abstracts the digest of creation time plus complete non-null history. These models are checked separately; no composition proof combines readsets, interruption, input races and receipts.

The fixed three-node footprint does not prove the general graph traversal correct. `workspace-readset.test.ts` exercises current/intended ancestors, card families, old/new references and Tags, Portal members and Powerup descendants. The state-contract regressions check exact first/final read IDs, sparse intermediate reads, same-raw Card/history evidence and binding to `planHash`/`localHash`. Hash serialization/collision resistance is an assumption, not a TLA+ proof. Initial known Card-ID rejection, unknown histories and new plain Rems producing zero Cards are also implementation regressions, not additional model state.

Assumptions are a single journal writer under the workspace lock, atomic durable metadata-record replacement against process interruption, correct individual public SDK responses/mutations, and matching KB/plan binding already established. Machine power loss, storage corruption, multiple CLI writers bypassing the lock, arbitrary remote graph edits, all Powerup codes, SDK-internal behavior, native Card creation semantics, incoming graph adoption and full filesystem publication recovery are outside the model. No liveness or exactly-once delivery is proved.

## Interpreting the results

- `safe.cfg` checks no blind replay, no duplicate creation, persisted ID retention, a verified prefix, exact observed publication and original-input binding.
- The replay variants deliberately re-enter the write loop without respecting its attempted prefix. Shortest paths show a lost reply followed by another submission, two creations, or replacing the first persisted ID.
- `skip-observation.cfg` and `skip-input.cfg` remove the final observation or input gate. They must produce their named counterexamples.
- `readset-safe.cfg` checks first/final full coverage, before/after footprint union, fresh raw Card/history and required relationship facts. The six broken `readset-*` configurations narrow the first/final read, drop a removed Tag's target, or substitute cached guards for changed Card ID/history or missing facts. Unrelated drift can be discovered later; a boundary may only accept what that boundary actually observed.
- `window.cfg` intentionally violates `FreshAtPublication`. A user can edit after the last read but before publication. `ObservedCompletion` still holds. This is an existing SDK capability limit, not a fixed product bug or permission to hide an observed conflict.

`test/unit/business/workspace-state-contract.test.ts` replays the no-CAS window at the real journal-persistence boundary. It injects the same edit before post-write readback and requires `unknown`, an unfinished journal and no replay. Its readset cases also require step-local Card changes to stop immediately and unrelated history drift to stop at final verification without publishing a receipt. The runner executes focused existing recovery, input, native-evidence, raw-fact and graph-readset tests. These use synthetic in-memory native backends and private temporary local vaults; they are not native-persistence acceptance.

## Prove the guard still bites

In a separate scratch worktree, break the guard relevant to your change and run this skill's command. The real implementation tests must fail for the protected behavior; a source-fingerprint mismatch alone is insufficient. Restore that exact scratch edit and require the same command to pass. The bounded bad changes are:

- Remove the `mutate` early return for an already verified resume step: the prefix must be wrongly executed again.
- Let the first `preflight` use only its supplied footprint: the full-first-write test must catch the missing branch.
- Remove the final `await preflight()` immediately after the write loop: final history/identity drift must escape into a false success.
- Keep only the after-footprint instead of the before/after union: the removed-Tag target test must change from immediate `unknown` to delayed detection.
- Derive `snapshotEditGuards` from `expected` instead of `fresh`: changed Card/history and missing raw facts must no longer be accepted by the tests.

Keep all bad changes outside live-data checkouts. For changes that missed this check, use pstack `/maintain-formal-verification-skill` to reconcile the model and code before updating the sync commit.
