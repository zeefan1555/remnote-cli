import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPairing } from '../../src/remnote-cli/client/connection-config.js';

let directory: string;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('guarded direct CLI integration entrypoint', () => {
  it('checks the real port, requires confirmation and never manages a daemon', async () => {
    directory = await mkdtemp(join(tmpdir(), 'remnote-wrapper-test-'));
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const port = (occupied.address() as { port: number }).port;
    const config = join(directory, 'connection.json');
    await createPairing('test-kb', port, config);
    const log = join(directory, 'npm-calls');
    await writeFile(join(directory, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$NPM_CALLS"\n', {
      mode: 0o700,
    });
    const run = (...args: string[]) =>
      spawnSync('bash', ['./run-agent-integration-test.sh', ...args], {
        cwd: resolve(import.meta.dirname, '../..'),
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          REMNOTE_CLI_CONFIG: config,
          NPM_CALLS: log,
        },
      });
    try {
      const blocked = run('--preflight-only');
      expect(blocked.status).toBe(1);
      expect(blocked.stderr).toContain('already in use');
      expect(occupied.listening).toBe(true);
      await expect(readFile(log)).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }

    expect(run('--preflight-only').status).toBe(0);
    const unconfirmed = run();
    expect(unconfirmed.status).toBe(1);
    expect(unconfirmed.stderr).toContain('Explicit --yes');
    await expect(readFile(log)).rejects.toThrow();
    expect(run('--yes', '--command', 'status', '--help').status).toBe(0);
    expect(await readFile(log, 'utf8')).toBe(
      'run build\nrun test:integration:cli -- --yes --command status --help\n'
    );
    expect(run('--suite', 'all').status).toBe(1);
    expect(run('--flashcards-only').status).toBe(1);
    expect(run('--unknown').status).toBe(1);
    expect(run('--yes', '--transactions-only', '--flashcards-only', 'HOME').status).toBe(1);
    expect(run('--yes', '--transactions-only').status).toBe(0);
    expect(await readFile(log, 'utf8')).toContain(
      'run test:integration:cli -- --yes --transactions-only'
    );
  }, 30_000);
});
