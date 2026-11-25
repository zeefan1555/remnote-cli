# Versioning

The current package version is **0.1.31**.

## Policy

Releases use the exact shape `0.<minor>.<step>`:

- The major component is `0`.
- The minor component is a positive integer without leading zeroes.
- The step component is an integer from `1` through `100`, without leading zeroes.
- Each release increments the step. After step `100`, increment the minor component
  and reset the step to `1`.

For example, the sequence continues `0.1.29`, `0.1.30`, `0.1.100`, `0.2.1`.
Step `0`, step `101` and a step above `100` are invalid.

## Release Consistency

The current version appears in four places:

- `package.json`
- the top-level and root-package `version` fields in `package-lock.json`
- a `## [<version>] - YYYY-MM-DD` heading in `CHANGELOG.md`
- this guide

Validate the mechanical constraints from the repository root:

```bash
npm run check:version
```

The command fails when the version shape is invalid, the package and lockfile
disagree, or the changelog lacks the current version heading. `./code-quality.sh`
runs it directly; the repository test suite also checks the current package,
lockfile and changelog consistency.

To print the next version before editing release files:

```bash
npm run check:version -- --next 0.1.30
```

Historical changelog headings before `0.1.30` use an earlier sequence and are kept
verbatim. They do not override this policy.
