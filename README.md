# RemNote CLI

Command-line access to a RemNote knowledge base. Each command opens a loopback
WebSocket, talks to the [RemNote CLI Bridge](https://github.com/zeefan1555/remnote-cli-bridge)
plugin, and closes the connection.

```text
remnote-cli <-> authenticated loopback WebSocket <-> RemNote CLI Bridge <-> RemNote SDK
```

There is no MCP endpoint, stdio proxy, resident daemon, or cloud relay.
`batch --file` keeps one listener open across a list of commands so back-to-back
calls do not collide on the CLI port. Keep RemNote open with the paired plugin
enabled. An idle plugin waiting for a CLI command is normal.

[Native rollback acceptance remains blocked](docs/acceptance.md).

## Install

Use Node.js 22.13.0 or newer. Node.js 24 matches `.nvmrc`.

```bash
git clone https://github.com/zeefan1555/remnote-cli.git
cd remnote-cli
npm ci
npm run build
./link-cli.sh
remnote-cli --version
```

`./link-cli.sh` registers `remnote-cli` with the current npm prefix. A later
`npm run build` in this repository updates that command. `./unlink-cli.sh` removes
the link.

## Pairing

Install **RemNote CLI Bridge** from the RemNote marketplace. Its manifest id is
`remnote-cli-bridge`. Enable it in RemNote desktop and grant content access plus
**KnowledgeBaseInfo: Read**.

```bash
remnote-cli pair --kb-id YOUR_KNOWLEDGE_BASE_ID
```

The knowledge-base id is in the RemNote knowledge-base URL. Pairing writes
`~/.config/remnote-cli/connection.json` with mode 0600 and does not print the
token. Paste that token once into the plugin setting **CLI pairing token**. Set
**CLI loopback WebSocket URL** to `ws://127.0.0.1:3002`, or to the port you passed
with `--port`. Enable **Accept write operations** only when writes are intended.

```bash
remnote-cli status --text
```

A plugin that still reports id `zeefan-remnote-sdk-bridge` or the name
RemNote SDK Bridge remains accepted while that build is replaced. Plugin version
0.25.0 is compatible. Product versions do not need to match; protocol 1 and the
SDK catalog do.

See [installation](docs/guides/installation.md) and
[configuration](docs/guides/configuration.md).

## Basic usage

```bash
remnote-cli search "topic"
remnote-cli read REM_ID --content-mode structured --depth 1
remnote-cli list-children PARENT_ID
remnote-cli status --text
```

JSON is the default. `--text` is the human-readable form. A lost response does
not prove that no data changed: read the returned ids before retrying a write.

- [Command reference](docs/guides/remnote-cli-command-reference.md)
- [Development](docs/guides/development-setup.md)
- [Integration testing](docs/guides/integration-testing.md)
- [Troubleshooting](docs/guides/remnote-cli-troubleshooting.md)
- [Changelog](CHANGELOG.md)

MIT License. See [LICENSE](LICENSE).
