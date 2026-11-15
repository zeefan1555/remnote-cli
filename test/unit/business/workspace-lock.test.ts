import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import * as kernel from 'fs-native-extensions';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withWorkspaceLock } from '../../../src/business/workspace/files.js';
import { recoverWorkspace } from '../../../src/business/workspace/workspace.js';
import { loadState, manifestStore, saveState } from '../../../src/business/workspace/local.js';
import { hash } from '../../../src/business/workspace/types.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));
vi.mock('fs-native-extensions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs-native-extensions')>()),
}));

let temporary: string;
const children = new Set<ChildProcess>();
const filesURL = pathToFileURL(resolve('src/business/workspace/files.ts')).href;

function startChild(body: string, root = temporary): ChildProcess {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', body, root, filesURL],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
  );
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

async function message(child: ChildProcess): Promise<unknown> {
  return Promise.race([
    once(child, 'message').then(([value]) => value),
    once(child, 'exit').then(([code, signal]) => {
      throw new Error(`Child exited before its checkpoint: ${code}/${signal}`);
    }),
  ]);
}

beforeEach(async () => {
  temporary = await realpath(await mkdtemp(join(tmpdir(), 'remnote-kernel-lock-test-')));
  vi.stubEnv('REMNOTE_CLI_CONFIG', join(temporary, 'config/connection.json'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    [...children].map(async (child) => {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    })
  );
  await rm(temporary, { recursive: true, force: true });
});

describe('permanent workspace kernel lock', () => {
  it('retains the identical inode and marker after normal return and a caught throw', async () => {
    let inode: number | undefined;
    await withWorkspaceLock(temporary, async () => {
      inode = (await lstat(join(temporary, '.sync/writer.lock'))).ino;
    });
    const marker = await readFile(join(temporary, '.sync/writer.lock'));
    expect((await lstat(join(temporary, '.sync/writer.lock'))).ino).toBe(inode);
    await expect(
      withWorkspaceLock(temporary, async () => {
        throw new Error('action failed');
      })
    ).rejects.toThrow('action failed');
    expect((await lstat(join(temporary, '.sync/writer.lock'))).ino).toBe(inode);
    expect(await readFile(join(temporary, '.sync/writer.lock'))).toEqual(marker);
    await expect(withWorkspaceLock(temporary, async () => 'reentered')).resolves.toBe('reentered');
  });

  it('rejects a paused writer and reacquires after its confirmed SIGKILL without deleting metadata', async () => {
    const child = startChild(`
      const { withWorkspaceLock } = await import(process.argv[2]);
      await withWorkspaceLock(process.argv[1], async () => {
        process.send('locked');
        await new Promise(() => { setInterval(() => {}, 1000); });
      });
    `);
    expect(await message(child)).toBe('locked');
    const path = join(temporary, '.sync/writer.lock');
    const before = await lstat(path),
      bytes = await readFile(path);
    child.kill('SIGSTOP');
    await expect(withWorkspaceLock(temporary, async () => 'must not enter')).rejects.toThrow(
      'locked'
    );
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    expect(await exited).toEqual([null, 'SIGKILL']);
    await expect(withWorkspaceLock(temporary, async () => 'recovered')).resolves.toBe('recovered');
    expect((await lstat(path)).ino).toBe(before.ino);
    expect(await readFile(path)).toEqual(bytes);
  }, 15000);

  it('admits exactly one simultaneous initializer and excludes additional processes', async () => {
    const peers = Array.from({ length: 4 }, () =>
      startChild(`
      const { once } = await import('node:events');
      const { withWorkspaceLock } = await import(process.argv[2]);
      process.send('ready');
      await once(process, 'message');
      try {
        await withWorkspaceLock(process.argv[1], async () => {
          process.send('acquired');
          await once(process, 'message');
        });
      } catch (error) { process.send(error.message.includes('locked') ? 'blocked' : error.message); }
      process.disconnect();
    `)
    );
    expect(await Promise.all(peers.map(message))).toEqual(Array(4).fill('ready'));
    const results = peers.map(message);
    for (const peer of peers) peer.send('go');
    const admitted = await Promise.all(results);
    expect(admitted.filter((value) => value === 'acquired')).toHaveLength(1);
    expect(admitted.filter((value) => value === 'blocked')).toHaveLength(3);
    const winner = peers[admitted.indexOf('acquired')]!;
    const ended = once(winner, 'exit');
    winner.send('release');
    expect(await ended).toEqual([0, null]);
    await expect(withWorkspaceLock(temporary, async () => true)).resolves.toBe(true);
    expect(await readdir(join(temporary, '.sync'))).toEqual(['writer.lock']);
  }, 15000);

  it.each(['before-link', 'after-link'] as const)(
    're-enters after initializer death at %s without repairing lock metadata',
    async (point) => {
      const child = startChild(`
        const fs = (await import('node:fs/promises')).default;
        const { syncBuiltinESMExports } = await import('node:module');
        const original = fs.link;
        const checkpoint = async () => {
          process.send('${point}');
          await new Promise(() => { setInterval(() => {}, 1000); });
        };
        fs.link = async (...args) => {
          if ('${point}' === 'before-link') await checkpoint();
          await original(...args);
          if ('${point}' === 'after-link') await checkpoint();
        };
        syncBuiltinESMExports();
        const { withWorkspaceLock } = await import(process.argv[2]);
        await withWorkspaceLock(process.argv[1], async () => { throw new Error('must not reach action'); });
      `);
      expect(await message(child)).toBe(point);
      const path = join(temporary, '.sync/writer.lock');
      const before = await lstat(path).catch(() => undefined);
      const marker = before ? await readFile(path) : undefined;
      expect(Boolean(before)).toBe(point === 'after-link');
      if (before) expect(before.nlink).toBeGreaterThan(1);
      const ended = once(child, 'exit');
      child.kill('SIGKILL');
      expect(await ended).toEqual([null, 'SIGKILL']);
      await expect(withWorkspaceLock(temporary, async () => 'reentered')).resolves.toBe(
        'reentered'
      );
      if (before) {
        expect((await lstat(path)).ino).toBe(before.ino);
        expect(await readFile(path)).toEqual(marker);
      }
      expect(
        (await readdir(join(temporary, '.sync'))).some((name) => name.includes('recovery'))
      ).toBe(false);
    },
    15000
  );

  it.each([
    '',
    '{',
    'unknown',
    JSON.stringify({ pid: process.pid }),
    JSON.stringify({ pid: 99999999 }),
    JSON.stringify({ pid: 1, host: 'foreign' }),
    'remnote-workspace-kernel-lock:2\n',
  ])(
    'refuses legacy, incomplete or unknown bytes unchanged before backend activation: %j',
    async (bytes) => {
      await mkdir(join(temporary, '.sync'), { mode: 0o700 });
      const path = join(temporary, '.sync/writer.lock');
      await writeFile(path, bytes, { mode: 0o600 });
      const before = await lstat(path),
        factory = vi.fn();
      await expect(recoverWorkspace(temporary, factory)).rejects.toThrow(/locked/);
      expect(factory).not.toHaveBeenCalled();
      expect((await lstat(path)).ino).toBe(before.ino);
      expect(await readFile(path, 'utf8')).toBe(bytes);
    }
  );

  it('refuses unsafe mode and symlink locks without rewriting or following them', async () => {
    await withWorkspaceLock(temporary, async () => {});
    const path = join(temporary, '.sync/writer.lock'),
      bytes = await readFile(path);
    await chmod(path, 0o644);
    const action = vi.fn();
    await expect(withWorkspaceLock(temporary, action)).rejects.toThrow(/unsafe/);
    expect((await lstat(path)).mode & 0o777).toBe(0o644);
    await rename(path, join(temporary, 'preserved-lock'));
    await symlink(join(temporary, 'preserved-lock'), path);
    await expect(withWorkspaceLock(temporary, action)).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(temporary, 'preserved-lock'))).toEqual(bytes);
  });

  it('blocks obsolete wx acquisition and keeps ownership when unrelated descriptors close', async () => {
    await withWorkspaceLock(temporary, async () => {
      const path = join(temporary, '.sync/writer.lock');
      await expect(open(path, 'wx', 0o600)).rejects.toMatchObject({ code: 'EEXIST' });
      const unrelated = await open(path, 'r+');
      expect(kernel.tryLock(unrelated.fd)).toBe(false);
      await unrelated.close();
      await expect(withWorkspaceLock(temporary, async () => {})).rejects.toThrow('locked');
    });
    await expect(withWorkspaceLock(temporary, async () => true)).resolves.toBe(true);
  });

  it('does not pass its descriptor into a child that survives the action', async () => {
    let child: ChildProcess | undefined;
    await withWorkspaceLock(temporary, async () => {
      child = startChild(`process.send('alive'); setInterval(() => {}, 1000);`);
      expect(await message(child)).toBe('alive');
    });
    expect(child!.exitCode).toBeNull();
    await expect(withWorkspaceLock(temporary, async () => 'unlocked')).resolves.toBe('unlocked');
  }, 15000);

  it('fails closed on kernel errors without invoking the action or deleting the permanent marker', async () => {
    await withWorkspaceLock(temporary, async () => {});
    const path = join(temporary, '.sync/writer.lock'),
      bytes = await readFile(path);
    const action = vi.fn();
    vi.spyOn(kernel, 'tryLock').mockImplementation(() => {
      throw new Error('ENOTSUP');
    });
    await expect(withWorkspaceLock(temporary, action)).rejects.toThrow('ENOTSUP');
    expect(action).not.toHaveBeenCalled();
    expect(await readFile(path)).toEqual(bytes);
  });

  it('refuses replacement between opening and acquiring the lock before entering the action', async () => {
    await withWorkspaceLock(temporary, async () => {});
    const path = join(temporary, '.sync/writer.lock');
    const original = fs.open,
      action = vi.fn();
    let replaced = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (args[0] === path && !replaced) {
        replaced = true;
        await rename(path, join(temporary, 'owned-lock'));
        await writeFile(path, 'foreign-lock', { mode: 0o600 });
      }
      return handle;
    });
    await expect(withWorkspaceLock(temporary, action)).rejects.toThrow('lock identity changed');
    expect(action).not.toHaveBeenCalled();
    expect(await readFile(path, 'utf8')).toBe('foreign-lock');
  });

  it('preserves both an action failure and a changed lock identity without removing the replacement', async () => {
    const path = join(temporary, '.sync/writer.lock');
    const error = await withWorkspaceLock(temporary, async () => {
      await rename(path, join(temporary, 'owned-lock'));
      await writeFile(path, 'foreign-lock', { mode: 0o600 });
      throw new Error('unknown write result');
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((item: Error) => item.message)).toEqual([
      'unknown write result',
      'Workspace lock identity changed; inspect before recovery',
    ]);
    expect(await readFile(path, 'utf8')).toBe('foreign-lock');
  });

  it('refuses a replaced root and in-place marker tampering without repairing either', async () => {
    const root = join(temporary, 'root');
    await mkdir(root, { mode: 0o700 });
    await expect(
      withWorkspaceLock(root, async () => {
        await rename(root, join(temporary, 'preserved'));
        await mkdir(root, { mode: 0o700 });
      })
    ).rejects.toThrow('lock identity changed');
    expect(await readdir(root)).toEqual([]);
    const marker = join(temporary, 'preserved/.sync/writer.lock');
    await expect(
      withWorkspaceLock(join(temporary, 'preserved'), async () => {
        await writeFile(marker, 'tampered', { mode: 0o600 });
      })
    ).rejects.toThrow('unknown or unsafe');
    expect(await readFile(marker, 'utf8')).toBe('tampered');
  });

  it('holds the same inode after relocation and resumes the public command after rename death', async () => {
    const source = join(temporary, 'source'),
      destination = join(temporary, 'destination');
    await mkdir(source, { mode: 0o700 });
    const state = {
      version: 1 as const,
      directory: source,
      kbId: 'kb',
      snapshotAt: '2026-11-16',
      complete: true,
      scope: 'library' as const,
      rootIds: [],
      globalDiscoveryComplete: false,
      errors: [],
      entries: {},
      documents: {},
      localVersions: {},
      remoteVersions: {},
    };
    await saveState(source, state);
    const entry = resolve('src/remnote-cli/index.ts');
    const body = `
      const fs = (await import('node:fs/promises')).default;
      const { syncBuiltinESMExports } = await import('node:module');
      const original = fs.rename;
      fs.rename = async (...args) => {
        await original(...args);
        if (args[0] === ${JSON.stringify(source)} && args[1] === ${JSON.stringify(destination)}) {
          process.send('renamed');
          await new Promise(() => { setInterval(() => {}, 1000); });
        }
      };
      syncBuiltinESMExports();
      process.argv = [process.execPath, ${JSON.stringify(entry)}, 'sync', 'relocate',
        ${JSON.stringify(source)}, ${JSON.stringify(destination)}];
      await import(${JSON.stringify(pathToFileURL(entry).href)});
      process.disconnect();
    `;
    const child = startChild(body);
    expect(await message(child)).toBe('renamed');
    const path = join(destination, '.sync/writer.lock');
    const before = await lstat(path),
      marker = await readFile(path);
    const receipt = await manifestStore().getLocal(`relocation:${hash(source)}`);
    expect(receipt).toMatchObject({ source, destination, inode: (await lstat(destination)).ino });
    await expect(withWorkspaceLock(destination, async () => {})).rejects.toThrow('locked');
    const ended = once(child, 'exit');
    child.kill('SIGKILL');
    expect(await ended).toEqual([null, 'SIGKILL']);
    expect(await manifestStore().getLocal(`relocation:${hash(source)}`)).toEqual(receipt);
    const resumed = startChild(`
      process.argv = [process.execPath, ${JSON.stringify(entry)}, 'sync', 'relocate',
        ${JSON.stringify(source)}, ${JSON.stringify(destination)}];
      await import(${JSON.stringify(pathToFileURL(entry).href)});
      process.disconnect();
    `);
    let stdout = '',
      stderr = '';
    resumed.stdout!.on('data', (data) => {
      stdout += data;
    });
    resumed.stderr!.on('data', (data) => {
      stderr += data;
    });
    expect(await once(resumed, 'close')).toEqual([0, null]);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, resumed: true, nativeWrites: 0 });
    expect(await loadState(destination)).toEqual({ ...state, directory: destination });
    expect((await lstat(path)).ino).toBe(before.ino);
    expect(await readFile(path)).toEqual(marker);
  }, 15000);
});
