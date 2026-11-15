import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relocateWorkspace } from '../../../src/business/workspace/relocate.js';
import {
  authoritativeState,
  loadState,
  manifestStore,
  publicationStore,
  saveState,
} from '../../../src/business/workspace/local.js';
import { hash, type WorkspaceState } from '../../../src/business/workspace/types.js';
import * as files from '../../../src/business/workspace/files.js';
import { LocalState } from '../../../src/remnote-cli/client/local-state.js';
import * as fs from 'node:fs/promises';
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

let temporary: string, source: string, destination: string, state: WorkspaceState;
beforeEach(async () => {
  temporary = await realpath(await mkdtemp(join(tmpdir(), 'remnote-relocate-')));
  source = join(temporary, 'source');
  destination = join(temporary, 'destination');
  vi.stubEnv('REMNOTE_CLI_CONFIG', join(temporary, 'config', 'connection.json'));
  await mkdir(source, { mode: 0o700 });
  state = {
    version: 1,
    directory: source,
    kbId: 'kb',
    snapshotAt: '2026-11-16',
    complete: true,
    scope: 'library',
    rootIds: [],
    globalDiscoveryComplete: false,
    errors: [],
    entries: {},
    documents: {},
    localVersions: {},
    remoteVersions: {},
  };
  await saveState(source, state);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(temporary, { recursive: true, force: true });
});

