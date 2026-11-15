import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importWorkspace, pushWorkspace } from '../../../src/business/workspace/workspace.js';
import { loadState, localStore } from '../../../src/business/workspace/local.js';
import { readPrivate, writePrivate } from '../../../src/business/workspace/files.js';
import { immutableProjection } from '../../../src/business/workspace/snapshots.js';
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

describe('sync state model implementation witnesses', () => {
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
