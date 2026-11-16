import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alignWorkspaceBaseline } from '../../../src/business/workspace/baseline.js';
import { inspectLocal, loadState, writeSnapshot } from '../../../src/business/workspace/local.js';
import * as files from '../../../src/business/workspace/files.js';
import { readPublication, recoverWorkspace } from '../../../src/business/workspace/publication.js';
import {
  hash,
  type WorkspaceBackend,
  type WorkspaceRem,
} from '../../../src/business/workspace/types.js';

let temp: string, directory: string;
beforeEach(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'remnote-source-adopt-test-')));
  directory = join(temp, 'vault');
  await mkdir(directory, { mode: 0o700 });
  vi.stubEnv('REMNOTE_CLI_CONFIG', join(temp, 'config', 'connection.json'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(temp, { recursive: true, force: true });
});
function native(id: string, extra: Partial<WorkspaceRem> = {}): WorkspaceRem {
  return {
    id,
    parent: null,
    children: [],
    text: [id],
    backText: null,
    type: null,
    document: false,
    folder: false,
    cardItem: false,
    practice: 'forward',
    enablePractice: true,
    tags: [],
    cards: [],
    ...extra,
  };
}
async function fixture() {
  const old = [
    native('doc', { document: true, children: ['question', 'old'] }),
    native('question', {
      parent: 'doc',
      backText: [],
      children: ['answer'],
      public: { retained: 'original' },
      facts: { createdAt: 1 },
      cards: [
        {
          id: 'card',
          remId: 'question',
          type: 'forward',
          createdAt: 1,
          repetitionHistory: [{ score: 1 }],
          nextRepetitionTime: 2,
          lastRepetitionTime: 1,
          timesWrongInRow: 0,
        },
      ],
    }),
    native('answer', { parent: 'question', cardItem: true }),
    native('old', { parent: 'doc' }),
    native('other', { document: true }),
    native('tag'),
  ];
  const state = await writeSnapshot(directory, 'kb', old);
  const path = state.entries.doc!.path;
  const rems = new Map(old.map((r) => [r.id, structuredClone(r)]));
  rems.get('question')!.text = ['reviewed new question'];
  rems.get('answer')!.text = ['reviewed new answer'];
  rems.get('old')!.tags = ['tag'];
  rems.get('doc')!.children = ['old', 'question', 'new'];
  rems.set(
    'new',
    native('new', { parent: 'doc', children: ['nested'], public: { retained: 'new snapshot' } })
  );
  rems.set('nested', native('nested', { parent: 'new', text: ['nested new body'] }));
  rems.get('other')!.text = ['unapproved remote change'];
  const backend = {
    identity: vi.fn(async () => ({ kbId: 'kb', writable: false })),
    read: vi.fn(async (ids: string[]) =>
      ids.filter((id) => rems.has(id)).map((id) => structuredClone(rems.get(id)!))
    ),
  } as unknown as WorkspaceBackend;
  const connect = vi.fn(async () => backend);
  return {
    old,
    state,
    path,
    rems,
    backend,
    connect,
    options: { paths: [path], acceptNativeSource: true },
  };
}
describe('explicit selected native source adoption', () => {
  it('previews then adopts only approved source and descendants, preserving old Cards/history/originals', async () => {
    const f = await fixture();
    const source = await files.readPrivate(directory, f.path);
    const otherSource = await files.readPrivate(directory, f.state.entries.other!.path);
    const preview = await alignWorkspaceBaseline(directory, f.connect, f.options);
    expect(preview).toMatchObject({ remoteWrites: 0, sourceFilesAccepted: 1, childrenAccepted: 2 });
    expect(preview.sourceChangedIds).toEqual(['answer', 'doc', 'old', 'question']);
    expect(preview.newIds).toEqual(['new', 'nested']);
    expect(preview.sourceChanges.find((change) => change.id === 'doc')).toMatchObject({
      fields: ['children'],
      addedChildren: ['new'],
      oldChildOrderChanged: true,
    });
    expect(JSON.stringify(preview)).not.toContain('reviewed new question');
    expect(await loadState(directory)).toEqual(f.state);
    expect(await files.readPrivate(directory, f.path)).toBe(source);
    await alignWorkspaceBaseline(directory, f.connect, {
      ...f.options,
      apply: true,
      planHash: preview.planHash,
    });
    const after = await inspectLocal(directory);
    expect(after.diagnostics).toEqual([]);
    expect(after.dirty).toEqual([]);
    expect(after.native.get('question')).toEqual({ ...f.old[1], text: ['reviewed new question'] });
    expect(after.native.get('doc')!.children).toEqual(['old', 'question', 'new']);
    expect(after.native.get('old')!.tags).toEqual(['tag']);
    expect(after.native.get('nested')).toEqual(f.rems.get('nested'));
    expect(after.state.entries.question!.blockId).toBe(f.state.entries.question!.blockId);
    expect(after.state.entries.question!.publicHash).toBe(f.state.entries.question!.publicHash);
    expect(after.native.get('other')).toEqual(f.old[4]);
    expect(await files.readPrivate(directory, f.state.entries.other!.path)).toBe(otherSource);
    expect(f.backend.read).not.toHaveBeenCalledWith(
      expect.arrayContaining(['other']),
      expect.anything()
    );
    f.rems.get('answer')!.text = ['later remote change'];
    await expect(alignWorkspaceBaseline(directory, f.connect, { paths: [f.path] })).rejects.toThrow(
      'drifted'
    );
  });
  it.each([
    'no-path',
    'directory',
    'mixed-mode',
    'deletion',
    'missing',
    'reparent',
    'cross-page',
    'new-document',
    'cycle',
    'card',
    'kind',
    'unknown-tag',
  ] as const)('rejects %s without publication', async (kind) => {
    const f = await fixture();
    if (kind === 'no-path') f.options.paths = [];
    if (kind === 'directory') f.options.paths = ['.'];
    if (kind === 'mixed-mode')
      Object.assign(f.options, { acceptNewParent: 'question', acceptNewChild: ['new'] });
    if (kind === 'deletion') f.rems.get('doc')!.children = ['question', 'new'];
    if (kind === 'missing') f.rems.delete('answer');
    if (kind === 'reparent') f.rems.get('answer')!.parent = 'new';
    if (kind === 'cross-page') f.rems.get('new')!.children.push('other');
    if (kind === 'new-document') f.rems.get('new')!.document = true;
    if (kind === 'cycle') f.rems.get('nested')!.children = ['new'];
    if (kind === 'card') f.rems.get('question')!.cards = [];
    if (kind === 'kind') f.rems.get('answer')!.cardItem = false;
    if (kind === 'unknown-tag') f.rems.get('new')!.tags = ['unbound'];
    await expect(alignWorkspaceBaseline(directory, f.connect, f.options)).rejects.toThrow();
    expect(await loadState(directory)).toEqual(f.state);
    expect(await readPublication(directory)).toBeUndefined();
  });
  it.each(['native', 'local', 'hash'] as const)('rejects changed %s proof', async (kind) => {
    const f = await fixture();
    const preview = await alignWorkspaceBaseline(directory, f.connect, f.options);
    let calls = 0;
    vi.spyOn(f.backend, 'read').mockImplementation(async (ids) => {
      if (++calls === 5) {
        if (kind === 'native') f.rems.get('answer')!.text = ['race'];
        if (kind === 'local')
          await files.writePrivate(
            directory,
            f.path,
            (await files.readPrivate(directory, f.path)) + '\n'
          );
      }
      return ids.map((id) => structuredClone(f.rems.get(id)!));
    });
    await expect(
      alignWorkspaceBaseline(directory, f.connect, {
        ...f.options,
        apply: true,
        planHash: kind === 'hash' ? 'a'.repeat(64) : preview.planHash,
      })
    ).rejects.toThrow(
      kind === 'hash'
        ? 'preview changed'
        : kind === 'native'
          ? 'observations changed'
          : 'Local file changed'
    );
    expect(await loadState(directory)).toEqual(f.state);
  });
  it('requires clean local source before connecting', async () => {
    const f = await fixture();
    await files.writePrivate(
      directory,
      f.path,
      (await files.readPrivate(directory, f.path)) + '\n'
    );
    await expect(alignWorkspaceBaseline(directory, f.connect, f.options)).rejects.toThrow(
      'unpublished'
    );
    expect(f.connect).not.toHaveBeenCalled();
  });
  it('can adopt two exact approved files without absorbing an unselected dependency', async () => {
    const f = await fixture();
    f.options.paths.push(f.state.entries.other!.path);
    const preview = await alignWorkspaceBaseline(directory, f.connect, f.options);
    expect(preview.sourceFilesAccepted).toBe(2);
    await alignWorkspaceBaseline(directory, f.connect, {
      ...f.options,
      apply: true,
      planHash: preview.planHash,
    });
    const after = await inspectLocal(directory);
    expect(after.diagnostics).toEqual([]);
    expect(after.native.get('other')!.text).toEqual(['unapproved remote change']);
    expect(after.state.entries.tag).toEqual(f.state.entries.tag);
  });
  it('recovers interrupted publication through the existing local ledger', async () => {
    const f = await fixture();
    const preview = await alignWorkspaceBaseline(directory, f.connect, f.options);
    const fault = vi.spyOn(files, 'linkPrivate').mockRejectedValueOnce(new Error('interruption'));
    await expect(
      alignWorkspaceBaseline(directory, f.connect, {
        ...f.options,
        apply: true,
        planHash: preview.planHash,
      })
    ).rejects.toThrow('interruption');
    expect((await readPublication(directory))!.recovery).toEqual({ kind: 'local' });
    fault.mockRestore();
    await recoverWorkspace(directory);
    const after = await inspectLocal(directory);
    expect(after.diagnostics).toEqual([]);
    expect(after.dirty).toEqual([]);
    expect(hash(after.native.get('nested'))).toBe(hash(f.rems.get('nested')));
  });
});
