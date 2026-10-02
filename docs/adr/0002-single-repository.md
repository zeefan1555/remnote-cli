# One Repository, Two Packages

Status: accepted in the maintainer conversation, 2026-10-02.

## Decision

Maintain the CLI and plugin in the independent `zeefan1555/remnote-direct`
repository. Import the existing improved forks rather than rewriting them.
Retain their licenses, authorship and exact source provenance.

`packages/cli` owns business composition. `packages/plugin` owns official SDK
access. Both components still communicate only through the authenticated
loopback protocol. This changes repository topology, not the runtime boundary
or safety contract in [0001-direct-cli](0001-direct-cli.md).

Keep each package's existing dependency lock, toolchain and output. Root npm
scripts coordinate both packages; GitHub Actions validates both from the same
commit. No workspace dependency hoisting, shared runtime package, submodule,
subtree synchronization service or additional build framework is needed.
Both packages use the public npm registry. Their lockfiles must not depend on a
developer's private registry or network.

Product versions remain independent. A CLI-only business addition must not
require a plugin release when its required SDK capability is already available.

## Verification

Preserve runtime source and SDK generated output during this import. Verify
both lockfile installs, full quality checks, SDK freshness and production builds.
Check cross-package paths, CI ownership and the preserved upstream licenses.

The existing failed native rollback gate remains failed. Migration alone did not
authorize new real-card writes, install replacement, commit, push or publication.
The original working copies and their uncommitted changes remain intact.

## Delivery Authorization

On 2026-10-02 the maintainer subsequently authorized committing and pushing this
independent repository and continuing verification. This amends the initial
no-commit/no-push scope, not the native safety or installation gates. Package
publication remains outside scope. Delivery does not count as rollback acceptance.
The maintainer explicitly selected `master` as the default branch; CI uses it
for both push and pull-request checks.
