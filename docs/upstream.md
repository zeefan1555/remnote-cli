# Import Provenance

Imported on 2026-10-02 from the two locally modified candidate working trees.
These are complete source snapshots, not claims that the old HEAD commits alone
contain the direct-architecture changes.

| Package | User fork | Original candidate HEAD | Complete source SHA-256 |
| --- | --- | --- | --- |
| CLI | [zeefan1555/remnote-mcp-server](https://github.com/zeefan1555/remnote-mcp-server) | `e846b1e9ff92a656593c52e9160e681dcbc42f9e` | `214de72c59a490a97c77078d618781898cce9e0411e9b1aa208b243d92ef1780` |
| Plugin | [zeefan1555/remnote-mcp-bridge](https://github.com/zeefan1555/remnote-mcp-bridge) | `a3ca8cd88e33680f49bb6c22da65ac8c142af3a6` | `a984abe885510254d73851be288f16d9e732773ba704ba682fcd87aebdc477f7` |

Source hashes come from the pre-migration candidate manifest: a SHA-256 of the
sorted JSON file list, including path, mode, content digest or deletion marker.
The original candidate manifest and dirty patches remain in the private local
evidence directory. The hashes above identify inputs, not the relocated output.

The CLI fork's parent/source is `robert7/remnote-mcp-server`. The plugin fork's
parent is `robert7/remnote-mcp-bridge`, with fork-network source
`quentintou/remnote-mcp-bridge`. Both GitHub relationships were read back during
the import. See [NOTICE](../NOTICE.md) and both package licenses.

Source import includes tracked existing files and non-ignored local additions.
Deleted old runtime files stay deleted. It excludes Git internals, dependencies,
build outputs, private live evidence and nested GitHub configuration. The root
CI replaces the old third-party reusable workflow. Package source/test assets,
lockfiles, original licenses and historical changelogs are retained.

This is a fresh independent Git repository, not a rewrite of either fork's
history. Original repositories, branches, dirty patches, PRs and installed
software have not been moved, removed or reset.
