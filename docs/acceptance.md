# Acceptance Status

Latest check: the 0.24.1 freeze fix passed real desktop two-card creation,
same-key replay and normal restart readback. Native transactions are disabled,
not repaired; see [the safety decision](adr/0003-disable-unsafe-native-transactions.md)
and the latest verification below. Historical checks describe their own candidates.

The imported implementation is not accepted for daily installation.

Before this repository migration, real RemNote desktop testing established:

- Authenticated access to the intended KB through the independent SDK plugin.
- Two real native cards, exact readback and desktop answer verification after
  reconciling the original saved plan/key.
- Same-key replay preserved Rem/native-card IDs, content and review history.
- A CLI-only composition counted both cards against unchanged plugin assets.

Mandatory gates still failed or remained incomplete:

- Native transaction abort timed out without acknowledgement after 15020 ms.
  A subsequent commit scenario was not reached.
- After a user force-quit/reopen, the transaction root was restored and its
  attempted child was absent. This is crash recovery, not a normal abort pass.
- Card snapshots survived restart, but strict whole-context equality failed
  because the daily document gained an empty Rem of unconfirmed provenance.
- Persistent-host restart smoke and daily CLI adoption were not performed.

The previous environment was restored: the new plugin was disabled, the old
plugin/served assets restored, and the daily CLI left unchanged. The prior MCP
service remained stopped. Restoring that state did not repair its known KB grant
limitation or establish a working daily stack.

Private plans, keys, IDs and raw logs remain outside this repository. Do not
delete uncertain artifacts, narrow the proof scope, or blindly rerun the saved
write plan. Resolve the supported SDK abort behavior before another live write.

This migration requires fresh offline checks and builds of the relocated code.
Previous test counts, source hashes and real-card evidence are provenance only,
not acceptance of a new build. Nothing here authorizes installing it or reports
that native rollback has been fixed.

## Repository Migration Checks

Verified on 2026-10-02 with Node.js 26.7.0 and npm 11.19.0:

| Check | Result |
| --- | --- |
| `npm run setup` | Both locked dependency installs passed. |
| `npm run quality` | CLI: 718 tests; plugin: 77 tests. Type, lint, format, coverage and SDK freshness checks passed. |
| `npm run build` | Both production builds and the plugin ZIP passed. Webpack reported three bundle-size warnings. |
| Built CLI `--help` / `--version` | Both exited successfully; version `0.24.0`. No live connection was opened. |
| Runtime source and generated catalogs | All 41 CLI and 16 plugin files match the original candidate, including modes. |
| Original inputs | Both original HEADs, dirty status, complete source hashes and existing build files remain unchanged. |
| Licenses and lockfiles | Both packages retain the original bytes. |
| CI configuration | Parsed and checked locally; covers each package on Node.js 22.13.0 and 24. Remote CI has not run. |

The build correction is package-local manifest validation. The
SDK's command assumes the plugin is the Git root, so the new script resolves the
plugin directory and uses the same official `parseManifest` Node entry as the
SDK command. A regression test invokes it from the shared repository root.

Raw final logs are in ignored `.local/quality-final.log` and
`.local/build-final.log`. `.local/migration-candidate.json` records the complete
relocated source and production artifact manifests and SHA-256 values;
`.local/preservation.json` records the unchanged original candidates. These are
local migration evidence, not native persistence acceptance.

At the end of migration the independent GitHub repository was private and empty;
no commit, push, publication, live write or installed-software change had been
made. The maintainer then explicitly authorized commit, push and continued
verification on 2026-10-02. The native rollback and adoption gates above remain
open; this delivery authorization does not establish a passing live result.

## Post-Commit Verification

