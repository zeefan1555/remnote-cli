import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  importWorkspace,
  pushWorkspace,
  readWorkspace,
} from '../../../src/business/workspace/workspace.js';
import { loadState, localStore } from '../../../src/business/workspace/local.js';
import { readPrivate, writePrivate } from '../../../src/business/workspace/files.js';
import { immutableProjection } from '../../../src/business/workspace/snapshots.js';
import {
  cardEvidence,
  editGuard,
  snapshotEditGuards,
} from '../../../src/business/workspace/relations.js';
import { renderFrontmatter } from '../../../src/business/workspace/metadata.js';
import { LocalState } from '../../../src/remnote-cli/client/local-state.js';
import {
  hash,
  type WorkspaceBackend,
  type WorkspaceRem,
} from '../../../src/business/workspace/types.js';

let scratch: string;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sync-state-contract-')));
  vi.stubEnv('REMNOTE_CLI_CONFIG', join(scratch, 'config', 'connection.json'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(scratch, { recursive: true, force: true });
});

function fixture() {
  const empty: Omit<WorkspaceRem, 'id' | 'text'> = {
    parent: null,
    children: [],
    type: null,
    backText: null,
    document: false,
    folder: false,
    cardItem: false,
    practice: 'forward',
    enablePractice: true,
    cards: [],
    tags: [],
    powerupStates: { cc: false },
  };
  const rems = new Map<string, WorkspaceRem>([
    ['doc', { ...empty, id: 'doc', text: ['Notes'], document: true, children: ['card'] }],
    [
      'card',
      {
        ...empty,
        id: 'card',
        text: ['Original question'],
        parent: 'doc',
        backText: ['Answer'],
        cards: [
          {
            id: 'stable-card',
            remId: 'card',
            type: 'forward',
            createdAt: 1,
            repetitionHistory: [],
            nextRepetitionTime: null,
            lastRepetitionTime: null,
            timesWrongInRow: null,
          },
        ],
      },
    ],
  ]);
  const snapshot = (id: string): WorkspaceRem => {
    const rem = rems.get(id)!;
    return structuredClone({
      ...rem,
      public: {
        $type: 'rem',
        id,
        parent: rem.parent,
        children: rem.children,
        text: rem.text,
        backText: rem.backText,
        type: rem.type,
      },
    });
  };
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected mutation');
  };
  const backend: WorkspaceBackend = {
    journal: localStore('model-kb'),
    identity: async () => ({ kbId: 'model-kb', writable: true }),
    enumerate: async () => [...rems.keys()].map(snapshot),
    subtree: async () => [...rems.keys()].map(snapshot),
    discover: unexpected,
    read: async (ids) => ids.map(snapshot),
    readPublic: async (ids) => ids.map((id) => snapshot(id).public!),
    guard: async (ids) => hash(ids.map((id) => immutableProjection(snapshot(id)))),
    readEditGuards: vi.fn(async (ids, codes) =>
      [...ids]
        .sort()
        .map((id) =>
          editGuard(
            snapshot(id),
            rems.get(id)!.tags!,
            Object.fromEntries(codes.map((code) => [code, rems.get(id)!.powerupStates![code]!]))
          )
        )
    ),
    setTag: vi.fn(async (id, tag, enabled) => {
      const tags = new Set(rems.get(id)!.tags);
      if (enabled) tags.add(tag);
      else tags.delete(tag);
      rems.get(id)!.tags = [...tags].sort();
    }),
    writeField: vi.fn(async (id, field, value) => {
      rems.get(id)![field] = structuredClone(value);
    }),
    create: unexpected,
    setParent: unexpected,
    setCardItem: unexpected,
    remove: unexpected,
    cardFacts: async () => [],
    existingIds: async (ids) => ids.filter((id) => rems.has(id)),
  };
  return { backend, rems };
}

async function relationFixture() {
  const f = fixture(),
    directory = join(scratch, 'vault');
  f.rems.get('doc')!.children.push('other');
  f.rems.set('other', {
    ...structuredClone(f.rems.get('card')!),
    id: 'other',
    text: ['Other question'],
    cards: f.rems.get('card')!.cards!.map((card) => ({
      ...structuredClone(card),
      id: 'other-stable-card',
      remId: 'other',
    })),
  });
  f.rems.set('label', {
    ...structuredClone(f.rems.get('doc')!),
    id: 'label',
    text: ['Label'],
    children: [],
  });
  await importWorkspace(directory, 'model-kb', async () => f.backend);
  const state = await loadState(directory),
    path = state.entries.card!.path;
  await writePrivate(
    directory,
    path,
    renderFrontmatter({
      rems: Object.fromEntries(
        ['card', 'other'].map((id) => [state.entries[id]!.blockId, { tags: ['[[Label]]'] }])
      ),
    }) + (await readPrivate(directory, path))
  );
  const before = await readWorkspace(directory, path, { outline: true });
  return { ...f, directory, state, path, localHash: before.localHash };
}

