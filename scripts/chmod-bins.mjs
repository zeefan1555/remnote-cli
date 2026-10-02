import { chmod } from 'node:fs/promises';
await chmod('dist/remnote-cli/index.js', 0o755);
