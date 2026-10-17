# CLI And Plugin Repositories

Status: accepted in the maintainer conversation, 2026-10-02. Amended when the
CLI and plugin moved into separate repositories.

## Decision

The CLI lives in [zeefan1555/remnote-cli](https://github.com/zeefan1555/remnote-cli).
The plugin lives in
[zeefan1555/remnote-cli-bridge](https://github.com/zeefan1555/remnote-cli-bridge).
Import the existing improved forks rather than rewriting them.
Retain their licenses, authorship and exact source provenance.

This CLI owns business composition. The plugin owns official SDK access. Both
components still communicate only through the authenticated loopback protocol.
The repository split does not change the runtime boundary or safety contract in
[0001-direct-cli](0001-direct-cli.md).

Each repository keeps its own dependency lock, toolchain and output. GitHub
Actions in this repository validates the CLI. No workspace dependency hoisting,
shared runtime package, submodule, subtree synchronization service or additional
build framework is used. Both repositories use the public npm registry. Lockfiles
must not depend on a developer's private registry or network.

Product versions remain independent. A CLI-only business addition must not
require a plugin release when its required SDK capability is already available.

## Verification

Preserve runtime source and SDK generated output during this import. Verify
each repository's lockfile install, full quality checks, SDK freshness and
production builds. Check cross-repository links, CI ownership and the preserved
upstream licenses.

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
