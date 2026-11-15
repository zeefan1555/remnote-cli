import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as fileOps from '../../../src/business/workspace/files.js';
import {
  allFiles,
  assertFileSize,
  fileByteLimit,
  MAX_METADATA_BYTES,
  OFFICIAL_MANIFEST,
  readPrivate,
  STATE,
  writePrivate,
} from '../../../src/business/workspace/files.js';
import { FrozenFiles } from '../../../src/business/workspace/frozen-files.js';
import {
  authoritativeState,
  loadState,
  publicationStore,
  saveState,
} from '../../../src/business/workspace/local.js';
import { readPublication, stageSnapshot } from '../../../src/business/workspace/publication.js';
import { recoverWorkspace } from '../../../src/business/workspace/workspace.js';
import { hash, type WorkspaceState } from '../../../src/business/workspace/types.js';

const MAX_CONTENT_BYTES = 4 * 1024 * 1024;
let temporary: string, directory: string;
beforeEach(async () => {
  temporary = await realpath(await mkdtemp(join(tmpdir(), 'remnote-workspace-bounds-')));
  directory = join(temporary, 'workspace');
  await mkdir(directory, { mode: 0o700 });
  vi.stubEnv('REMNOTE_CLI_CONFIG', join(temporary, 'config', 'connection.json'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(temporary, { recursive: true, force: true });
});

function state(errors: string[] = []): WorkspaceState {
  return {
    version: 1,
    directory,
    kbId: 'synthetic-kb',
    snapshotAt: '2026-11-15T00:00:00Z',
    complete: errors.length === 0,
    scope: 'library',
    rootIds: [],
    globalDiscoveryComplete: true,
    errors,
    entries: {},
    documents: {},
  };
}

function oversizedPrettyState(): WorkspaceState {
  return state(['x'.repeat(MAX_METADATA_BYTES - 600_000), ...Array<string>(100_000).fill('')]);
}

const largeContent = () => JSON.stringify({ synthetic: 'metadata'.repeat(655360) }) + '\n';
const offline = () =>
  vi.fn(async () => {
    throw new Error('No native calls are allowed');
  });

async function interruptedPublication(
  path: string,
  content: string,
  next = state(),
  previous?: WorkspaceState
) {
  const frozen = await FrozenFiles.capture(directory);
  const install = vi.spyOn(fileOps, 'linkPrivate').mockRejectedValueOnce(new Error('interrupted'));
  await expect(
    stageSnapshot(directory, next, previous, new Map([[path, content]]), frozen)
  ).rejects.toThrow('interrupted');
  install.mockRestore();
  const publication = await readPublication(directory);
  expect(publication).toBeDefined();
  return publication!;
}

describe('workspace file purpose and final byte bounds', () => {
  it.each([STATE, OFFICIAL_MANIFEST])(
    'allows only private aggregate %s to exceed 4 MiB',
    async (path) => {
      const content = largeContent();
      expect(fileByteLimit(path)).toBe(MAX_METADATA_BYTES);
      await writePrivate(directory, path, content);
      expect(await readPrivate(directory, path)).toBe(content);
      expect((await stat(join(directory, path))).mode & 0o077).toBe(0);

      await chmod(join(directory, path), 0o644);
      await expect(readPrivate(directory, path)).rejects.toThrow('Unsafe');
      await expect(writePrivate(directory, path, content)).rejects.toThrow('Unsafe');
      await unlink(join(directory, path));
      const target = join(temporary, 'unchanged-target');
      await writeFile(target, 'original', { mode: 0o600 });
      await symlink(target, join(directory, path));
      await expect(readPrivate(directory, path)).rejects.toThrow();
      await expect(writePrivate(directory, path, content)).rejects.toThrow('Unsafe');
      expect(await readFile(target, 'utf8')).toBe('original');
    }
  );

  it.each([
    'Note.md',
    '.remnote/records/ordinary.json',
    '.sync/staging/arbitrary.json',
    '.sync/state.json.backup',
    '.remnote/originals/manifest.json.extra',
    '.remnote/originals/public/manifest.json',
    'nested/.sync/state.json',
  ])('keeps ordinary or similarly named payload %s at 4 MiB for writes and reads', async (path) => {
    const content = largeContent();
    expect(fileByteLimit(path)).toBe(MAX_CONTENT_BYTES);
    await expect(writePrivate(directory, path, content)).rejects.toThrow('safe byte bound');
    await mkdir(dirname(join(directory, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, path), content, { mode: 0o600 });
    await expect(readPrivate(directory, path)).rejects.toThrow('oversized');
  });

  it('measures UTF-8 bytes, including exact limits and one byte over them', () => {
    for (const path of ['Note.md', STATE, OFFICIAL_MANIFEST]) {
      const limit = fileByteLimit(path);
      const content = '界'.repeat(Math.floor(limit / 3)) + 'x'.repeat(limit % 3);
      expect(content.length).toBeLessThan(limit);
      expect(Buffer.byteLength(content)).toBe(limit);
      expect(() => assertFileSize(path, content)).not.toThrow();
      expect(() => assertFileSize(path, content + 'x')).toThrow('safe byte bound');
    }
  });

  it('reads, detects tampering and repairs a state mirror larger than 4 MiB without native calls', async () => {
    const next = state([largeContent()]);
    expect(Buffer.byteLength(JSON.stringify(next, null, 2))).toBeGreaterThan(MAX_CONTENT_BYTES);
    await saveState(directory, next);
    expect(await loadState(directory)).toEqual(next);
    await writePrivate(directory, STATE, JSON.stringify({ ...next, snapshotAt: 'tampered' }));
    await expect(loadState(directory)).rejects.toThrow('integrity mismatch');
    const factory = offline();
    expect(await recoverWorkspace(directory, factory)).toMatchObject({
      complete: true,
      remoteWrites: 0,
    });
    expect(await loadState(directory)).toEqual(next);
    expect(factory).not.toHaveBeenCalled();
  });

  it('prechecks pretty-printed state before staging or advancing the authoritative state', async () => {
    const previous = state();
    await saveState(directory, previous);
    const next = oversizedPrettyState();
    expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThan(MAX_METADATA_BYTES);
    expect(Buffer.byteLength(JSON.stringify(next, null, 2) + '\n')).toBeGreaterThan(
      MAX_METADATA_BYTES
    );
    const write = vi.spyOn(fileOps, 'writePrivate');
    await expect(saveState(directory, next)).rejects.toThrow('safe byte bound');
    await expect(
      stageSnapshot(
        directory,
        next,
        previous,
        new Map([['small.txt', 'small']]),
        await FrozenFiles.capture(directory)
      )
    ).rejects.toThrow('safe byte bound');
    expect(write).not.toHaveBeenCalled();
    expect(await authoritativeState(directory)).toEqual(previous);
    expect(await loadState(directory)).toEqual(previous);
    expect(await readPublication(directory)).toBeUndefined();
    await expect(stat(join(directory, '.sync/staging'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['Big.md', '.remnote/records/big.json', OFFICIAL_MANIFEST])(
    'rejects oversized final write %s before staging even an earlier small file',
    async (path) => {
      const write = vi.spyOn(fileOps, 'writePrivate');
      await expect(
        stageSnapshot(
          directory,
          state(),
          undefined,
          new Map([
            ['small.txt', 'small'],
            [path, 'x'.repeat(fileByteLimit(path) + 1)],
          ]),
          await FrozenFiles.capture(directory)
        )
      ).rejects.toThrow('safe byte bound');
      expect(write).not.toHaveBeenCalled();
      expect(await allFiles(directory)).toEqual([]);
      expect(await readPublication(directory)).toBeUndefined();
      await expect(authoritativeState(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(directory, '.sync/staging'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  );

  it('prechecks the complete publication ledger even when state and each payload fit', async () => {
    const next = state(['x'.repeat(30 * 1024 * 1024)]);
    expect(Buffer.byteLength(JSON.stringify(next, null, 2) + '\n')).toBeLessThan(
      MAX_METADATA_BYTES
    );
    const writes = new Map(
      Array.from(
        { length: 10_000 },
        (_, index) => [`record-${index}-${'n'.repeat(160)}.json`, 'small'] as const
      )
    );
    const write = vi.spyOn(fileOps, 'writePrivate');
    await expect(
      stageSnapshot(directory, next, undefined, writes, await FrozenFiles.capture(directory))
    ).rejects.toThrow('publication metadata exceeds 32 MiB');
    expect(write).not.toHaveBeenCalled();
    expect(await readPublication(directory)).toBeUndefined();
    await expect(authoritativeState(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(directory, '.sync/staging'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a noncanonical official manifest path before storing state', async () => {
    const next = {
      ...state(),
      official: {
        archiveSha256: 'a'.repeat(64),
        exportDate: 'synthetic',
        manifestPath: '.remnote/originals/other.json',
        manifestHash: 'b'.repeat(64),
        remCount: 0,
        cardCount: 0,
      },
    };
    await expect(saveState(directory, next)).rejects.toThrow();
    await expect(authoritativeState(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('bounded aggregate publication and recovery', () => {
  it('rejects an oversized tampered publication state before installing any staged file', async () => {
    const publication = await interruptedPublication('Note.md', 'small');
    publication.next = oversizedPrettyState();
    await publicationStore().setLocal(`publication:${hash(directory)}`, publication);
    const factory = offline();
    await expect(recoverWorkspace(directory, factory)).rejects.toThrow('safe byte bound');
    await expect(stat(join(directory, 'Note.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(authoritativeState(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('recovers large staged content and a large state, then freezes the published manifest', async () => {
    const content = largeContent(),
      next = state([largeContent()]);
    const publication = await interruptedPublication(OFFICIAL_MANIFEST, content, next);
    const stage = publication.writes[0]!.stage!;
    await expect(readPrivate(directory, stage)).rejects.toThrow('oversized');
    expect(await readPrivate(directory, stage, fileByteLimit(OFFICIAL_MANIFEST))).toBe(content);
    const factory = offline();
    expect(await recoverWorkspace(directory, factory)).toMatchObject({
      status: 'recovered',
      complete: true,
      remoteWrites: 0,
    });
    expect(await readPrivate(directory, OFFICIAL_MANIFEST)).toBe(content);
    expect(await loadState(directory)).toEqual(next);
    expect(await readPublication(directory)).toBeUndefined();
    const frozen = await FrozenFiles.capture(directory);
    await frozen.check();
    await writePrivate(directory, OFFICIAL_MANIFEST, content.replace('metadata', 'modified'));
    await expect(frozen.check()).rejects.toThrow('Local file changed');
    expect(factory).not.toHaveBeenCalled();
  });

  it('recovers after displacing a large aggregate and retains its private backup', async () => {
    const original = largeContent(),
      before = state();
    await stageSnapshot(
      directory,
      before,
      undefined,
      new Map([[OFFICIAL_MANIFEST, original]]),
      await FrozenFiles.capture(directory)
    );
    const changed = original.replace('metadata', 'modified');
    const next = { ...before, snapshotAt: 'later' };
    const publication = await interruptedPublication(OFFICIAL_MANIFEST, changed, next, before);
    const backup = publication.writes[0]!.backup;
    await expect(readPrivate(directory, backup)).rejects.toThrow('oversized');
    expect(await readPrivate(directory, backup, fileByteLimit(OFFICIAL_MANIFEST))).toBe(original);
    expect((await stat(join(directory, backup))).mode & 0o077).toBe(0);
    const factory = offline();
    expect(await recoverWorkspace(directory, factory)).toMatchObject({ status: 'recovered' });
    expect(await readPrivate(directory, OFFICIAL_MANIFEST)).toBe(changed);
    expect(await readPrivate(directory, backup, fileByteLimit(OFFICIAL_MANIFEST))).toBe(original);
    expect(await loadState(directory)).toEqual(next);
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(['same-size', 'oversized', 'unsafe-mode'])(
    'refuses %s aggregate staging tampering without publishing or discarding its ledger',
    async (kind) => {
      const content = largeContent();
      const publication = await interruptedPublication(OFFICIAL_MANIFEST, content);
      const stage = join(directory, publication.writes[0]!.stage!);
      if (kind === 'unsafe-mode') await chmod(stage, 0o644);
      else
        await writeFile(
          stage,
          kind === 'same-size'
            ? content.replace('metadata', 'modified')
            : 'x'.repeat(MAX_METADATA_BYTES + 1)
        );
      const factory = offline();
      await expect(recoverWorkspace(directory, factory)).rejects.toThrow(
        kind === 'same-size' ? 'integrity mismatch' : 'Unsafe or oversized'
      );
      expect(hash(await readPublication(directory))).toBe(hash(publication));
      await expect(authoritativeState(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(directory, OFFICIAL_MANIFEST))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(factory).not.toHaveBeenCalled();
    }
  );

  it('refuses a modified large displaced file and preserves the previous authority', async () => {
    const original = largeContent(),
      before = state();
    await stageSnapshot(
      directory,
      before,
      undefined,
      new Map([[OFFICIAL_MANIFEST, original]]),
      await FrozenFiles.capture(directory)
    );
    const publication = await interruptedPublication(
      OFFICIAL_MANIFEST,
      original.replace('metadata', 'modified'),
      { ...before, snapshotAt: 'later' },
      before
    );
    const backup = join(directory, publication.writes[0]!.backup);
    await writeFile(backup, original.replace('metadata', 'concurre'));
    const factory = offline();
    await expect(recoverWorkspace(directory, factory)).rejects.toThrow(
      'Concurrent content preserved'
    );
    expect(await authoritativeState(directory)).toEqual(before);
    expect(hash(await readPublication(directory))).toBe(hash(publication));
    expect(factory).not.toHaveBeenCalled();
  });
});
