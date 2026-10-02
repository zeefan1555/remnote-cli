# Testing Strategy

## Local Checks

`./code-quality.sh` validates TypeScript, the generated SDK catalog/constants,
lint, formatting, regression tests and coverage without live RemNote. Build both
repositories after cross-boundary changes.

Tests cover authenticated KB binding, live write/destructive gates, bounded JSON,
timeouts, disconnects, transaction acknowledgement, metadata recovery and CLI
business behavior. Mocks do not prove native RemNote persistence or rollback.

## Live Integration

Use the [guarded integration workflow](integration-testing.md) only after explicit
authorization. It creates real, uniquely labeled data and reads it back through
the candidate CLI and active candidate plugin. Report exact run identity, counts,
IDs, timings, failures, skipped fixtures and retained artifacts.

Do not count old MCP paths or an installed legacy build as direct-CLI acceptance.
For business-only changes, record unchanged plugin asset hashes.

## Installed Setup

Use `remnote-cli status`, capability discovery and a targeted read to verify
pairing, permissions and the intended KB. A successful setup check is not
end-to-end write acceptance. Any live write by an agent still uses the guarded
wrapper and explicit authorization.