describe('offline workspace relocation', () => {
  it('refuses cross-device moves before recording or changing either binding', async () => {
    const original = fs.lstat;
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const info = await original(...args);
      return args[0] === temporary ? Object.assign(info, { dev: Number(info.dev) + 1 }) : info;
    });
    await expect(relocateWorkspace(source, destination)).rejects.toThrow('same filesystem');
    expect(await loadState(source)).toEqual(state);
    expect(await manifestStore().getLocal(`relocation:${hash(source)}`)).toBeUndefined();
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never removes a replacement writer lock when releasing its own lock', async () => {
    await expect(
      files.withWorkspaceLock(source, async () => {
        await rename(join(source, '.sync/writer.lock'), join(source, '.sync/owned-lock'));
        await files.writePrivate(source, '.sync/writer.lock', 'foreign lock');
      })
    ).rejects.toThrow('lock identity changed');
    expect(await files.readPrivate(source, '.sync/writer.lock')).toBe('foreign lock');
  });

  it('refuses stale locks after interruption and a changed resume destination', async () => {
    const original = LocalState.prototype.setLocal;
    vi.spyOn(LocalState.prototype, 'setLocal').mockImplementation(async function (key, value) {
      await original.call(this, key, value);
      if (key === `relocation:${hash(source)}`) throw new Error('injected');
    });
    await expect(relocateWorkspace(source, destination)).rejects.toThrow('injected');
    vi.restoreAllMocks();
    await expect(relocateWorkspace(source, join(temporary, 'different'))).rejects.toThrow(
      'different paths'
    );
    await files.writePrivate(source, '.sync/writer.lock', JSON.stringify({ pid: 99999999 }));
    await expect(relocateWorkspace(source, destination)).rejects.toThrow('locked');
    expect(await loadState(source)).toEqual(state);
  });

  it('moves the same directory and preserves dirty source, Git, identities and historical bytes', async () => {
    const before = await lstat(source);
    await mkdir(join(source, '.git'), { mode: 0o700 });
    await mkdir(join(source, '.remnote'), { mode: 0o700 });
    for (const path of ['Dirty.md', '.git/config', '.remnote/identity.json', '.sync/history.json'])
      await files.writePrivate(source, path, `unchanged bytes ${path}`);
    expect(await relocateWorkspace(source, destination)).toMatchObject({
      ok: true,
      resumed: false,
      nativeWrites: 0,
    });
    expect((await lstat(destination)).ino).toBe(before.ino);
    await expect(lstat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await loadState(destination)).toEqual({ ...state, directory: destination });
    await expect(authoritativeState(source)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const path of ['Dirty.md', '.git/config', '.remnote/identity.json', '.sync/history.json'])
      expect(await files.readPrivate(destination, path)).toBe(`unchanged bytes ${path}`);
    await expect(lstat(join(destination, '.sync/writer.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses an existing destination and an orphaned destination authority', async () => {
    await mkdir(destination, { mode: 0o700 });
    await expect(relocateWorkspace(source, destination)).rejects.toThrow('absent destination');
    await rm(destination, { recursive: true });
    await manifestStore().setLocal(`manifest:${hash(destination)}`, {
      ...state,
      directory: destination,
    });
    await expect(relocateWorkspace(source, destination)).rejects.toThrow('manifest already exists');
    expect(await loadState(source)).toEqual(state);
  });

  it('refuses pending writes, incomplete state, publication and active or unknown locks', async () => {
    for (const changes of [
      { pending: { planHash: 'a'.repeat(64), journalKey: 'pending' } },
      { complete: false },
    ]) {
      await saveState(source, { ...state, ...changes });
      await expect(relocateWorkspace(source, destination)).rejects.toThrow('complete baseline');
    }
    await saveState(source, state);
    await publicationStore().setLocal(`publication:${hash(source)}`, {
      version: 1,
      directory: source,
      next: state,
    });
    await expect(relocateWorkspace(source, destination)).rejects.toThrow('Unfinished');
    await publicationStore().setLocal(`publication:${hash(source)}`, null);
    await files.writePrivate(source, '.sync/writer.lock', JSON.stringify({ pid: process.pid }));
    await expect(relocateWorkspace(source, destination)).rejects.toThrow('locked');
    expect(JSON.parse(await files.readPrivate(source, '.sync/writer.lock'))).toEqual({
      pid: process.pid,
    });
  });

  it('refuses aliases, nested paths, unsafe modes and altered mirrors', async () => {
    await expect(relocateWorkspace(source, join(source, 'nested'))).rejects.toThrow('non-nested');
    await symlink(source, join(temporary, 'alias'));
    await expect(relocateWorkspace(join(temporary, 'alias'), destination)).rejects.toThrow(
      'not a symlink'
    );
    await chmod(source, 0o755);
    await expect(relocateWorkspace(source, destination)).rejects.toThrow('private 0700');
    await chmod(source, 0o700);
    await files.writePrivate(
      source,
      files.STATE,
      JSON.stringify({ ...state, snapshotAt: 'changed' })
    );
    await expect(relocateWorkspace(source, destination)).rejects.toThrow('mirror integrity');
  });

  it('recovers failures after receipt creation, rename, authority, mirror and old-authority removal', async () => {
    // Independent source/destination pairs avoid treating a completed operation as an interrupted one.
    for (const point of ['receipt', 'rename', 'authority', 'mirror', 'old-removal']) {
      const from = join(temporary, point),
        to = join(temporary, point + '-moved');
      await mkdir(from, { mode: 0o700 });
      await saveState(from, { ...state, directory: from });
      const originalSet = LocalState.prototype.setLocal;
      const originalDelete = LocalState.prototype.deleteLocal;
      const originalWrite = files.writePrivate;
      let hit = false;
      vi.spyOn(LocalState.prototype, 'setLocal').mockImplementation(async function (key, value) {
        if (point === 'rename' && key === `manifest:${hash(to)}` && !hit) {
          hit = true;
          throw new Error('injected');
        }
        await originalSet.call(this, key, value);
        if (
          !hit &&
          ((point === 'receipt' && key === `relocation:${hash(from)}`) ||
            (point === 'authority' && key === `manifest:${hash(to)}`))
        ) {
          hit = true;
          throw new Error('injected');
        }
      });
      vi.spyOn(files, 'writePrivate').mockImplementation(async (...args) => {
        await originalWrite(...args);
        if (!hit && point === 'mirror' && args[0] === to && args[1] === files.STATE) {
          hit = true;
          throw new Error('injected');
        }
      });
      vi.spyOn(LocalState.prototype, 'deleteLocal').mockImplementation(async function (key) {
        await originalDelete.call(this, key);
        if (!hit && point === 'old-removal' && key === `manifest:${hash(from)}`) {
          hit = true;
          throw new Error('injected');
        }
      });
      await expect(relocateWorkspace(from, to)).rejects.toThrow('injected');
      expect(hit).toBe(true);
      vi.restoreAllMocks();
      expect(await relocateWorkspace(from, to)).toMatchObject({
        ok: true,
        resumed: true,
        nativeWrites: 0,
      });
      expect(await loadState(to)).toEqual({ ...state, directory: to });
      await expect(authoritativeState(from)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('does not recognize a copied mirror or replaced target as the interrupted directory', async () => {
    const original = LocalState.prototype.setLocal;
    vi.spyOn(LocalState.prototype, 'setLocal').mockImplementation(async function (key, value) {
      if (key === `manifest:${hash(destination)}`) throw new Error('injected');
      await original.call(this, key, value);
    });
    await expect(relocateWorkspace(source, destination)).rejects.toThrow('injected');
    vi.restoreAllMocks();
    await rename(destination, join(temporary, 'preserved'));
    await mkdir(destination, { mode: 0o700 });
    await mkdir(join(destination, '.sync'), { mode: 0o700 });
    await writeFile(
      join(destination, '.sync/state.json'),
      await readFile(join(temporary, 'preserved/.sync/state.json')),
      { mode: 0o600 }
    );
    await expect(relocateWorkspace(source, destination)).rejects.toThrow('identity changed');
    expect(await authoritativeState(source)).toEqual(state);
    await expect(authoritativeState(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects changed authority and a changed mirror during interrupted recovery', async () => {
    const original = LocalState.prototype.setLocal;
    vi.spyOn(LocalState.prototype, 'setLocal').mockImplementation(async function (key, value) {
      if (key === `manifest:${hash(destination)}`) throw new Error('injected');
      await original.call(this, key, value);
    });
    await expect(relocateWorkspace(source, destination)).rejects.toThrow('injected');
    vi.restoreAllMocks();
    await manifestStore().setLocal(`manifest:${hash(destination)}`, {
      ...state,
      directory: destination,
      snapshotAt: 'foreign',
    });
    await expect(relocateWorkspace(source, destination)).rejects.toThrow(
      'destination manifest differs'
    );
    await manifestStore().deleteLocal(`manifest:${hash(destination)}`);
    await files.writePrivate(
      destination,
      files.STATE,
      JSON.stringify({ ...state, snapshotAt: 'foreign' })
    );
    await expect(relocateWorkspace(source, destination)).rejects.toThrow('mirror integrity');
  });
});
