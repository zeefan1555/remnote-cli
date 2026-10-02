# Acceptance Status

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
versions, integrity hashes and other lock data are unchanged. Package-local
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
