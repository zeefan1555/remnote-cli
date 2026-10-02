# Development

Use Node.js >= 22.13.0; Node.js 24 is recommended. If needed, run
`source ./node-check.sh` before other commands.

```bash
npm ci
./code-quality.sh
npm run build
node dist/remnote-cli/index.js --help
```

The only executable is `remnote-cli`. `./link-cli.sh` performs an explicitly
requested local link; `./unlink-cli.sh` removes it. There is no development daemon.

## Business Changes

Prefer adding a command or changing `src/business/` using existing remote SDK
methods. Validate input in `src/schemas/`, update the command reference and
`skills/remnote/SKILL.md`, and add a focused regression test. A business-only
change must not require a plugin release.

For SDK upgrades or protocol/permission/serialization changes, inspect the
companion plugin and update the cross-repo contract. Generate SDK constants with
`npm run generate:sdk-constants`; never import the browser SDK runtime into Node.

## Checks

`./code-quality.sh` runs typecheck, generated-file freshness, lint, formatting,
unit tests and coverage. Tests use Vitest and live under `test/unit/`.
`npm run build` checks the production entrypoint separately.

Live tests are separate, explicitly authorized operations through
`./run-agent-integration-test.sh`. Read [integration testing](integration-testing.md)
before running them; never bypass the wrapper to reach real RemNote.

Update `CHANGELOG.md` for functional or documentation changes. Preserve unrelated
worktree edits. The current direct-architecture adoption does not authorize commits,
pushes, merges or publication.

See [architecture](../architecture.md) and the companion
[contribution workflow](../../../plugin/docs/workflows/pr-validation-and-adoption.md).
