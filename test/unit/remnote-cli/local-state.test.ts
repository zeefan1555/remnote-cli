import { mkdtemp, readFile, writeFile, stat, chmod, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
describe('private durable CLI state', () => {
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
