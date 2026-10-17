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
    expect(config.knowledgeBaseId).toBe('kb');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(createPairing('different', 3002, path)).rejects.toThrow();
    await expect(createPairing('kb', 65536, path)).rejects.toThrow();
    await writeFile(path, '{}');
    await expect(readConnectionConfig(path)).rejects.toThrow();
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