describe('sync state model implementation witnesses', () => {
  it('binds the compact receipt to full fresh boundary reads while intermediate reads stay local', async () => {
    const f = await relationFixture(),
      reads: WorkspaceRem[][] = [];
    const original = f.backend.read;
    f.backend.read = vi.fn(async (ids, options) => {
      const raw = await original(ids, options);
      if (options?.tags) reads.push(structuredClone(raw));
      return raw;
    });
    const result = (await pushWorkspace(f.directory, async () => f.backend, {
      apply: true,
      paths: [f.path],
      expectedLocalHash: f.localHash,
    })) as {
      planHash: string;
      verification: {
        planHash: string;
        localHash: string;
        nativeBefore: unknown;
        nativeAfter: unknown;
      };
    };
    expect(result).toMatchObject({ status: 'verified', complete: true, remoteWrites: 2 });
    const ids = (snapshot: WorkspaceRem[]) => snapshot.map((rem) => rem.id).sort();
    expect(ids(reads[0]!)).toEqual(['card', 'doc', 'label', 'other']);
    expect(ids(reads.at(-1)!)).toEqual(ids(reads[0]!));
    expect(reads.slice(1, -1).map(ids)).toEqual([
      ['card', 'doc', 'label'],
      ['doc', 'label', 'other'],
      ['doc', 'label', 'other'],
    ]);
    const final = new Map(reads.at(-1)!.map((rem) => [rem.id, rem]));
    const observed = cardEvidence(snapshotEditGuards(final, [...final.keys()], []));
    expect(result.verification).toMatchObject({
      planHash: result.planHash,
      localHash: f.localHash,
      nativeBefore: observed,
      nativeAfter: observed,
    });
    expect(f.backend.readEditGuards).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.verification)).not.toContain('repetitionHistory');
  });

  it('detects deferred history drift in the final full scope before publishing a compact receipt', async () => {
    const f = await relationFixture(),
      afterSecond: string[][] = [];
    const baseline = await readPrivate(f.directory, f.state.entries.card!.rawPath);
    let writes = 0;
    const tag = f.backend.setTag!,
      read = f.backend.read;
    f.backend.setTag = vi.fn(async (...args) => {
      await tag(...args);
      writes++;
      if (writes === 2)
        f.rems.get('card')!.cards![0]!.repetitionHistory = [{ score: 3, duration: 1234 }];
    });
    f.backend.read = vi.fn(async (ids, options) => {
      if (writes === 2 && options?.tags) afterSecond.push([...ids].sort());
      return read(ids, options);
    });
    const result = await pushWorkspace(f.directory, async () => f.backend, {
      apply: true,
      paths: [f.path],
      expectedLocalHash: f.localHash,
    });
    expect(result).toMatchObject({ status: 'conflict', complete: false, remoteWrites: 2 });
    expect(result).not.toHaveProperty('verification');
    expect(afterSecond).toEqual([
      ['doc', 'label', 'other'],
      ['card', 'doc', 'label', 'other'],
    ]);
    expect(await readPrivate(f.directory, f.state.entries.card!.rawPath)).toBe(baseline);
    expect((await loadState(f.directory)).pending).toBeDefined();
    expect(f.backend.setTag).toHaveBeenCalledTimes(2);
  });

  it.each(['identity', 'history', 'createdAt'] as const)(
    'rejects freshly observed Card %s drift before accepting a completed step',
    async (field) => {
      const f = await relationFixture(),
        original = f.backend.setTag!;
      f.backend.setTag = vi.fn(async (...args) => {
        await original(...args);
        const card = f.rems.get('card')!.cards![0]!;
        if (field === 'identity') card.id = 'replacement-card';
        else if (field === 'createdAt') card.createdAt = 999;
        else card.repetitionHistory = [{ score: 3 }];
      });
      expect(
        await pushWorkspace(f.directory, async () => f.backend, {
          apply: true,
          paths: [f.path],
          expectedLocalHash: f.localHash,
        })
      ).toMatchObject({ status: 'unknown', complete: false, remoteWrites: 1 });
      expect(f.backend.setTag).toHaveBeenCalledTimes(1);
      expect((await loadState(f.directory)).pending).toBeDefined();
    }
  );

  it('witnesses the no-CAS publication window after the last exact native read', async () => {
    const f = fixture(),
      directory = join(scratch, 'vault');
    await importWorkspace(directory, 'model-kb', async () => f.backend);
    const state = await loadState(directory),
      path = state.entries.card!.path;
    await writePrivate(
      directory,
      path,
      (await readPrivate(directory, path)).replace('Original question', 'Updated question')
    );
    let changed = false;
    const original = LocalState.prototype.setLocal;
    vi.spyOn(LocalState.prototype, 'setLocal').mockImplementation(async function (key, value) {
      if (
        !changed &&
        key.startsWith('workspace-v2:') &&
        (value as { state?: string }).state === 'verified'
      ) {
        f.rems.get('card')!.text = ['External edit after verification'];
        changed = true;
      }
      return original.call(this, key, value);
    });
    expect(
      await pushWorkspace(directory, async () => f.backend, { apply: true, paths: [path] })
    ).toMatchObject({ status: 'verified', complete: true, atomic: false });
    expect(changed).toBe(true);
    expect(f.rems.get('card')!.text).toEqual(['External edit after verification']);
    expect(await readPrivate(directory, path)).toContain('Updated question');
    expect(await readPrivate(directory, path)).not.toContain('External edit after verification');
    expect(f.backend.writeField).toHaveBeenCalledTimes(1);
  });

  it('does reject the same external edit when a later exact read can observe it', async () => {
    const f = fixture(),
      directory = join(scratch, 'vault');
    await importWorkspace(directory, 'model-kb', async () => f.backend);
    const state = await loadState(directory),
      path = state.entries.card!.path;
    await writePrivate(
      directory,
      path,
      (await readPrivate(directory, path)).replace('Original question', 'Updated question')
    );
    const original = f.backend.writeField;
    f.backend.writeField = vi.fn(async (...args) => {
      await original(...args);
      f.rems.get('card')!.text = ['External edit before verification'];
    });
    expect(
      await pushWorkspace(directory, async () => f.backend, { apply: true, paths: [path] })
    ).toMatchObject({ status: 'unknown', complete: false, remoteWrites: 1 });
    expect((await loadState(directory)).pending).toBeDefined();
    expect(f.backend.writeField).toHaveBeenCalledTimes(1);
  });
});