The independent repository is private and its default branch is `master`.
Commit `9ecf91b9c2bfedd04db56ff198ed19ee279b9d3f` was pushed successfully.
Its first [CI run](https://github.com/zeefan1555/remnote-direct/actions/runs/36986337235)
passed both plugin jobs, but both CLI jobs failed during dependency installation:
15 CLI lockfile tarballs pointed at a developer's private npm mirror.

The correction changes only those download origins to `registry.npmjs.org`;
versions, integrity hashes and other lock data are unchanged. Repository/package
`.npmrc` files and regression tests prevent inheriting a private registry again.
Both packages installed successfully using a new public-registry cache. Full
quality checks passed with 719 CLI tests and 78 plugin tests; both production
builds passed with the same three plugin bundle-size warnings. These results
are recorded in ignored `.local/quality-registry.log` and
`.local/build-registry.log`. The earlier byte-identical lockfile statement
describes the import, not this subsequent repair.

The installs also reported existing dependency audit findings: 10 in the CLI
and 25 in the plugin, including one critical plugin finding. These are not
resolved by changing download URLs; no automatic dependency upgrades were made.

An offline reproduction using the installed official SDK `0.0.46` confirmed that
its callback dispatcher acknowledges a successful callback but sends no host
response when the callback rejects. `app.transaction` uses this dispatcher.
This is consistent with the observed native abort timeout, but is not a new
native rollback test or a repair. The SDK's current public release is still
`0.0.46`. The reproduction touched no knowledge-base data and is recorded in
ignored `.local/sdk-callback-repro.json`.

Do not patch private SDK transport, swallow an abort as a commit, or repeat the
known hanging write scenario. Native writes and daily adoption remain blocked
until supported abort handling is resolved and tested on RemNote desktop.

The repaired commit `25770b06b820ebb1e0e44307bad6970d3b94d003` passed
all four [remote CI jobs](https://github.com/zeefan1555/remnote-direct/actions/runs/36987608092).
Post-commit local quality and production builds passed again. A subsequent
root-command check found that npm forwards its parent registry into child npm
commands, overriding package-local settings. The repository root therefore also
pins the public registry; tests check all three configuration files. This does
not change the user's global npm configuration or any runtime source.

## Desktop Read-Only Recheck

Using the production artifacts from `25770b0`, temporary desktop activation of
the already-installed independent plugin verified authenticated status, KB
`byte`, SDK `0.0.46` and native platform `app`. The complete served plugin files
matched their recorded build hashes. Capability discovery reported 265 supported
and 21 unsupported methods; discovery is not native testing of all methods.

The existing two cards were read by exact ID. All eight objects and full subtree
scope in the saved context request matched the post-restart baseline, including
Rem/native-card IDs, question/answer content and empty review histories. Both
answers were observed in the desktop UI. A second complete read after desktop
inspection showed no object or scope changes. CLI-only SDK reads counted exactly
two existing native cards without changing plugin assets.

Cold status connected in 2756 ms and completed in 2770 ms; its guarded wrapper
took 6.00 s including the build. The complete context command took 1012 ms
(3.68 s with the wrapper). Evidence is private under ignored
`.local/native-readback-25770b0/`; the source/build manifest is
`.local/candidate-25770b0.json`.

No new card creation, same-key write replay or native abort was attempted in this
recheck. The old pre-restart whole-context difference and native rollback gate
remain unresolved. A passing read path does not establish full write acceptance.

## Freeze Regression Fix: 0.24.1

The regression had two connected causes. The official SDK 0.0.46 never sends a
host response when a transaction callback rejects; holding that transaction open
across CLI requests could therefore leave the editor locked. Native aliases also
return text values without Rem IDs despite the SDK declaration. The old fork
checked alias creation truthiness, while the direct serializer required a Rem ID
and triggered the broken abort path.

ADR 0003 removes the cross-request native transaction scope. Additive commands
save private recovery metadata and known IDs before follow-up writes; unknown
outcomes stop without retry or cleanup. Alias methods return bounded text values.
Ordinary Rem/Card results still require real IDs. Atomic update, replacement,
property writes and TODO apply remain unavailable rather than silently losing
their atomicity guarantee.

Verified on RemNote desktop, KB `byte`, on 2026-10-02:

| Check | Result |
| --- | --- |
| `npm run quality` | 725 CLI tests and 77 plugin tests passed, including actual-SDK callback and idless-alias regressions. |
| SDK freshness and production builds | Passed; the plugin build retains three bundle-size warnings. |
| Previous uncertain alias write | Exact-ID readback recovered the existing title and alias, with no duplicate create. |
| New installed-CLI create with alias | Write and exact-ID readback passed; the native daily document showed both title and alias. |
| Guarded two-card acceptance | 6/6 steps passed, no skips; 13.0 s including runner setup. |
| Preview / apply / fresh verification | 789 / 1719 / 695 ms. |
| Same-key replay and comparison | 2316 ms; Rem IDs, native card IDs, text, child lists and review histories were unchanged. |
| CLI-only composition | 1422 ms; existing public SDK commands counted the same two native cards with unchanged plugin assets. |
| Desktop inspection | Both exact card pages and answers were observed. Subsequent eight-object readback was unchanged. |
| Normal restart | Quit through the RemNote menu, restarted the static LaunchAgent, reopened the app, and invoked installed `remnote-cli` from `/tmp`. |
| Post-restart persistence | Eight objects unchanged; full scope verification passed five checks across 13 objects; same-key replay and final equality passed. The native second-card answer was visible again. |
| Unsafe transaction preflight | Refused before fixture creation with `nativeTransactions: false`; this is not a rollback pass. |

The plugin and CLI reported 0.24.1 and SDK catalog SHA-256
`6c6c4420e6b7058c2b1e2706b9bf9f43933b5d448f7a3de5de0a8cbe1cd28fd4`.
Cold status after app launch connected in 5217 ms and completed in 5227 ms.
Plugin `index.js` SHA-256 was
`dd41fec6d1439d725fa13d73489d8dae376cb5799e43e341ded7bbb3bf815c95`;
`sdk_bridge.js` was
`bfb040ff30e4424788605b342a4add66bbb7ec93068fa0056ddd427152a3dfc9`.
Served files matched the production build before and after CLI-only composition.

Private plans, idempotency keys, exact IDs, source/build manifests and raw results
are recorded under ignored `.local/freeze-fix-*` and the referenced private test
evidence directory. Pre-existing dirty documentation is preserved separately and
is not evidence that the earlier HEAD contained this fix. No rollback retest,
private SDK patch, old MCP fallback or marketplace publication was performed.
The broader SDK catalog and transaction-dependent commands are not fully accepted.
