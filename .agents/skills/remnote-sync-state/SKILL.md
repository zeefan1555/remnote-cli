---
name: remnote-sync-state
description: Check RemNote workspace sync journal recovery, unknown writes, identity retention and publication guards with TLA+ and real implementation regressions. Use when changing the mapped sync functions or reducing their read sets.
---

# RemNote sync state

The safety promise is that an interrupted write is not blindly replayed, persisted new IDs survive recovery, and publication uses an exact observed result bound to the original input. Breaking it can duplicate notes, lose known identities or publish an unproven result.

## Run

1. Compare the covered functions below with sync commit `5b69bd018a3adb17abe0aed4259061a76b10b564`. Read changed functions before trusting the model. A green checker does not automatically establish that the model still describes changed code.
2. From this repository root, run the following command with Node dependencies installed and Java 11 or later available.

   ```sh
   node .agents/skills/remnote-sync-state/check.mjs
   ```

   `REMNOTE_SYNC_JAVA` can name an isolated Java binary. `REMNOTE_SYNC_TLC_JAR` can name an already downloaded JAR. The runner otherwise downloads TLA+ tools 1.7.4 into ignored `node_modules/.cache/remnote-sync-state`. It checks SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88` before executing the JAR. This distribution reports TLC 2.19. No global configuration or real RemNote data is read or changed.
3. Require the safe and overview configurations to pass, all five broken variants to fail their named invariant, the no-CAS limitation to fail `FreshAtPublication`, and the implementation regressions to pass. Unexpected verifier failures are errors, not expected counterexamples. Logs and copied models are in the printed temporary evidence directory.
4. Read every TLC result using pstack `/statechart`. It reports each invariant violation as a shortest path in plain language. Use `view.mjs` for `SyncState.tla` and `window-view.mjs` for `PublicationWindow.tla`. Run it in a new scratch output directory. Show its Mermaid and explain each path. This skill intentionally contains no machine-specific `/statechart` command or plugin path.
5. For a proposed fix, replay the counterexample against the real implementation. Treat a non-reproducing path as a modeling error until disproved. For an intended behavior change, update the model and regression together. Move the sync commit forward only after reviewing the new mapping and rerunning this check.

The full safe configuration exceeds `/statechart`'s 500-state drawing budget. `overview.cfg` draws the same protocol without interruptions or interference. It is a presentation view, not a replacement for `safe.cfg`. The view hides only transitions that keep the same chart label.

## Scope and code mapping

The model is a bounded projection of the `mutate` journal protocol, not a full valid Markdown plan. It selects one empty-node creation and one Tag addition on an existing node. Text, attachment, parent and card-item operations between these selected writes are not simulated. Real regressions cover the full CLI plan around those operations.

| Model action or property | Covered code |
| --- | --- |
| `ReadGuardInput`, input binding | `workspace.ts` `synchronizeWorkspace`, `checkFiles`; `frozen-files.ts` `FrozenFiles.check` |
| `ReadNew`, `ReadTags`, exact guards | `workspace.ts` `readExact`, `preflight`; `sdk-backend.ts` `read`, `readEditGuards` |
| `PersistStarted`, `SendSdkCall` | `workspace.ts` `mutate`, before `fn()` |
| `SdkCreate`, `SdkAddTag` | `sdk-backend.ts` `create`, `setTag`; one public SDK mutation each |
| `ReceiveReply`, `PersistId`, `AcceptEffect` | `workspace.ts` `mutate` and the create `after` callback; `relations.ts` `applyRelation`, `advanceEditGuard` |
| `PersistVerified`, verified-prefix skip | `workspace.ts` `mutate` |
| `Interrupt`, delayed SDK execution | `workspace.ts` failure journal and interruption boundaries; the old submitted call may still execute after disconnect |
| `ResumeOffline`, `CheckResume`, `PersistRecognized` | `resume.ts` `foldResume`, `verifyResumeReadback`; `workspace.ts` explicit resume path |
| `CheckFinalObservation`, `PersistFinal` | `workspace.ts` final `preflight`, `checkPublicRevision`, `journal.final`; `snapshots.ts` `publicationRevisionHash` |
| `AuthorizePublication` | Entry to `writeSnapshot` and `publication.ts` `stageSnapshot` frozen-input check. It models permission to publish, not atomic multi-file publication. |
| `PublicationWindow` | `workspace.ts` final observation, separate journal persistence and `writeSnapshot` call |

Each metadata persistence step is the atomic record replacement performed by `LocalState.setLocal`. SDK mutation, returned acknowledgement, ID persistence and verified persistence are separate transitions. Readback of the new ID and the Tag set are separate SDK observations. A complete `readExact` or `readEditGuards` operation is not claimed to be an atomic native snapshot. Unmodeled fields remain stable in this bounded projection.

Bounds are two selected SDK mutations, two possible created IDs, one interruption and explicit resume, at most two attempts per mutation in broken variants, one external Tag addition and one local-input change. Pending calls can execute after interruption or after the CLI stops. The model distinguishes a known exact ID from a title search, and never observes an unknown orphan by discovery.

Assumptions are a single journal writer under the workspace lock, atomic durable metadata-record replacement against process interruption, correct individual public SDK methods, and matching KB/plan binding already established. Machine power loss, storage corruption, multiple CLI writers bypassing the lock, arbitrary remote graph edits, all Powerup codes, SDK-internal behavior, native Card creation semantics and full filesystem publication recovery are outside the model. No liveness or exactly-once delivery is proved.

## Interpreting the results

- `safe.cfg` checks no blind replay, no duplicate creation, persisted ID retention, a verified prefix, exact observed publication and original-input binding.
- The replay variants deliberately re-enter the write loop without respecting its attempted prefix. Shortest paths show a lost reply followed by another submission, two creations, or replacing the first persisted ID.
- `skip-observation.cfg` and `skip-input.cfg` remove the final observation or input gate. They must produce their named counterexamples.
- `window.cfg` intentionally violates `FreshAtPublication`. A user can edit after the last read but before publication. `ObservedCompletion` still holds. This is an existing SDK capability limit, not a fixed product bug or permission to hide an observed conflict.

`test/unit/business/workspace-state-contract.test.ts` replays the window at the real journal-persistence boundary. It also injects the same edit before post-write readback and requires `unknown`, an unfinished journal and no replay. The runner additionally executes focused existing tests for lost IDs, known-ID reuse, unknown setters/Tags, ordinary replay rejection and input hashes. These are synthetic in-memory native backends and private temporary local vaults. They are not native-persistence acceptance.

## Prove the guard still bites

In a separate scratch worktree, remove the `mutate` early return for `resuming && journal.steps[step] === 'verified'`. Run this skill's command. The implementation tests must fail because the verified prefix gets executed again. Restore that exact scratch edit and require the command to pass. Do not perform this mutation in a live-data checkout or treat a source-fingerprint mismatch alone as a successful test.

For changes that missed this check, use pstack `/maintain-formal-verification-skill` to reconcile the model and code before updating the sync commit. Per-step touched-set optimization is not yet modeled here. Preserve full initial/final scope checks and explicitly model coverage before using a local read as a global completion proof.
