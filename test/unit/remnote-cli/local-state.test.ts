import { mkdtemp, readFile, writeFile, stat, chmod, symlink, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPairing,
  readConnectionConfig,
} from '../../../src/remnote-cli/client/connection-config.js';
import { LocalState } from '../../../src/remnote-cli/client/local-state.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'remnote-cli-state-'));
  directories.push(dir);
  return dir;
}
describe('private pairing and durable CLI state', () => {
  it('creates a private high-entropy pairing once and validates its schema', async () => {
    const path = join(await directory(), 'config', 'connection.json');
    expect(await createPairing('kb', 3002, path)).toBe(path);
    const config = await readConnectionConfig(path);
    expect(config.token).toMatch(/^[a-f0-9]{64}$/);
    expect(config.schemaVersion).toBe(1);
    expect(config).not.toHaveProperty('protocolVersion');
    expect(config.knowledgeBaseId).toBe('kb');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(createPairing('different', 3002, path)).rejects.toThrow();
    await expect(createPairing('kb', 65536, path)).rejects.toThrow();
    await writeFile(path, '{}');
    await expect(readConnectionConfig(path)).rejects.toThrow();
  });

  it.each([
    { protocolVersion: 1 },
    { protocolVersion: 2 },
    { schemaVersion: 2 },
    { schemaVersion: 1, protocolVersion: 2 },
  ])(
    'rejects unsupported configuration %j without rewriting bytes or exposing its token',
    async (version) => {
      const path = join(await directory(), 'connection.json');
      const token = 'e'.repeat(64);
      const raw = JSON.stringify({ ...version, token, knowledgeBaseId: 'kb', port: 3002 });
      await writeFile(path, raw, { mode: 0o600 });
      let failure: unknown;
      try {
        await readConnectionConfig(path);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain('Unsupported pairing configuration');
      expect(String(failure)).not.toContain(token);
      expect(await readFile(path, 'utf8')).toBe(raw);
      await expect(createPairing('kb', 3002, path)).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe(raw);
    }
  );

  it('preserves supported settings and reports malformed JSON without echoing file contents', async () => {
    const path = join(await directory(), 'connection.json');
    const token = 'e'.repeat(64);
    const config = {
      schemaVersion: 1,
      token,
      knowledgeBaseId: 'kb',
      port: 4321,
      settings: {
        autoTagEnabled: true,
        autoTagRemId: 'tag',
        journalPrefix: 'x',
        journalTimestamp: false,
        defaultParentId: 'parent',
      },
    };
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    expect(await readConnectionConfig(path)).toEqual(config);
    const raw = '{' + token;
    await writeFile(path, raw);
    await expect(readConnectionConfig(path)).rejects.toThrow(
      'Invalid pairing file JSON; file was not changed'
    );
    expect(await readFile(path, 'utf8')).toBe(raw);
  });

  it('refuses public, oversized and symlink pairing files', async () => {
    const dir = await directory(),
      path = join(dir, 'config.json');
    await createPairing('kb', 3002, path);
    await chmod(path, 0o644);
    await expect(readConnectionConfig(path)).rejects.toThrow('private');
    await chmod(path, 0o600);
    const link = join(dir, 'link');
    await symlink(path, link);
    await expect(readConnectionConfig(link)).rejects.toThrow();
    await writeFile(path, 'x'.repeat(8193));
    await expect(readConnectionConfig(path)).rejects.toThrow('8 KiB');
  });

  it('preserves journals across instances, hashes names and fails closed on corruption', async () => {
    const dir = await directory(),
      state = new LocalState(dir);
    expect(await state.getLocal('missing')).toBeUndefined();
    expect(await state.getLocal(undefined)).toBeUndefined();
    await state.setLocal('../unsafe-key', { ids: ['a'], pending: true });
    expect(await new LocalState(dir).getLocal('../unsafe-key')).toEqual({
      ids: ['a'],
      pending: true,
    });
    await state.setLocal('../unsafe-key', { ids: ['a'], pending: false });
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    const path = join(dir, files[0]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8')).pending).toBe(false);
    await writeFile(path, '{corrupt');
    await expect(state.getLocal('../unsafe-key')).rejects.toThrow();
    await state.setLocal('../unsafe-key', { ok: true });
    await chmod(path, 0o644);
    await expect(state.getLocal('../unsafe-key')).rejects.toThrow('private');
    await expect(state.setLocal('too-large', 'x'.repeat(4 * 1024 * 1024))).rejects.toThrow('4 MiB');
  });
});
