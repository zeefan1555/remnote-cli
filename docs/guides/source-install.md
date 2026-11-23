# Source installation

RemNote CLI uses a source installation. The repository is not an npm distribution
package.

## Install

```bash
git clone https://github.com/zeefan1555/remnote-cli.git
cd remnote-cli
npm ci
npm run build
./link-cli.sh
remnote-cli --version
```

`link-cli.sh` runs the tests, builds the executable and registers it in the
current npm prefix. Later builds in the checkout update the linked command.

## Remove

```bash
./unlink-cli.sh
```

## Distribution policy

- `package.json` remains private.
- Publish-only package metadata and `prepublishOnly` are removed.
- The current release version is `0.1.30`; [versioning](versioning.md) documents
  the release sequence.
- `npm run test:bin` checks the built executable version, contract and offline
  doctor.
- CI runs the executable smoke after the build and fails if the tracked tree
  changes.

The RemNote CLI Bridge plugin is installed separately in RemNote. A source CLI
update does not grant plugin, knowledge-base or note permissions.
