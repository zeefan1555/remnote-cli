import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alignWorkspaceBaseline } from '../../../src/business/workspace/baseline.js';
import { bindFeedbackRoles } from '../../../src/business/workspace/feedback.js';
import { insertBaselineTags } from '../../../src/business/workspace/baseline-tags.js';
import {
  inspectLocal,
  loadState,
  saveState,
  writeSnapshot,
} from '../../../src/business/workspace/local.js';
import {
  hash,
  type WorkspaceBackend,
  type WorkspaceRem,
} from '../../../src/business/workspace/types.js';
import * as files from '../../../src/business/workspace/files.js';
import { readPublication, recoverWorkspace } from '../../../src/business/workspace/publication.js';
import { workspaceIdentity } from '../../../src/business/workspace/identity.js';

let temporary: string, directory: string;
beforeEach(async () => {
  temporary = await realpath(await mkdtemp(join(tmpdir(), 'remnote-baseline-test-')));
  directory = join(temporary, 'vault');
  await mkdir(directory, { mode: 0o700 });
  vi.stubEnv('REMNOTE_CLI_CONFIG', join(temporary, 'config', 'connection.json'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(temporary, { recursive: true, force: true });
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

async function fixture(portal = false) {
  const old = [
    native('day', { document: true, children: ['child'], tags: undefined }),
    native('child', {
      parent: 'day',
      tags: null,
      ...(portal ? { type: 6, portal: { type: null, directlyIncludedRemIds: [] } } : {}),
      cards: [
        {
          id: 'card_child',
          remId: 'child',
          type: 'forward',
          createdAt: 1,
          repetitionHistory: [{ score: 1 }],
          nextRepetitionTime: 2,
          lastRepetitionTime: 1,
          timesWrongInRow: 0,
        },
      ],
    }),
    native('home', { text: ['HOME'] }),
    native('term', { text: ['term'] }),
    native('todo', { text: ['TODO'] }),
    native('done', { text: ['DONE'] }),
  ];
  let state = await writeSnapshot(directory, 'kb', old);
  delete state.entries.child!.readonlyHash;
  await saveState(directory, state);
  const rems = new Map(old.map((rem) => [rem.id, structuredClone(rem)]));
  rems.get('day')!.tags = ['home'];
  rems.get('child')!.tags = ['term'];
  if (portal)
    rems.get('child')!.portal = { ...rems.get('child')!.portal!, query: null, filter: null };
  const backend = {
    identity: vi.fn(async () => ({ kbId: 'kb', writable: false })),
    read: vi.fn(async (ids: string[]) => ids.map((id) => structuredClone(rems.get(id)!))),
  } as unknown as WorkspaceBackend;
  const connect = vi.fn(async () => backend);
  await bindFeedbackRoles(directory, connect, { todoTagId: 'todo', doneTagId: 'done' });
  state = await loadState(directory);
  connect.mockClear();
  return { state, rems, backend, connect, path: state.entries.day!.path };
}

describe('explicit missing-observation baseline alignment', () => {
  it('previews without changes, then aligns tags to exact YAML/bullet tokens and preserves record history', async () => {
    const f = await fixture();
    const source = await files.readPrivate(directory, f.path);
    const oldRecord = await files.readPrivate(directory, f.state.entries.child!.rawPath);
    const preview = await alignWorkspaceBaseline(directory, f.connect, { paths: [f.path] });
    expect(preview).toMatchObject({ status: 'preview', remoteWrites: 0, tagsAligned: 2 });
    expect(await loadState(directory)).toEqual(f.state);
    expect(await files.readPrivate(directory, f.path)).toBe(source);
    const result = await alignWorkspaceBaseline(directory, f.connect, {
      paths: [f.path],
      apply: true,
      planHash: preview.planHash,
    });
    expect(result).toMatchObject({ status: 'aligned', remoteWrites: 0, observedHistoryKnown: 4 });
    const current = await inspectLocal(directory);
    expect(current.diagnostics).toEqual([]);
    expect(current.dirty).toEqual([]);
    expect(current.state.tagIds).toEqual({
      HOME: 'home',
      term: 'term',
      TODO: 'todo',
      DONE: 'done',
    });
    expect(await files.readPrivate(directory, f.path)).toBe(
      insertBaselineTags(
        f.path,
        source,
        ['HOME'],
        new Map([[f.state.entries.child!.blockId, ['term']]])
      )
    );
    expect(current.native.get('child')!.cards).toEqual(JSON.parse(oldRecord).cards);
    expect(workspaceIdentity(current.state).documents).toEqual(
      workspaceIdentity(f.state).documents
    );
    expect(current.state.entries.home).toEqual(f.state.entries.home);
    const noop = await alignWorkspaceBaseline(directory, f.connect, { paths: [f.path] });
    expect(noop).toMatchObject({
      tagsAligned: 0,
      sealsAligned: 0,
      portalFieldsAligned: 0,
      localFilesChanged: 0,
    });
  });

  it('fills only absent null Portal fields and establishes a native-checked readonly seal', async () => {
    const f = await fixture(true);
    const preview = await alignWorkspaceBaseline(directory, f.connect, { paths: [f.path] });
    expect(preview).toMatchObject({ portalFieldsAligned: 2, sealsAligned: 1 });
    await alignWorkspaceBaseline(directory, f.connect, {
      paths: [f.path],
      apply: true,
      planHash: preview.planHash,
    });
    const current = await inspectLocal(directory);
    expect(current.diagnostics).toEqual([]);
    expect(current.native.get('child')!.portal).toEqual({
      type: null,
      directlyIncludedRemIds: [],
      query: null,
      filter: null,
    });
    expect(current.state.entries.child!.readonlyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(['tags', 'text', 'children', 'card', 'portal', 'unknown'] as const)(
    'refuses %s drift without local publication',
    async (kind) => {
      const f = await fixture(kind === 'portal');
      if (kind === 'tags') f.rems.get('home')!.tags = ['term'];
      if (kind === 'text') f.rems.get('child')!.text = ['changed'];
      if (kind === 'children') f.rems.get('day')!.children = [];
      if (kind === 'card') f.rems.get('child')!.cards = [];
      if (kind === 'portal') f.rems.get('child')!.portal!.query = { newQuery: true };
      if (kind === 'unknown') f.rems.get('child')!.tags = null;
      await expect(
        alignWorkspaceBaseline(directory, f.connect, { paths: [f.path] })
      ).rejects.toThrow();
      expect(await loadState(directory)).toEqual(f.state);
      expect(await readPublication(directory)).toBeUndefined();
    }
  );

  it('refuses unpublished local bytes before connecting', async () => {
    const f = await fixture();
    await files.writePrivate(
      directory,
      f.path,
      (await files.readPrivate(directory, f.path)) + '\n'
    );
    await expect(alignWorkspaceBaseline(directory, f.connect)).rejects.toThrow('unpublished');
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('refuses mismatched previews and native changes during the final read', async () => {
    const f = await fixture();
    const preview = await alignWorkspaceBaseline(directory, f.connect, { paths: [f.path] });
    await expect(
      alignWorkspaceBaseline(directory, f.connect, {
        paths: [f.path],
        apply: true,
        planHash: 'a'.repeat(64),
      })
    ).rejects.toThrow('preview changed');
    let calls = 0;
    vi.spyOn(f.backend, 'read').mockImplementation(async (ids) => {
      calls++;
      if (calls === 3) f.rems.get('child')!.cards![0]!.repetitionHistory = [{ score: 2 }];
      return ids.map((id) => structuredClone(f.rems.get(id)!));
    });
    await expect(
      alignWorkspaceBaseline(directory, f.connect, {
        paths: [f.path],
        apply: true,
        planHash: preview.planHash,
      })
    ).rejects.toThrow('observations changed');
    expect(await loadState(directory)).toEqual(f.state);
  });

  it('refuses incomplete native read sets', async () => {
    const f = await fixture();
    vi.spyOn(f.backend, 'read').mockResolvedValue([]);
    await expect(alignWorkspaceBaseline(directory, f.connect)).rejects.toThrow('exact native read');
  });

  it('preserves concurrent source saves and publishes nothing', async () => {
    const f = await fixture();
    const source = await files.readPrivate(directory, f.path);
    vi.spyOn(f.backend, 'read').mockImplementation(async (ids) => {
      await files.writePrivate(directory, f.path, source + '\n');
      return ids.map((id) => structuredClone(f.rems.get(id)!));
    });
    await expect(alignWorkspaceBaseline(directory, f.connect)).rejects.toThrow(
      'Local file changed'
    );
    expect(await files.readPrivate(directory, f.path)).toBe(source + '\n');
    expect(await loadState(directory)).toEqual(f.state);
  });

  it('recovers interrupted local publication without needing a native backend', async () => {
    const f = await fixture();
    const preview = await alignWorkspaceBaseline(directory, f.connect);
    const link = files.linkPrivate;
    const fault = vi.spyOn(files, 'linkPrivate').mockImplementationOnce(async () => {
      throw new Error('synthetic link interruption');
    });
    await expect(
      alignWorkspaceBaseline(directory, f.connect, { apply: true, planHash: preview.planHash })
    ).rejects.toThrow('synthetic link interruption');
    expect((await readPublication(directory))!.recovery).toEqual({ kind: 'local' });
    fault.mockImplementation(link);
    await recoverWorkspace(directory);
    expect((await inspectLocal(directory)).diagnostics).toEqual([]);
    expect(await readPublication(directory)).toBeUndefined();
  });
});

describe('lossless source tag insertion', () => {
  it('preserves BOM, CRLF, comments, unrelated YAML and bullet whitespace', () => {
    const source =
      '\uFEFF---\r\n# keep\r\naliases: [Day] # unchanged\r\ntags: [] # tag comment\r\n---\r\n\r\n<!-- remnote:doc-root -->\r\n\r\n# day\r\n\r\n-   child  ^child\r\n';
    const next = insertBaselineTags('day.md', source, ['HOME'], new Map([['child', ['term']]]));
    expect(next).toBe(
      source.replace('tags: []', 'tags: ["HOME"]').replace('^child', '#term ^child')
    );
    expect(hash(next.replace('tags: ["HOME"]', 'tags: []').replace('#term ^child', '^child'))).toBe(
      hash(source)
    );
  });
  it('refuses hidden/absent anchors and comments inside the replaced YAML value', () => {
    expect(() =>
      insertBaselineTags('day.md', '# day\n', [], new Map([['hidden', ['term']]]))
    ).toThrow('No visible');
    expect(() =>
      insertBaselineTags('day.md', '---\ntags: [ # keep\n]\n---\n# day\n', ['HOME'], new Map())
    ).toThrow('commented');
  });
});
