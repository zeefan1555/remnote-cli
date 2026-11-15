import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diffWorkspace,
  lintWorkspace,
  importWorkspace,
  pushWorkspace as syncWorkspace,
  statusWorkspace,
  recoverWorkspace,
  planLocal,
} from '../../../src/business/workspace/workspace.js';
import * as workspace from '../../../src/business/workspace/workspace.js';
import {
  hash,
  type WorkspaceBackend,
  type WorkspaceRem,
} from '../../../src/business/workspace/types.js';
import {
  authoritativeState,
  loadState,
  localStore,
  saveState,
  documentPaths,
  inspectLocal,
} from '../../../src/business/workspace/local.js';
import { LocalState } from '../../../src/remnote-cli/client/local-state.js';
import * as fileOps from '../../../src/business/workspace/files.js';
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import {
  readPrivate,
  withWorkspaceLock,
  writePrivate,
} from '../../../src/business/workspace/files.js';
import { parseFrontmatter, renderFrontmatter } from '../../../src/business/workspace/metadata.js';
import {
  IDENTITY,
  identitySchema,
  localNodeKey,
  nativeBlockId,
  recordPath,
  shortBlockId,
} from '../../../src/business/workspace/identity.js';
import * as metadataOps from '../../../src/business/workspace/metadata.js';
import {
  contentProjection,
  immutableProjection,
} from '../../../src/business/workspace/snapshots.js';
import { reconcile } from '../../../src/business/workspace/reconcile.js';
import { readPublication } from '../../../src/business/workspace/publication.js';
import { formatWorkspace } from '../../../src/business/workspace/format.js';
import { stringify as yamlStringify } from 'yaml';

let temporary: string, directory: string;
beforeEach(async () => {
  temporary = await realpath(await mkdtemp(join(tmpdir(), 'remnote-workspace-test-')));
  directory = join(temporary, 'remnote-data');
  vi.stubEnv('REMNOTE_CLI_CONFIG', join(temporary, 'config', 'connection.json'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(temporary, { recursive: true, force: true });
});

function native(id: string, text: unknown = [id], extra: Partial<WorkspaceRem> = {}): WorkspaceRem {
  return {
    id,
    text,
    parent: null,
    children: [],
    type: null,
    backText: null,
    document: false,
    folder: false,
    cardItem: false,
    practice: 'forward',
    enablePractice: true,
    ...extra,
  };
}

function fixture() {
  const rems = new Map<string, WorkspaceRem>([
    ['home', native('home', ['HOME'], { folder: true, children: ['daily'] })],
    [
      'daily',
      native('daily', ['Today'], {
        document: true,
        parent: 'home',
        children: ['chapter', 'basic', 'opaque', 'subdoc'],
      }),
    ],
    ['chapter', native('chapter', ['Chapter'], { parent: 'daily', children: ['question'] })],
    [
      'question',
      native('question', ['Why?'], {
        parent: 'chapter',
        children: ['answer'],
        cardItem: false,
        backText: [],
        practice: 'forward',
      }),
    ],
    ['answer', native('answer', ['Because'], { parent: 'question', cardItem: true })],
    [
      'basic',
      native('basic', ['Front'], { parent: 'daily', backText: ['Back'], practice: 'forward' }),
    ],
    ['opaque', native('opaque', [{ i: 'm', text: 'Cloze', cId: 'cloze-1' }], { parent: 'daily' })],
    ['subdoc', native('subdoc', ['Child doc'], { parent: 'daily', document: true })],
  ]);
  function cardsFor(rem: WorkspaceRem): NonNullable<WorkspaceRem['cards']> {
    if (rem.cards) return rem.cards;
    // Native multiline cards require answer items; practice defaults alone do not make a card.
    return rem.enablePractice &&
      rem.practice === 'forward' &&
      Array.isArray(rem.backText) &&
      (rem.backText.length > 0 || rem.children.some((child) => rems.get(child)?.cardItem))
      ? [
          {
            id: `card_${rem.id}`,
            remId: rem.id,
            type: 'forward',
            createdAt: 1,
            repetitionHistory: [],
            nextRepetitionTime: null,
            lastRepetitionTime: null,
            timesWrongInRow: null,
          },
        ]
      : [];
  }
  function snapshot(rem: WorkspaceRem): WorkspaceRem {
    return structuredClone({
      ...rem,
      cards: cardsFor(rem),
      public: {
        ...rem.public,
        $type: 'rem',
        id: rem.id,
        parent: rem.parent,
        children: rem.children,
        text: rem.text,
        backText: rem.backText,
        type: rem.type,
      },
    });
  }
  let counter = 0;
  const calls: string[] = [];
  const backend: WorkspaceBackend = {
    journal: localStore('kb'),
    identity: vi.fn(async () => ({ kbId: 'kb', writable: true, destructive: true })),
    enumerate: vi.fn(async () => [...rems.values()].map(snapshot)),
    discover: vi.fn(async () => {
      throw new Error('Fixture discovery not configured');
    }),
    subtree: vi.fn(async (roots) => {
      const ids = [...roots];
      for (let i = 0; i < ids.length; i++) ids.push(...rems.get(ids[i]!)!.children);
      return ids.map((id) => snapshot(rems.get(id)!));
    }),
    readPublic: vi.fn(async (ids) =>
      ids.flatMap((id) => (rems.has(id) ? [snapshot(rems.get(id)!).public!] : []))
    ),
    read: vi.fn(async (ids) =>
      ids.flatMap((id) => (rems.has(id) ? [snapshot(rems.get(id)!)] : []))
    ),
    guard: vi.fn(async (ids) =>
      hash(ids.map((id) => immutableProjection(snapshot(rems.get(id)!))))
    ),
    create: vi.fn(async (markdown) => {
      const id = `created_${++counter}`;
      calls.push('create');
      rems.set(
        id,
        native(
          id,
          markdown ? ['Workspace question'] : null,
          markdown ? { cardItem: false, backText: [], practice: 'forward' } : {}
        )
      );
      return id;
    }),
    writeField: vi.fn(async (id, field, value) => {
      calls.push(`${id}:${field}`);
      rems.set(id, { ...rems.get(id)!, [field]: structuredClone(value) });
    }),
    setParent: vi.fn(async (id, parent, position) => {
      calls.push(`${id}:parent`);
      const rem = rems.get(id)!,
        p = rems.get(parent)!;
      rem.parent = parent;
      p.children.splice(position, 0, id);
    }),
    setCardItem: vi.fn(async (id, value) => {
      calls.push(`${id}:cardItem`);
      rems.get(id)!.cardItem = value;
    }),
    cardFacts: vi.fn(async (id) => {
      return cardsFor(rems.get(id)!).map(({ id, remId, type }) => ({
        id,
        hash: hash({ id, remId, type }),
      }));
    }),
    remove: vi.fn(async (id) => {
      calls.push(`${id}:delete`);
      const rem = rems.get(id)!;
      if (rem.children.length) throw new Error('Expected post-order deletion');
      if (rem.parent)
        rems.get(rem.parent)!.children = rems
          .get(rem.parent)!
          .children.filter((child) => child !== id);
      rems.delete(id);
    }),
    existingIds: vi.fn(async (ids) => ids.filter((id) => rems.has(id))),
  };
  return { backend, rems, calls };
}

async function prepare() {
  const f = fixture();
  expect(await importWorkspace(directory, 'kb', async () => f.backend)).toMatchObject({
    complete: true,
    rems: 8,
  });
  const state = await loadState(directory),
    path = state.entries.answer!.path;
  return { ...f, state, path };
}
async function edit(path: string, replace: (source: string) => string) {
  await writePrivate(directory, path, replace(await readPrivate(directory, path)));
}

// The pre-existing reconciliation fixtures explicitly exercise the whole bound graph.
const pushWorkspace: typeof syncWorkspace = (directory, backend, options = {}) =>
  syncWorkspace(directory, backend, {
    ...(options.deleteId || options.scopeRoot ? {} : { scope: 'all' }),
    ...options,
  });

describe('selected incremental sync', () => {
  it('does not open a backend for a clean changed selection or an existing empty directory', async () => {
    const f = await prepare(),
      factory = vi.fn(async () => f.backend);
    await mkdir(join(directory, 'Empty'));
    for (const options of [{}, { scope: 'all' as const, paths: ['Empty'] }])
      expect(await syncWorkspace(directory, factory, options)).toMatchObject({
        status: 'unchanged',
        remoteChecked: false,
        checkedCount: 0,
        checkedIds: [],
        remoteWrites: 0,
      });
    expect(factory).not.toHaveBeenCalled();
  });

  it('publishes A without absorbing dirty unselected B, its unanchored new note, or remote-only C', async () => {
    const f = await prepare(),
      bPath = f.state.entries.subdoc!.path;
    const b = await workspace.readWorkspace(directory, bPath);
    await workspace.saveWorkspace(
      directory,
      bPath,
      b.content.replace('Child doc', 'Dirty B') + '\n- New ordinary B\n',
      b.fileHash
    );
    await edit(f.path, (s) => s.replace('Because', 'Edited A'));
    f.rems.get('basic')!.text = ['Remote C'];
    const before = await loadState(directory),
      bBytes = await readPrivate(directory, bPath),
      bRaw = await readPrivate(directory, before.entries.subdoc!.rawPath),
      cRaw = await readPrivate(directory, before.entries.basic!.rawPath);
    const result = await syncWorkspace(directory, async () => f.backend, {
      paths: [f.path],
      apply: true,
    });
    expect(result).toMatchObject({
      status: 'verified',
      outgoing: ['answer'],
      incoming: [],
      selection: { reconcileIds: ['answer'] },
    });
    const after = await loadState(directory);
    expect(await readPrivate(directory, bPath)).toBe(bBytes);
    expect(await readPrivate(directory, before.entries.subdoc!.rawPath)).toBe(bRaw);
    expect(await readPrivate(directory, before.entries.basic!.rawPath)).toBe(cRaw);
    expect(after.entries.subdoc).toEqual(before.entries.subdoc);
    expect(after.documents[bPath]).toEqual(before.documents[bPath]);
    expect(after.localVersions).toEqual(before.localVersions);
    expect(after.remoteVersions!.subdoc).toEqual(before.remoteVersions!.subdoc);
    expect(after.remoteVersions!.basic).toEqual(before.remoteVersions!.basic);
    expect(Object.keys(after.entries)).not.toContain('created_1');
    expect(vi.mocked(f.backend.readPublic).mock.calls.flatMap(([ids]) => ids)).not.toContain(
      'basic'
    );
    const later = await syncWorkspace(directory, async () => f.backend, {
      scope: 'all',
      apply: true,
    });
    expect(later).toMatchObject({
      status: 'verified',
      incoming: ['basic'],
      outgoing: ['subdoc', 'created_1'],
    });
    expect(f.calls.filter((call) => call === 'create')).toHaveLength(1);
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    expect(await diffWorkspace(directory)).toMatchObject({ changes: [] });
  });

  it.each(['question', 'home', 'basic'] as const)(
    'does not publish the remote-only content or clock of verification dependency %s',
    async (id) => {
      const f = await prepare();
      await edit(f.path, (s) =>
        s.replace('Because', id === 'basic' ? '[Target](remnote:basic)' : 'Edited A')
      );
      f.rems.get(id)!.text = ['Remote dependency'];
      f.rems.get(id)!.public = { updatedAt: Date.now() - 1000 };
      const before = await loadState(directory),
        raw = await readPrivate(directory, before.entries[id]!.rawPath);
      const preview = await syncWorkspace(directory, async () => f.backend, { paths: [f.path] });
      expect(preview).toMatchObject({
        status: 'preview',
        incoming: [],
        selection: { verificationIds: expect.arrayContaining([id]) },
      });
      expect((await loadState(directory)).remoteVersions![id]).toEqual(before.remoteVersions![id]);
      expect(
        await syncWorkspace(directory, async () => f.backend, { paths: [f.path], apply: true })
      ).toMatchObject({ status: 'verified', incoming: [], outgoing: ['answer'] });
      const after = await loadState(directory);
      expect(await readPrivate(directory, before.entries[id]!.rawPath)).toBe(raw);
      expect(after.entries[id]).toEqual(before.entries[id]);
      expect(after.remoteVersions![id]).toEqual(before.remoteVersions![id]);
      expect(await readPrivate(directory, f.path)).not.toContain('Remote dependency');
      expect(await syncWorkspace(directory, async () => f.backend, { scope: 'all' })).toMatchObject(
        { status: 'preview', incoming: [id] }
      );
    }
  );

  it('publishes only the actual parent.children mutation for a new ordinary note', async () => {
    const f = await prepare();
    await edit(f.path, (s) => s + '\n- New ordinary note\n');
    f.rems.get('daily')!.text = ['Remote parent title'];
    f.rems.get('daily')!.public = { updatedAt: Date.now() - 1000 };
    const before = await loadState(directory);
    expect(
      await syncWorkspace(directory, async () => f.backend, { paths: [f.path], apply: true })
    ).toMatchObject({ status: 'verified', incoming: [], outgoing: ['created_1'] });
    const after = await loadState(directory),
      parent = JSON.parse(await readPrivate(directory, after.entries.daily!.rawPath));
    expect(parent.children).toContain('created_1');
    expect(parent.public.children).toContain('created_1');
    expect(parent.text).toEqual(['Today']);
    expect(parent.public.text).toEqual(['Today']);
    expect(after.remoteVersions!.daily).toEqual(before.remoteVersions!.daily);
    expect(await readPrivate(directory, f.path)).toContain('# Today');
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    expect(await syncWorkspace(directory, async () => f.backend, { scope: 'all' })).toMatchObject({
      status: 'preview',
      incoming: ['daily'],
    });
  });

  it('checks all bound IDs only in selected files when scope is all', async () => {
    const f = await prepare(),
      path = f.state.entries.subdoc!.path;
    f.rems.get('subdoc')!.text = ['Incoming selected'];
    f.rems.get('basic')!.text = ['Unselected remote'];
    expect(
      await syncWorkspace(directory, async () => f.backend, {
        scope: 'all',
        paths: [path],
        apply: true,
      })
    ).toMatchObject({
      status: 'verified',
      incoming: ['subdoc'],
      selection: { reconcileIds: ['subdoc'] },
    });
    expect(await readPrivate(directory, f.path)).not.toContain('Unselected remote');
    expect(await syncWorkspace(directory, async () => f.backend, { scope: 'all' })).toMatchObject({
      incoming: ['basic'],
    });
  });

  it('binds canonical path selection and the whole vault bytes to the exact preview', async () => {
    const f = await prepare(),
      bPath = f.state.entries.subdoc!.path;
    await edit(f.path, (s) => s.replace('Because', 'Edited A'));
    await edit(bPath, (s) => s + '\n- Still unassigned\n');
    const first = (await syncWorkspace(directory, async () => f.backend, {
      paths: [`./${f.path}`, f.path],
    })) as { planHash: string };
    const second = (await syncWorkspace(directory, async () => f.backend, { paths: [f.path] })) as {
      planHash: string;
    };
    expect(first.planHash).toBe(second.planHash);
    for (const options of [{ scope: 'all' as const, paths: [f.path] }, { paths: ['HOME'] }])
      await expect(
        syncWorkspace(directory, async () => f.backend, {
          ...options,
          apply: true,
          planHash: first.planHash,
        })
      ).rejects.toThrow('exact frozen');
    await edit(bPath, (s) => s + '\n');
    await expect(
      syncWorkspace(directory, async () => f.backend, {
        paths: [f.path],
        apply: true,
        planHash: first.planHash,
      })
    ).rejects.toThrow('exact frozen');
    expect(f.calls).toEqual([]);
  });

  it('also binds exact frozen guide and identity bytes, not just Markdown semantics', async () => {
    const f = await prepare();
    await edit(f.path, (s) => s.replace('Because', 'Edited A'));
    await writePrivate(directory, 'AGENTS.md', '# Local instructions\n');
    const preview = (await syncWorkspace(directory, async () => f.backend, {
      paths: [f.path],
    })) as { planHash: string };
    await writePrivate(directory, 'AGENTS.md', '# Updated local instructions\n');
    await expect(
      syncWorkspace(directory, async () => f.backend, {
        paths: [f.path],
        apply: true,
        planHash: preview.planHash,
      })
    ).rejects.toThrow('exact frozen');
    await writePrivate(directory, 'AGENTS.md', '# Local instructions\n');
    await edit(IDENTITY, (source) => JSON.stringify(JSON.parse(source)) + '\n');
    await expect(
      syncWorkspace(directory, async () => f.backend, {
        paths: [f.path],
        apply: true,
        planHash: preview.planHash,
      })
    ).rejects.toThrow('exact frozen');
    expect(f.calls).toEqual([]);
  });

  it.each(['../escape', '/tmp', 'HOME/*.md', 'missing', '.remnote', 'AGENTS.md'])(
    'rejects unsafe or noncontent selector %s before backend creation',
    async (path) => {
      const f = await prepare(),
        factory = vi.fn(async () => f.backend);
      if (path === 'AGENTS.md') await writePrivate(directory, path, '# Tool instructions\n');
      await expect(syncWorkspace(directory, factory, { paths: [path] })).rejects.toThrow();
      expect(factory).not.toHaveBeenCalled();
    }
  );

  it('rejects a symlink selector and an old identity lost outside selected paths before remote reads', async () => {
    const f = await prepare(),
      factory = vi.fn(async () => f.backend),
      bPath = f.state.entries.subdoc!.path;
    await edit(f.path, (s) => s.replace('Because', 'Edited A'));
    await edit(bPath, (s) => s.replace(/<!-- remnote:[^>]+ -->/, ''));
    await expect(syncWorkspace(directory, factory, { paths: [f.path] })).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
    await symlink(join(directory, f.path), join(directory, 'Alias.md'));
    await expect(syncWorkspace(directory, factory, { paths: ['Alias.md'] })).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(['missing', 'batch-failed'] as const)(
    'fails closed when a creation dependency is %s',
    async (failure) => {
      const f = await prepare();
      await edit(f.path, (s) => s + '\n- New ordinary note\n');
      if (failure === 'missing') f.rems.delete('daily');
      else
        f.backend.read = vi.fn(async () => {
          throw new Error('Dependency batch failed');
        });
      await expect(
        syncWorkspace(directory, async () => f.backend, { paths: [f.path], apply: true })
      ).rejects.toThrow();
      expect(f.calls).toEqual([]);
    }
  );

  it('previews and publishes selected layout only, preserving an unrelated pending native plan and all clocks', async () => {
    const f = await prepare(),
      bPath = f.state.entries.subdoc!.path;
    await edit(f.path, (s) => s.replace('Because', 'Unselected A'));
    await syncWorkspace(directory, async () => f.backend, { paths: [f.path] });
    const before = await loadState(directory),
      raw = await readPrivate(directory, before.entries.subdoc!.rawPath);
    const renamed = 'HOME/Personal.md';
    await rename(join(directory, bPath), join(directory, renamed));
    await edit(
      renamed,
      (s) => '---\naliases: [Personal] # Reading note\ntags: [local]\n---\n' + s + '\n'
    );
    await edit(f.path, (s) => s.replaceAll('HOME/Today/Child doc|', 'HOME/Personal|'));
    const source = await readPrivate(directory, renamed),
      aBytes = await readPrivate(directory, f.path),
      factory = vi.fn(async () => f.backend);
    const preview = (await syncWorkspace(directory, factory, { paths: [renamed] })) as {
      planHash: string;
    };
    expect(preview).toMatchObject({
      status: 'preview',
      remoteChecked: false,
      localPublished: false,
      remoteWrites: 0,
    });
    expect(await loadState(directory)).toEqual(before);
    expect(
      await syncWorkspace(directory, factory, {
        paths: [renamed],
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({
      status: 'verified',
      remoteChecked: false,
      localPublished: true,
      remoteWrites: 0,
    });
    expect(factory).not.toHaveBeenCalled();
    expect(await readPrivate(directory, renamed)).toBe(source);
    expect(await readPrivate(directory, f.path)).toBe(aBytes);
    expect(await readPrivate(directory, before.entries.subdoc!.rawPath)).toBe(raw);
    const after = await loadState(directory);
    expect(after.pending).toEqual(before.pending);
    expect(after.localVersions).toEqual(before.localVersions);
    expect(after.remoteVersions).toEqual(before.remoteVersions);
    expect(after.documents[f.path]).toEqual(before.documents[f.path]);
    expect(after.documents[renamed]).toMatchObject({ rootId: 'subdoc', fileHash: hash(source) });
    expect(after.documents).not.toHaveProperty(bPath);
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
  });

  it('keeps unselected renamed/dirty documents and their shared paths untouched', async () => {
    const f = await prepare(),
      path = f.state.entries.subdoc!.path,
      renamed = 'HOME/Later.md';
    await rename(join(directory, path), join(directory, renamed));
    await edit(renamed, (s) => s.replace('Child doc', 'Pending rename') + '\n- Pending new note\n');
    await edit(f.path, (s) =>
      s.replace('Because', 'Selected A').replaceAll('HOME/Today/Child doc|', 'HOME/Later|')
    );
    const bytes = await readPrivate(directory, renamed);
    expect(
      await syncWorkspace(directory, async () => f.backend, { paths: [f.path], apply: true })
    ).toMatchObject({ status: 'verified' });
    expect(await readPrivate(directory, renamed)).toBe(bytes);
    const after = await loadState(directory);
    expect(after.documents[path]).toEqual(f.state.documents[path]);
    expect(after.entries.subdoc).toEqual(f.state.entries.subdoc);
    expect(after.documents).not.toHaveProperty(renamed);
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
  });

  it('requires both swapped paths and publishes their identities without native reads', async () => {
    const f = await prepare(),
      other = f.state.entries.subdoc!.path,
      temporaryPath = join(directory, 'Swap.md');
    await rename(join(directory, f.path), temporaryPath);
    await rename(join(directory, other), join(directory, f.path));
    await rename(temporaryPath, join(directory, other));
    await edit(f.state.entries.home!.path, (s) =>
      s.replaceAll('HOME/Today|', 'HOME/Today/Child doc|')
    );
    await edit(other, (s) => s.replaceAll('HOME/Today/Child doc|', 'HOME/Today|'));
    const factory = vi.fn(async () => f.backend);
    await expect(
      syncWorkspace(directory, factory, { paths: [f.path], apply: true })
    ).rejects.toThrow('path swap');
    expect(
      await syncWorkspace(directory, factory, { paths: [f.path, other], apply: true })
    ).toMatchObject({ status: 'verified', localPublished: true, remoteChecked: false });
    const after = await loadState(directory);
    expect(after.entries.daily!.path).toBe(other);
    expect(after.entries.subdoc!.path).toBe(f.path);
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    expect(factory).not.toHaveBeenCalled();
  });

  it('binds layout-only previews to scope, paths, and unselected file bytes', async () => {
    const f = await prepare(),
      path = f.state.entries.subdoc!.path,
      factory = vi.fn(async () => f.backend);
    await edit(path, (s) => s + '\n');
    const preview = (await syncWorkspace(directory, factory, { paths: [path] })) as {
      planHash: string;
    };
    await expect(
      syncWorkspace(directory, factory, {
        paths: ['HOME'],
        apply: true,
        planHash: preview.planHash,
      })
    ).rejects.toThrow('exact frozen');
    await edit(f.path, (s) => s + '\n');
    await expect(
      syncWorkspace(directory, factory, { paths: [path], apply: true, planHash: preview.planHash })
    ).rejects.toThrow('exact frozen');
    expect(factory).not.toHaveBeenCalled();
    expect((await loadState(directory)).documents).toEqual(f.state.documents);
  });

  it.each(['publication', 'staging'] as const)(
    'recovers partial %s without native replay or dependency absorption',
    async (point) => {
      const f = await prepare(),
        bPath = f.state.entries.subdoc!.path;
      await edit(f.path, (s) => s.replace('Because', 'Selected A') + '\n- New selected note\n');
      await edit(bPath, (s) => s + '\n- Pending B\n');
      f.rems.get('question')!.text = ['Remote dependency'];
      const before = await loadState(directory),
        bytes = await readPrivate(directory, bPath),
        raw = await readPrivate(directory, before.entries.question!.rawPath);
      const original = LocalState.prototype.setLocal,
        link = fileOps.linkPrivate;
      const stateSpy = vi
        .spyOn(LocalState.prototype, 'setLocal')
        .mockImplementation(async function (this: LocalState, key, value) {
          if (point === 'publication' && key.startsWith('publication:') && value !== null)
            throw new Error('Injected publication failure');
          return original.call(this, key, value);
        });
      const fileSpy = vi
        .spyOn(fileOps, 'linkPrivate')
        .mockImplementation(async (root, from, to) => {
          if (point === 'staging' && to === f.path) throw new Error('Injected staging failure');
          return link(root, from, to);
        });
      expect(
        await syncWorkspace(directory, async () => f.backend, { paths: [f.path], apply: true })
      ).toMatchObject({ status: 'publication-incomplete' });
      stateSpy.mockRestore();
      fileSpy.mockRestore();
      const calls = [...f.calls];
      expect(await recoverWorkspace(directory, async () => f.backend)).toMatchObject({
        status: 'recovered',
        remoteWrites: 0,
      });
      expect(f.calls).toEqual(calls);
      expect(await readPrivate(directory, bPath)).toBe(bytes);
      expect(await readPrivate(directory, before.entries.question!.rawPath)).toBe(raw);
      expect((await loadState(directory)).remoteVersions!.question).toEqual(
        before.remoteVersions!.question
      );
      expect(await syncWorkspace(directory, async () => f.backend, { scope: 'all' })).toMatchObject(
        { incoming: ['question'], creates: 1 }
      );
    }
  );

  it('rejects unknown selected journals for both replay and layout-only publication', async () => {
    const f = await prepare(),
      path = f.state.entries.subdoc!.path;
    await edit(f.path, (s) => s.replace('Because', 'Selected A'));
    const original = f.backend.writeField;
    f.backend.writeField = vi.fn(async (id, field, value) => {
      await original(id, field, value);
      throw new Error('Lost acknowledgement');
    });
    expect(
      await syncWorkspace(directory, async () => f.backend, { paths: [f.path], apply: true })
    ).toMatchObject({ status: 'unknown' });
    const calls = [...f.calls],
      before = await loadState(directory);
    await edit(path, (s) => s + '\n');
    await expect(
      syncWorkspace(directory, async () => f.backend, { paths: [path], apply: true })
    ).rejects.toThrow('Prior write outcome');
    await expect(recoverWorkspace(directory, async () => f.backend)).rejects.toThrow(
      'not verified'
    );
    expect(await loadState(directory)).toEqual(before);
    expect(f.calls).toEqual(calls);
  });

  it.each(['missing', 'batch-failed'] as const)(
    'rejects a %s deletion dependency before any mutation',
    async (failure) => {
      const f = await prepare(),
        options = { deleteId: 'question', scopeRoot: 'daily' };
      const preview = (await syncWorkspace(directory, async () => f.backend, options)) as {
        planHash: string;
      };
      if (failure === 'missing') f.rems.delete('chapter');
      else
        f.backend.read = vi.fn(async () => {
          throw new Error('Dependency read failed');
        });
      await expect(
        syncWorkspace(directory, async () => f.backend, {
          ...options,
          apply: true,
          planHash: preview.planHash,
        })
      ).rejects.toThrow();
      expect(f.calls).toEqual([]);
    }
  );

  it('publishes bounded deletion through the current layout without absorbing dependency content', async () => {
    const f = await prepare(),
      renamed = 'HOME/Renamed.md',
      options = { deleteId: 'question', scopeRoot: 'daily' };
    await rename(join(directory, f.path), join(directory, renamed));
    await edit(f.state.entries.home!.path, (s) => s.replaceAll('HOME/Today|', 'HOME/Renamed|'));
    f.rems.get('chapter')!.text = ['Remote parent content'];
    const before = await loadState(directory);
    const preview = (await syncWorkspace(directory, async () => f.backend, options)) as {
      planHash: string;
    };
    expect(preview).toMatchObject({
      status: 'preview',
      selection: { scope: 'delete', files: [renamed], outgoingKeys: [] },
    });
    expect(
      await syncWorkspace(directory, async () => f.backend, {
        ...options,
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({ status: 'verified', deleted: ['answer', 'question'] });
    const after = await loadState(directory),
      parent = JSON.parse(await readPrivate(directory, after.entries.chapter!.rawPath));
    expect(parent.text).toEqual(['Chapter']);
    expect(parent.children).toEqual([]);
    expect(after.remoteVersions!.chapter).toEqual(before.remoteVersions!.chapter);
    expect(after.documents[renamed]).toBeDefined();
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    expect(await syncWorkspace(directory, async () => f.backend, { scope: 'all' })).toMatchObject({
      status: 'preview',
      incoming: ['chapter'],
    });
  });

  it.each(['apply', 'recover'] as const)(
    'publishes deletion attributes through %s without dropping surviving attributes or replaying deletes',
    async (mode) => {
      const f = await prepare(),
        options = { deleteId: 'question', scopeRoot: 'daily' },
        kept = {
          title: 'Kept display title',
          aliases: ['Kept alias'],
          tags: ['kept-tag'],
          rems: { [f.state.entries.chapter!.blockId]: { content: 'text' as const } },
        };
      await edit(f.path, (source) => {
        const parsed = parseFrontmatter(f.path, source);
        return (
          renderFrontmatter({
            ...kept,
            rems: {
              ...kept.rems,
              [f.state.entries.question!.blockId]: { content: 'multiline' },
              [f.state.entries.answer!.blockId]: { content: 'text' },
            },
          }) +
          `<!-- remnote:${parsed.documentKey} -->\n\n` +
          parsed.body
        );
      });
      const source = await readPrivate(directory, f.path),
        otherPath = f.state.entries.subdoc!.path,
        otherSource = await readPrivate(directory, otherPath);
      expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
      const preview = (await syncWorkspace(directory, async () => f.backend, options)) as {
        planHash: string;
      };
      const original = LocalState.prototype.setLocal;
      const interrupted =
        mode === 'recover'
          ? vi.spyOn(LocalState.prototype, 'setLocal').mockImplementation(async function (
              this: LocalState,
              key,
              value
            ) {
              if (key.startsWith('publication:') && value !== null)
                throw new Error('Injected failure before local publication');
              return original.call(this, key, value);
            })
          : undefined;
      const result = await syncWorkspace(directory, async () => f.backend, {
        ...options,
        apply: true,
        planHash: preview.planHash,
      });
      interrupted?.mockRestore();
      expect(f.calls).toEqual(['answer:delete', 'question:delete']);
      if (mode === 'recover') {
        expect(result).toMatchObject({ status: 'publication-incomplete' });
        const state = await loadState(directory);
        expect(await localStore('kb').getLocal(state.pending!.journalKey)).toMatchObject({
          state: 'verified',
          steps: { 'answer:delete': 'verified', 'question:delete': 'verified' },
          final: { deleted: ['answer', 'question'] },
        });
        expect(await readPublication(directory)).toBeUndefined();
        expect(await readPrivate(directory, f.path)).toBe(source);
        expect(await recoverWorkspace(directory, async () => f.backend)).toMatchObject({
          status: 'recovered',
          complete: true,
          remoteWrites: 0,
        });
        expect(f.calls).toEqual(['answer:delete', 'question:delete']);
      } else expect(result).toMatchObject({ status: 'verified', deleted: ['answer', 'question'] });
      const state = await loadState(directory);
      expect(state.pending).toBeUndefined();
      expect(state.entries.question).toBeUndefined();
      expect(state.entries.answer).toBeUndefined();
      expect(state.entries.chapter!.blockId).toBe(f.state.entries.chapter!.blockId);
      expect(f.rems.get('chapter')!.children).toEqual([]);
      expect(f.rems.get('daily')!.text).toEqual(['Today']);
      expect(parseFrontmatter(f.path, await readPrivate(directory, f.path)).attributes).toEqual(
        kept
      );
      expect(await readPrivate(directory, otherPath)).toBe(otherSource);
      expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    }
  );

  it('rejects unrelated orphan deletion attributes before any remote access', async () => {
    const f = await prepare(),
      factory = vi.fn(async () => f.backend);
    await edit(
      f.path,
      (source) =>
        renderFrontmatter({ rems: { 'missing-block': { content: 'multiline' } } }) + source
    );
    expect(await lintWorkspace(directory)).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'ATTRIBUTE_NODE_MISSING' })],
    });
    await expect(
      syncWorkspace(directory, factory, { deleteId: 'question', scopeRoot: 'daily' })
    ).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });

  it('recovers verified deletion without absorbing its parent dependency or replaying remove', async () => {
    const f = await prepare(),
      options = { deleteId: 'question', scopeRoot: 'daily' };
    f.rems.get('chapter')!.text = ['Remote parent content'];
    const preview = (await syncWorkspace(directory, async () => f.backend, options)) as {
      planHash: string;
    };
    const original = LocalState.prototype.setLocal;
    const spy = vi.spyOn(LocalState.prototype, 'setLocal').mockImplementation(async function (
      this: LocalState,
      key,
      value
    ) {
      if (key.startsWith('publication:') && value !== null)
        throw new Error('Injected local authority failure');
      return original.call(this, key, value);
    });
    expect(
      await syncWorkspace(directory, async () => f.backend, {
        ...options,
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({ status: 'publication-incomplete' });
    spy.mockRestore();
    const calls = [...f.calls];
    expect(await recoverWorkspace(directory, async () => f.backend)).toMatchObject({
      status: 'recovered',
      remoteWrites: 0,
    });
    expect(f.calls).toEqual(calls);
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    expect(await syncWorkspace(directory, async () => f.backend, { scope: 'all' })).toMatchObject({
      status: 'preview',
      incoming: ['chapter'],
    });
  });
});

describe('human Markdown workspace', () => {
  it('extends colliding short identities without changing an already allocated identity', () => {
    const first = shortBlockId('synthetic-native-id', new Set());
    const next = shortBlockId('synthetic-native-id', new Set([first]));
    const third = shortBlockId('synthetic-native-id', new Set([first, next]));
    expect(first).toMatch(/^r-[a-f0-9]{8}$/);
    expect(next).toBe(
      first + createHash('sha256').update('synthetic-native-id').digest('hex').slice(8, 10)
    );
    expect(third).toHaveLength(next.length + 2);
    expect(shortBlockId('synthetic-native-id', new Set())).toBe(first);
  });

  it('publishes no default YAML, one hidden root binding and a complete tracked identity map', async () => {
    const f = await prepare();
    const source = await readPrivate(directory, f.path);
    expect(source).toMatch(/^<!-- remnote:[A-Za-z0-9-]{1,16} -->\n\n# Today\n/);
    expect(source).not.toContain('schema:');
    expect(source).not.toContain('Read only:');
    expect(source).not.toContain('.remnote/records/');
    const identity = JSON.parse(await readPrivate(directory, IDENTITY)) as {
      documents: Record<string, { blocks: Record<string, string> }>;
    };
    expect(identity).toMatchObject({ schema: 'remnote-identity/1', kbId: 'kb' });
    expect(
      Object.values(identity.documents)
        .flatMap((doc) => Object.values(doc.blocks))
        .sort()
    ).toEqual(Object.keys(f.state.entries).sort());
    expect(JSON.stringify(identity)).not.toContain(directory);
  });

  it('accepts ordinary unanchored new bullets but fails the entire batch when an old anchor is lost', async () => {
    const f = await prepare();
    await edit(f.path, (source) => source + '\n- A plain new note\n');
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    expect(await pushWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
      status: 'verified',
    });
    expect(f.rems.get('created_1')!.text).toEqual(['A plain new note']);
    expect(await readPrivate(directory, f.path)).toMatch(/A plain new note \^[A-Za-z0-9-]+/);
    f.calls.length = 0;
    await edit(
      f.path,
      (source) =>
        source.replace(`^${f.state.entries.answer!.blockId}`, '') + '\n- Another new note\n'
    );
    const factory = vi.fn(async () => f.backend);
    await expect(pushWorkspace(directory, factory, { apply: true })).rejects.toThrow('MISSING_ID');
    expect(factory).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });

  it('rejects identity tampering before opening a native connection', async () => {
    const f = await prepare();
    await edit('.remnote/identity.json', (source) => source.replace('"answer"', '"forged"'));
    const factory = vi.fn(async () => f.backend);
    await expect(pushWorkspace(directory, factory, { apply: true })).rejects.toThrow('IDENTITY');
    expect(factory).not.toHaveBeenCalled();
  });

  it('retains the complete identity mapping in tracked files without trusting a clone as a bound workspace', async () => {
    const f = await prepare(),
      clone = join(temporary, 'portable-clone');
    await mkdir(clone, { mode: 0o700 });
    const paths = [
      IDENTITY,
      ...Object.keys(f.state.documents),
      ...Object.values(f.state.entries).map((entry) => entry.rawPath),
    ];
    for (const path of paths) await writePrivate(clone, path, await readPrivate(directory, path));
    vi.stubEnv('REMNOTE_CLI_CONFIG', join(temporary, 'fresh-machine', 'connection.json'));
    const identity = identitySchema.parse(JSON.parse(await readPrivate(clone, IDENTITY)));
    const restored = new Map<string, { documentKey: string; rootId: string; blockId: string }>();
    for (const path of paths.filter((path) => path.endsWith('.md'))) {
      const marker = parseFrontmatter(path, await readPrivate(clone, path)).documentKey!;
      const document = identity.documents[marker]!;
      expect(document.blocks[marker]).toBe(document.rootId);
      for (const [blockId, id] of Object.entries(document.blocks)) {
        expect(JSON.parse(await readPrivate(clone, recordPath(id))).id).toBe(id);
        expect(restored.has(id)).toBe(false);
        restored.set(id, { documentKey: marker, rootId: document.rootId, blockId });
      }
    }
    expect([...restored.keys()].sort()).toEqual(Object.keys(f.state.entries).sort());
    for (const [id, binding] of restored) {
      const entry = f.state.entries[id]!;
      expect(binding.blockId).toBe(entry.blockId);
      expect(binding.rootId).toBe(f.state.documents[entry.path]!.rootId);
    }
    expect(JSON.stringify(identity)).not.toContain(temporary);
    const factory = vi.fn(async () => f.backend);
    await expect(pushWorkspace(clone, factory, { apply: true })).rejects.toThrow(
      'No sync manifest'
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it('creates explicit multiline questions with ordinary unanchored answer bullets', async () => {
    const f = await prepare();
    await edit(
      f.path,
      (source) =>
        renderFrontmatter({ rems: { 'my-question': { content: 'multiline' } } }) +
        source +
        '\n- A new question ^my-question\n  - First answer\n  - Second answer\n'
    );
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    expect(await pushWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
      status: 'verified',
    });
    expect(f.rems.get('created_1')).toMatchObject({
      text: ['A new question'],
      children: ['created_2', 'created_3'],
    });
    expect(f.rems.get('created_2')).toMatchObject({ text: ['First answer'], cardItem: true });
    expect(f.rems.get('created_3')).toMatchObject({ text: ['Second answer'], cardItem: true });
    const source = await readPrivate(directory, f.path);
    expect(source).toMatch(/First answer \^[A-Za-z0-9-]+/);
    expect(source).toMatch(/Second answer \^[A-Za-z0-9-]+/);
  });

  it.each(['missing', 'duplicate', 'forged'] as const)(
    'rejects a %s document comment before any native connection',
    async (kind) => {
      const f = await prepare();
      await edit(f.path, (source) =>
        kind === 'missing'
          ? source.replace(/^<!--.*-->\n\n/, '')
          : kind === 'duplicate'
            ? source + `\n<!-- remnote:${f.state.entries.daily!.blockId} -->\n`
            : source.replace(f.state.entries.daily!.blockId, 'unbound-root')
      );
      const factory = vi.fn(async () => f.backend);
      await expect(pushWorkspace(directory, factory, { apply: true })).rejects.toThrow();
      expect(factory).not.toHaveBeenCalled();
    }
  );

  it('keeps native unknown/false/null facts when attributes are absent and rejects unsupported attributes', async () => {
    const f = await prepare();
    const original = await readPrivate(directory, f.state.entries.answer!.rawPath);
    await edit(
      f.path,
      (source) =>
        renderFrontmatter({ title: 'Local title', aliases: ['Alias'], tags: ['local'] }) + source
    );
    expect(await pushWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
      status: 'verified',
      remoteWrites: 0,
    });
    expect(await readPrivate(directory, f.state.entries.answer!.rawPath)).toBe(original);
    for (const attrs of ['tags: []', 'native: {}', 'readOnly: false', 'content: basic']) {
      const source = await readPrivate(directory, f.path),
        header = parseFrontmatter(f.path, source);
      await writePrivate(
        directory,
        f.path,
        `---\nrems:\n  ${f.state.entries.answer!.blockId}:\n    ${attrs}\n---\n\n<!-- remnote:${header.documentKey} -->\n\n${header.body}`
      );
      const factory = vi.fn(async () => f.backend);
      await expect(pushWorkspace(directory, factory, { apply: true })).rejects.toThrow(
        'YAML_METADATA'
      );
      expect(factory).not.toHaveBeenCalled();
      await writePrivate(directory, f.path, source);
    }
  });

  it('scopes human-chosen new anchors per document', async () => {
    const f = await prepare();
    await edit(f.path, (source) => source + '\n- One ^my-note\n');
    await edit(f.state.entries.subdoc!.path, (source) => source + '\n- Two ^my-note\n');
    const plan = planLocal(await inspectLocal(directory));
    expect(plan.changes.map((change) => change.key).sort()).toEqual(
      [localNodeKey('daily', 'my-note'), localNodeKey('subdoc', 'my-note')].sort()
    );
  });

  it('excludes only exact guide paths from Markdown parsing while freezing their bytes', async () => {
    const f = await prepare();
    const paths = ['AGENTS.md', '.agents/skills/remnote-data/SKILL.md'];
    for (const path of paths) await writePrivate(directory, path, '# Synthetic guide\n');
    const local = await inspectLocal(directory);
    expect(local.diagnostics).toEqual([]);
    const frozen = await local.inputs.freeze();
    for (const path of paths) expect(frozen.hashes()[path]).toBe(hash('# Synthetic guide\n'));
    for (const path of ['README.md', 'Other/SKILL.md']) {
      await writePrivate(directory, path, '# Not a bound document\n');
      const factory = vi.fn(async () => f.backend);
      await expect(pushWorkspace(directory, factory, { apply: true })).rejects.toThrow(
        'ROOT_BINDING'
      );
      expect(factory).not.toHaveBeenCalled();
      await rm(join(directory, path));
    }
  });

  it('keeps a multiline question editable when its verified non-answer children are reference portals', async () => {
    const f = fixture();
    for (let index = 2; index <= 8; index++) {
      const id = `answer-${index}`;
      f.rems.get('question')!.children.push(id);
      f.rems.set(
        id,
        native(id, [`Knowledge point ${index}`], { parent: 'question', cardItem: true })
      );
    }
    f.rems.get('question')!.children.push('references');
    f.rems.set(
      'references',
      native('references', [], {
        type: 6,
        parent: 'question',
        children: ['wrapper'],
        portal: { type: 4, directlyIncludedRemIds: ['wrapper'] },
      })
    );
    f.rems.set(
      'wrapper',
      native('wrapper', [], {
        type: 6,
        parent: 'references',
        portal: { type: null, directlyIncludedRemIds: ['basic'] },
      })
    );
    await importWorkspace(directory, 'kb', async () => f.backend);
    const state = await loadState(directory);
    const beforeCards = await f.backend.cardFacts('question');
    const path = state.entries.question!.path;
    const source = await readPrivate(directory, path);
    expect(state.entries.question!.editable).toBe(true);
    expect(source).not.toContain('Read only:');
    expect(source).not.toContain('反向链接');
    expect(source).toContain('只读');
    expect(source).not.toContain(`^${state.entries.wrapper!.blockId}`);
    const wrapperBefore = await readPrivate(directory, state.entries.wrapper!.rawPath);
    await edit(path, (source) => source.replace('Because ^', 'Answer revised ^'));
    expect(await pushWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
      status: 'verified',
      updated: ['answer'],
    });
    expect(f.rems.get('question')!.children).toEqual([
      'answer',
      ...Array.from({ length: 7 }, (_, index) => `answer-${index + 2}`),
      'references',
    ]);
    expect(f.rems.get('references')!.children).toEqual(['wrapper']);
    expect(await f.backend.cardFacts('question')).toEqual(beforeCards);
    expect(await readPrivate(directory, state.entries.wrapper!.rawPath)).toBe(wrapperBefore);
    expect(f.calls).toEqual(['answer:text']);
  });

  it.each([
    'text',
    'backText',
    'cards',
    'membership',
    'unknown-parent',
    'reference-target',
    'cross-document-target',
  ] as const)(
    'keeps an unknown portal wrapper visible when %s facts do not justify folding',
    async (kind) => {
      const f = fixture();
      f.rems.get('question')!.children.push('references');
      f.rems.set(
        'references',
        native('references', [], {
          type: 6,
          parent: 'question',
          children: ['wrapper'],
          portal: {
            type: kind === 'unknown-parent' ? 99 : 4,
            directlyIncludedRemIds: kind === 'membership' ? [] : ['wrapper'],
          },
        })
      );
      f.rems.set(
        'wrapper',
        native('wrapper', kind === 'text' ? ['Own native text'] : [], {
          type: 6,
          parent: 'references',
          backText: kind === 'backText' ? ['Own back'] : null,
          cards:
            kind === 'cards'
              ? [
                  {
                    id: 'wrapper-card',
                    remId: 'wrapper',
                    type: 'forward',
                    createdAt: 1,
                    repetitionHistory: [],
                    nextRepetitionTime: null,
                    lastRepetitionTime: null,
                    timesWrongInRow: null,
                  },
                ]
              : [],
          portal: { type: null, directlyIncludedRemIds: ['basic'] },
        })
      );
      if (kind === 'reference-target') f.rems.get('answer')!.text = [{ i: 'q', _id: 'wrapper' }];
      if (kind === 'cross-document-target') {
        f.rems.get('subdoc')!.children.push('outside-reference');
        f.rems.set(
          'outside-reference',
          native('outside-reference', [{ i: 'q', _id: 'wrapper' }], { parent: 'subdoc' })
        );
      }
      await importWorkspace(directory, 'kb', async () => f.backend);
      const state = await loadState(directory),
        path = state.entries.wrapper!.path;
      const source = await readPrivate(directory, path);
      expect(source).toContain(`^${state.entries.wrapper!.blockId}`);
      expect(source).not.toContain('反向链接');
      if (kind === 'reference-target') {
        expect(source).toContain(`#^${state.entries.wrapper!.blockId}|`);
        expect(
          (await inspectLocal(directory)).parsed
            .get(path)!
            .nodes.find((node) => node.key === 'answer')!.text
        ).toEqual([{ i: 'q', _id: 'wrapper' }]);
      }
      if (kind === 'cross-document-target') {
        const referencePath = state.entries['outside-reference']!.path;
        expect(referencePath).not.toBe(path);
        expect(await readPrivate(directory, referencePath)).toContain(
          `#^${state.entries.wrapper!.blockId}|`
        );
        expect(
          (await inspectLocal(directory)).parsed
            .get(referencePath)!
            .nodes.find((node) => node.key === 'outside-reference')!.text
        ).toEqual([{ i: 'q', _id: 'wrapper' }]);
      }
      if (kind === 'unknown-parent') expect(state.entries.question!.editable).toBe(false);
      await edit(path, (source) =>
        source.replace(new RegExp(` \\^${state.entries.wrapper!.blockId}$`, 'm'), '')
      );
      const factory = vi.fn(async () => f.backend);
      await expect(pushWorkspace(directory, factory, { apply: true })).rejects.toThrow(
        'MISSING_ID'
      );
      expect(factory).not.toHaveBeenCalled();
    }
  );
});

describe('single-invocation sync', () => {
  it('plans and applies a local edit without a previous preview, preserving native cards', async () => {
    const f = await prepare();
    const cards = await f.backend.cardFacts('question');
    await edit(f.path, (source) => source.replace('Because ^', 'One shot ^'));
    expect(await pushWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
      status: 'verified',
      updated: ['answer'],
      remoteWrites: 1,
      globalDiscoveryComplete: false,
    });
    expect(f.rems.get('answer')!.text).toEqual(['One shot']);
    expect(await f.backend.cardFacts('question')).toEqual(cards);
    expect((await loadState(directory)).pending).toBeUndefined();
    expect(await pushWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
      status: 'unchanged',
      remoteWrites: 0,
    });
  });

  it('parses each source YAML once while still validating every native baseline', async () => {
    const f = await prepare();
    const parse = vi.spyOn(metadataOps, 'parseFrontmatter');
    const read = vi.spyOn(fileOps, 'readPrivate');
    const context = await inspectLocal(directory);
    expect(context.diagnostics).toEqual([]);
    expect(parse).toHaveBeenCalledTimes(Object.keys(f.state.documents).length);
    for (const entry of Object.values(f.state.entries))
      expect(read.mock.calls.filter(([, path]) => path === entry.rawPath)).toHaveLength(1);
    const frozen = await context.inputs.freeze();
    for (const entry of Object.values(f.state.entries))
      expect(read.mock.calls.filter(([, path]) => path === entry.rawPath)).toHaveLength(1);
    await frozen.check();
    for (const entry of Object.values(f.state.entries))
      expect(read.mock.calls.filter(([, path]) => path === entry.rawPath)).toHaveLength(2);
  });

  it('reuses unchanged source parsing for offline save but freshly hashes publication boundaries', async () => {
    const f = await prepare();
    const source = await readPrivate(directory, f.path);
    const parse = vi.spyOn(metadataOps, 'parseFrontmatter');
    const read = vi.spyOn(fileOps, 'readPrivate');
    expect(
      await workspace.saveWorkspace(
        directory,
        f.path,
        source.replace('Because ^', 'Offline ^'),
        hash(source)
      )
    ).toMatchObject({
      status: 'saved',
      remoteWrites: 0,
    });
    expect(parse).toHaveBeenCalledTimes(Object.keys(f.state.documents).length + 1);
    for (const entry of Object.values(f.state.entries))
      expect(read.mock.calls.filter(([, path]) => path === entry.rawPath)).toHaveLength(5);
    expect(f.calls).toEqual([]);
  });

  it('keeps the whole one-shot invocation offline when another document fails lint', async () => {
    const f = await prepare();
    await edit(f.path, (source) => source.replace('Because ^', 'One shot ^'));
    await edit(f.state.entries.subdoc!.path, (source) => source + '\n| unsupported | table |\n');
    const factory = vi.fn(async () => f.backend);
    await expect(pushWorkspace(directory, factory, { apply: true })).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });

  it.each(['markdown', 'native'] as const)(
    'freshly rejects same-size %s tampering after planning even with restored mtime',
    async (kind) => {
      const f = await prepare();
      await edit(f.path, (source) => source.replace('Because ^', 'One shot ^'));
      const originalGuard = f.backend.guard;
      f.backend.guard = vi.fn(async (ids) => {
        const guard = await originalGuard(ids);
        const target = kind === 'markdown' ? f.path : f.state.entries.answer!.rawPath;
        const absolute = join(directory, target);
        const before = await stat(absolute);
        await edit(target, (source) =>
          source.replace(
            kind === 'markdown' ? 'One shot' : 'Because',
            kind === 'markdown' ? 'Tampered' : 'Altered'
          )
        );
        await utimes(absolute, before.atime, before.mtime);
        return guard;
      });
      expect(await pushWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
        status: 'conflict',
        complete: false,
        steps: {},
        error: expect.stringMatching(/Local (file|Markdown) changed/),
      });
      expect(f.calls).toEqual([]);
    }
  );

  it.each(['file-symlink', 'parent-symlink', 'permissions', 'oversized'] as const)(
    'rejects %s introduced after inspection before the first native mutation',
    async (kind) => {
      const f = await prepare();
      await edit(f.path, (source) => source.replace('Because ^', 'One shot ^'));
      const originalGuard = f.backend.guard;
      let calls = 0;
      f.backend.guard = vi.fn(async (ids) => {
        const guard = await originalGuard(ids);
        if (++calls !== 2) return guard;
        const target = join(directory, f.state.entries.answer!.rawPath);
        if (kind === 'permissions') await chmod(target, 0o644);
        else if (kind === 'oversized') await writeFile(target, 'x'.repeat(4 * 1024 * 1024 + 1));
        else {
          const path = kind === 'file-symlink' ? target : join(directory, '.remnote/records');
          await rename(path, path + '-original');
          await symlink(path + '-original', path);
        }
        return guard;
      });
      expect(await pushWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
        status: 'conflict',
        complete: false,
        steps: {},
      });
      expect(f.calls).toEqual([]);
    }
  );

  it('does not overwrite a state mirror tampered with while the native guard is pending', async () => {
    const f = await prepare();
    await edit(f.path, (source) => source.replace('Because ^', 'One shot ^'));
    const originalGuard = f.backend.guard;
    let tampered = '';
    f.backend.guard = vi.fn(async (ids) => {
      const guard = await originalGuard(ids);
      const source = await readPrivate(directory, '.sync/state.json');
      tampered = source.replace('"kb"', '"xx"');
      expect(tampered.length).toBe(source.length);
      expect(tampered).not.toBe(source);
      await writePrivate(directory, '.sync/state.json', tampered);
      return guard;
    });
    await expect(
      pushWorkspace(directory, async () => f.backend, { apply: true })
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
    expect(await readPrivate(directory, '.sync/state.json')).toBe(tampered);
  });
});
function addNodes(
  source: string,
  nodes: Record<string, 'text' | 'multiline'>,
  body: string
): string {
  const parsed = parseFrontmatter('test.md', source),
    attributes = parsed.attributes!;
  for (const [key, content] of Object.entries(nodes))
    (attributes.rems ??= {})[`local-${key}`] = { content };
  return (
    renderFrontmatter(attributes) +
    `<!-- remnote:${parsed.documentKey} -->\n\n` +
    parsed.body +
    body
  );
}
const newKeys = Object.fromEntries(
  ['q', 'a', 'n', 'note'].map((key) => [key, localNodeKey('daily', `local-${key}`)])
);

/** A synthetic, sealed publication of the retired dense protocol; never reads a real vault. */
async function legacyFixture() {
  const f = fixture();
  f.rems.get('answer')!.text = [{ i: 'q', _id: 'subdoc' }, ' ', { i: 'q', _id: 'basic' }];
  await importWorkspace(directory, 'kb', async () => f.backend);
  const local = await inspectLocal(directory),
    state = structuredClone(local.state);
  const oldBlocks = new Map(
    Object.entries(state.entries).map(([id, entry]) => [
      entry.blockId,
      `rn-${Buffer.from(id).toString('hex')}`,
    ])
  );
  const sources = new Map<string, string>();
  for (const [path, document] of local.parsed) {
    const metadata = structuredClone(document.metadata!);
    let body = parseFrontmatter(path, await readPrivate(directory, path)).body;
    for (const [block, old] of oldBlocks) body = body.replaceAll(`^${block}`, `^${old}`);
    // An old root-fragment alias is rewritten from the native target, not kept as a nonexistent anchor.
    const subdocPath = state.entries.subdoc!.path.replace(/\.md$/, '');
    body = body.replaceAll(
      `${subdocPath}|`,
      `${subdocPath}#^${oldBlocks.get(state.entries.subdoc!.blockId)}|`
    );
    for (const entry of Object.values(metadata.rems)) entry.block = oldBlocks.get(entry.block)!;
    const source = `---\n${yamlStringify(metadata, { lineWidth: 0, aliasDuplicateObjects: false })}---\n\n${body}`;
    await writePrivate(directory, path, source);
    state.documents[path]!.fileHash = hash(source);
    sources.set(path, source);
  }
  for (const entry of Object.values(state.entries)) entry.blockId = oldBlocks.get(entry.blockId)!;
  await rm(join(directory, IDENTITY));
  await saveState(directory, state);
  return { ...f, state, sources };
}

describe('explicit offline format', () => {
  it('converts a clean sealed dense publication, preserving every raw record and native link target', async () => {
    const f = await legacyFixture();
    const filesBefore = new Map(
      await Promise.all(
        (await fileOps.allFiles(directory))
          .filter((path) => path.startsWith('.remnote/'))
          .map(async (path) => [path, await readPrivate(directory, path)] as const)
      )
    );
    expect(await lintWorkspace(directory)).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'IDENTITY',
          message: expect.stringContaining('sync format DIR'),
        }),
      ]),
    });
    const factory = vi.fn(async () => f.backend);
    await expect(pushWorkspace(directory, factory, { apply: true })).rejects.toThrow('IDENTITY');
    expect(factory).not.toHaveBeenCalled();
    expect(await formatWorkspace(directory)).toMatchObject({
      status: 'formatted',
      complete: true,
      remoteWrites: 0,
      documents: 3,
      rems: 8,
      originals: 'unchanged',
    });
    const local = await inspectLocal(directory);
    expect(local.diagnostics).toEqual([]);
    expect(planLocal(local).changes).toEqual([]);
    expect(Object.keys(local.state.entries).sort()).toEqual(Object.keys(f.state.entries).sort());
    for (const [path, content] of filesBefore)
      expect(await readPrivate(directory, path)).toBe(content);
    const answer = local.parsed
      .get(local.state.entries.answer!.path)!
      .nodes.find((node) => node.key === 'answer')!;
    expect(answer.text).toEqual(f.rems.get('answer')!.text);
    const source = await readPrivate(directory, local.state.entries.answer!.path);
    expect(source).not.toContain('schema:');
    expect(source).not.toContain('#^rn-');
    expect(source).not.toContain(`${local.state.entries.subdoc!.path.replace(/\.md$/, '')}#^`);
    const retained = await fileOps.allFiles(directory, '.sync/staging');
    const displaced = await Promise.all(
      retained
        .filter((path) => path.endsWith('.displaced'))
        .map((path) => readPrivate(directory, path))
    );
    for (const old of f.sources.values()) expect(displaced).toContain(old);
    expect(await formatWorkspace(directory)).toMatchObject({
      status: 'already-formatted',
      remoteWrites: 0,
    });
    expect(f.calls).toEqual([]);
  });

  it('refuses local edits, missing documents and corrupted raw records without rewriting them', async () => {
    const f = await legacyFixture();
    const path = f.state.entries.answer!.path;
    await edit(path, (source) => source + '\n- Unsaved local text\n');
    const edited = await readPrivate(directory, path);
    await expect(formatWorkspace(directory)).rejects.toThrow('locally edited');
    expect(await readPrivate(directory, path)).toBe(edited);
    await writePrivate(directory, path, f.sources.get(path)!);
    await rm(join(directory, path));
    await expect(formatWorkspace(directory)).rejects.toThrow('missing legacy');
    await writePrivate(directory, path, f.sources.get(path)!);
    await writePrivate(directory, f.state.entries.answer!.rawPath, '{}');
    await expect(formatWorkspace(directory)).rejects.toThrow('READONLY_METADATA');
    expect(await readPrivate(directory, path)).toBe(f.sources.get(path));
    expect(f.calls).toEqual([]);
  });

  it('refuses unknown remote journals and never uses format to repair a forged identity', async () => {
    const f = await legacyFixture();
    await saveState(directory, {
      ...f.state,
      pending: { planHash: 'a'.repeat(64), journalKey: 'unknown' },
    });
    await expect(formatWorkspace(directory)).rejects.toThrow('pending remote journal');
    await saveState(directory, f.state);
    await formatWorkspace(directory);
    await edit(IDENTITY, (source) => source.replace('"answer"', '"forged"'));
    await expect(formatWorkspace(directory)).rejects.toThrow('IDENTITY');
    expect(await readPrivate(directory, IDENTITY)).toContain('"forged"');
    expect(f.calls).toEqual([]);
  });

  it('freezes source and raw files before staging conversion', async () => {
    const f = await legacyFixture();
    const path = f.state.entries.answer!.path;
    const write = fileOps.writePrivate;
    let tampered = false;
    vi.spyOn(fileOps, 'writePrivate').mockImplementation(async (root, name, content, maxBytes) => {
      if (!tampered && name.startsWith('.sync/staging/')) {
        tampered = true;
        await write(root, path, f.sources.get(path)! + '\nConcurrent edit\n');
      }
      return write(root, name, content, maxBytes);
    });
    await expect(formatWorkspace(directory)).rejects.toThrow('Local file changed');
    expect(await readPrivate(directory, path)).toContain('Concurrent edit');
    expect((await loadState(directory)).entries.answer!.blockId).toBe(
      f.state.entries.answer!.blockId
    );
    expect(f.calls).toEqual([]);
  });
});

describe('versioned sync', () => {
  async function save(path: string, replace: (source: string) => string) {
    const source = await workspace.readWorkspace(directory, path);
    return workspace.saveWorkspace(directory, path, replace(source.content), source.fileHash);
  }

  it('reads and saves offline with per-Rem clocks without advancing the native baseline', async () => {
    const f = await prepare();
    const before = await loadState(directory);
    const source = await workspace.readWorkspace(directory, f.path);
    expect(source.fileHash).toBe(hash(source.content));
    const saved = await workspace.saveWorkspace(
      directory,
      f.path,
      source.content.replace('Because', 'Controlled answer'),
      source.fileHash
    );
    expect(saved).toMatchObject({ status: 'saved', changed: ['answer'], remoteWrites: 0 });
    const after = await loadState(directory);
    expect(after.localVersions?.answer).toMatchObject({
      contentHash: hash(
        contentProjection({ ...f.rems.get('answer')!, text: ['Controlled answer'] })
      ),
      source: 'cli-save',
      timestamp: expect.any(Number),
    });
    expect(Object.keys(after.localVersions ?? {})).toEqual(['answer']);
    expect(after.entries).toEqual(before.entries);
    expect(after.documents).toEqual(before.documents);
    expect(await diffWorkspace(directory)).toMatchObject({ changes: [{ id: 'answer' }] });
    expect(f.calls).toEqual([]);
  });

  it('saves a new multiline card before assigning native IDs and consumes its local clocks', async () => {
    const f = await prepare();
    const saved = await save(f.path, (source) =>
      addNodes(
        source,
        { q: 'multiline', a: 'text' },
        '\n- New question ^local-q\n  - New answer ^local-a\n'
      )
    );
    expect(saved).toMatchObject({
      status: 'saved',
      changed: [newKeys.a, newKeys.q].sort(),
      remoteWrites: 0,
    });
    expect(Object.keys((await loadState(directory)).localVersions!).sort()).toEqual(
      [newKeys.a, newKeys.q].sort()
    );
    const preview = (await pushWorkspace(directory, async () => f.backend)) as { planHash: string };
    expect(preview).toMatchObject({ status: 'preview', creates: 2, updates: 0 });
    expect(f.calls).toEqual([]);
    expect(
      await pushWorkspace(directory, async () => f.backend, {
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({
      status: 'verified',
      ids: { [newKeys.q!]: 'created_1', [newKeys.a!]: 'created_2' },
    });
    expect((await loadState(directory)).localVersions).toEqual({});
    expect(f.rems.get('created_1')!.children).toEqual(['created_2']);
    expect(f.rems.get('created_2')).toMatchObject({ text: ['New answer'], cardItem: true });
    expect(await pushWorkspace(directory, async () => f.backend)).toMatchObject({
      status: 'unchanged',
    });
  });

  it('selects the whole local Rem version rather than combining independently edited front and back', async () => {
    const f = await prepare();
    await edit(f.path, (source) => source.replace('Front', 'Local front'));
    const now = Date.now();
    f.rems.get('basic')!.backText = ['Remote back'];
    f.rems.get('basic')!.public = { updatedAt: now - 1_000 };
    const context = await inspectLocal(directory);
    context.state.localVersions = {
      basic: {
        contentHash: hash(
          contentProjection({ ...f.rems.get('basic')!, text: ['Local front'], backText: ['Back'] })
        ),
        timestamp: now,
        source: 'cli-save',
      },
    };
    const remote = new Map(
      (await f.backend.read([...context.native.keys()])).map((rem) => [rem.id, rem])
    );
    const { plan } = reconcile(context, planLocal(context), remote);
    expect(plan.conflicts).toEqual([]);
    expect(plan.resolutions).toMatchObject([{ id: 'basic', winner: 'local' }]);
    expect(plan.changes).toMatchObject([
      { key: 'basic', fields: { text: ['Local front'], backText: ['Back'] } },
    ]);
  });

  it('selects a later remote content version when both endpoints changed the same Rem', async () => {
    const f = await prepare();
    await edit(f.path, (source) => source.replace('Because', 'Local answer'));
    const now = Date.now();
    f.rems.get('answer')!.text = ['Remote answer'];
    f.rems.get('answer')!.public = { updatedAt: now };
    const context = await inspectLocal(directory);
    context.state.localVersions = {
      answer: {
        contentHash: hash(contentProjection({ ...f.rems.get('answer')!, text: ['Local answer'] })),
        timestamp: now - 1_000,
        source: 'cli-save',
      },
    };
    const remote = new Map(
      (await f.backend.read([...context.native.keys()])).map((rem) => [rem.id, rem])
    );
    const { plan } = reconcile(context, planLocal(context), remote);
    expect(plan.conflicts).toEqual([]);
    expect(plan.resolutions).toMatchObject([{ id: 'answer', winner: 'remote' }]);
    expect(plan.incoming).toEqual(['answer']);
    expect(plan.changes).toEqual([]);
  });

  it.each(['local', 'remote'] as const)(
    'applies the whole %s winner after archiving both content versions',
    async (winner) => {
      const f = await prepare();
      await save(f.path, (source) => source.replace('Front', 'Local front'));
      const timestamp = (await loadState(directory)).localVersions!.basic!.timestamp!;
      f.rems.get('basic')!.backText = ['Remote back'];
      f.rems.get('basic')!.public = {
        updatedAt: timestamp + (winner === 'local' ? -1_000 : 1_000),
      };
      const originalCard = (await f.backend.read(['basic']))[0]!.cards![0]!;
      f.rems.get('basic')!.cards = [
        {
          ...originalCard,
          repetitionHistory: [{ time: 100 }],
          lastRepetitionTime: 100,
          nextRepetitionTime: 200,
        },
      ];
      const history = structuredClone(f.rems.get('basic')!.cards);
      const preview = (await pushWorkspace(directory, async () => f.backend)) as {
        planHash: string;
        resolutions: Array<{ historyPath: string }>;
      };
      expect(preview).toMatchObject({ status: 'preview', resolutions: [{ id: 'basic', winner }] });
      const record = JSON.parse(await readPrivate(directory, preview.resolutions[0]!.historyPath));
      expect(record).toMatchObject({
        local: { text: ['Local front'], backText: ['Back'] },
        remote: { text: ['Front'], backText: ['Remote back'] },
        decision: { policy: 'version-time-lww', winner },
      });
      expect(JSON.stringify(record)).not.toContain('repetitionHistory');
      expect(f.calls).toEqual([]);
      expect(
        await pushWorkspace(directory, async () => f.backend, {
          apply: true,
          planHash: preview.planHash,
        })
      ).toMatchObject({ status: 'verified' });
      const basic = (await inspectLocal(directory)).parsed
        .get(f.path)!
        .nodes.find((node) => node.key === 'basic')!;
      expect(basic.text).toEqual(winner === 'local' ? ['Local front'] : ['Front']);
      expect(basic.backText).toEqual(winner === 'local' ? ['Back'] : ['Remote back']);
      expect(f.rems.get('basic')!.cards).toEqual(history);
      expect(await diffWorkspace(directory)).toMatchObject({ changes: [] });
      expect(await pushWorkspace(directory, async () => f.backend)).toMatchObject({
        status: 'unchanged',
      });
      expect(JSON.parse(await readPrivate(directory, preview.resolutions[0]!.historyPath))).toEqual(
        record
      );
    }
  );

  it('does not stamp no-op, formatting-only or untouched external Rem edits', async () => {
    const f = await prepare();
    await save(f.path, (source) => source);
    expect((await loadState(directory)).localVersions).toEqual({});
    await edit(f.path, (source) => source.replace('Because', 'External answer'));
    await save(f.path, (source) => source.replace('Front', 'Controlled front'));
    const after = await loadState(directory);
    expect(Object.keys(after.localVersions!)).toEqual(['basic']);
    await save(f.path, (source) => source + '\n');
    expect((await loadState(directory)).localVersions).toEqual(after.localVersions);
    f.rems.get('answer')!.text = ['Remote answer'];
    f.rems.get('answer')!.public = { updatedAt: Date.now() };
    expect(await pushWorkspace(directory, async () => f.backend)).toMatchObject({
      status: 'conflict',
      conflicts: [expect.objectContaining({ id: 'answer', reason: 'untrusted-edit-order' })],
    });
    expect(f.calls).toEqual([]);
  });

  it('rejects a stale save without changing source or version metadata', async () => {
    const f = await prepare(),
      source = await workspace.readWorkspace(directory, f.path);
    await edit(f.path, (value) => value.replace('Because', 'External answer'));
    const current = await readPrivate(directory, f.path),
      state = await loadState(directory);
    await expect(
      workspace.saveWorkspace(
        directory,
        f.path,
        source.content.replace('Because', 'Stale answer'),
        source.fileHash
      )
    ).rejects.toThrow('current fileHash');
    expect(await readPrivate(directory, f.path)).toBe(current);
    expect(await loadState(directory)).toEqual(state);
  });

  it('preserves a child-document root clock when a mount appears in another edited document', async () => {
    const f = await prepare();
    const childPath = (await loadState(directory)).entries.subdoc!.path;
    await save(childPath, (source) => source.replace('# Child doc\n', '# Edited child doc\n'));
    const version = (await loadState(directory)).localVersions!.subdoc;
    expect(version).toMatchObject({ source: 'cli-save', timestamp: expect.any(Number) });
    await save(f.path, (source) => source.replace('Because', 'Another edited Rem'));
    expect((await loadState(directory)).localVersions!.subdoc).toEqual(version);
  });

  it.each(['before-content', 'before-clock'] as const)(
    'recovers a save interrupted %s without retiming it',
    async (point) => {
      const f = await prepare(),
        original = LocalState.prototype.setLocal,
        link = fileOps.linkPrivate;
      const before = await loadState(directory);
      const writer =
        point === 'before-content'
          ? vi.spyOn(fileOps, 'linkPrivate').mockImplementation(async (root, from, to) => {
              if (to === f.path) throw new Error('injected save interruption');
              return link(root, from, to);
            })
          : vi
              .spyOn(LocalState.prototype, 'setLocal')
              .mockImplementation(async function (key, value) {
                if (key.startsWith('manifest:')) throw new Error('injected save interruption');
                return original.call(this, key, value);
              });
      await expect(
        save(f.path, (source) => source.replace('Because', 'Interrupted answer'))
      ).rejects.toThrow('injected');
      const pending = await readPublication(directory);
      expect(pending?.next.localVersions?.answer?.timestamp).toEqual(expect.any(Number));
      expect((await authoritativeState(directory)).localVersions).toEqual(before.localVersions);
      writer.mockRestore();
      const native = vi.fn(async () => {
        throw new Error('must stay offline');
      });
      expect(await recoverWorkspace(directory, native)).toMatchObject({
        status: 'recovered',
        remoteWrites: 0,
      });
      expect((await loadState(directory)).localVersions).toEqual(pending!.next.localVersions);
      expect(await readPrivate(directory, f.path)).toContain('Interrupted answer');
      expect(native).not.toHaveBeenCalled();
    }
  );

  it('keeps the observed remote version time through review and metadata-only changes', async () => {
    const f = await prepare();
    await save(f.path, (source) => source.replace('Front', 'Local front'));
    const timestamp = (await loadState(directory)).localVersions!.basic!.timestamp!;
    f.rems.get('basic')!.backText = ['Remote back'];
    f.rems.get('basic')!.public = { updatedAt: timestamp - 1_000 };
    const preview = (await pushWorkspace(directory, async () => f.backend)) as {
      planHash: string;
      resolutions: Array<{ historyPath: string }>;
    };
    const recorded = (await loadState(directory)).remoteVersions!.basic;
    const record = await readPrivate(directory, preview.resolutions[0]!.historyPath);
    f.rems.get('basic')!.public!.updatedAt = timestamp + 2_000;
    const card = (await f.backend.read(['basic']))[0]!.cards![0]!;
    f.rems.get('basic')!.cards = [
      {
        ...card,
        repetitionHistory: [{ time: 200 }],
        lastRepetitionTime: 200,
        nextRepetitionTime: 300,
      },
    ];
    expect(
      await pushWorkspace(directory, async () => f.backend, {
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({ status: 'verified', resolutions: [{ winner: 'local' }] });
    expect(recorded?.timestamp).toBe(timestamp - 1_000);
    expect(await readPrivate(directory, preview.resolutions[0]!.historyPath)).toBe(record);
    expect(f.rems.get('basic')!.cards![0]!.repetitionHistory).toEqual([{ time: 200 }]);
  });

  it('records a new remote clock for an observed A to B to A sequence', async () => {
    const f = await prepare(),
      timestamp = Date.now();
    f.rems.get('answer')!.text = ['B'];
    f.rems.get('answer')!.public = { updatedAt: timestamp - 1_000 };
    await pushWorkspace(directory, async () => f.backend);
    const first = (await loadState(directory)).remoteVersions!.answer!;
    f.rems.get('answer')!.text = ['Because'];
    f.rems.get('answer')!.public!.updatedAt = timestamp;
    await pushWorkspace(directory, async () => f.backend);
    const second = (await loadState(directory)).remoteVersions!.answer!;
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(second.timestamp).toBe(timestamp);
  });

  it.each(['local', 'remote'] as const)(
    'orders an observed %s A to B to A revert as a new version and consumes it after publication',
    async (side) => {
      const f = await prepare(),
        timestamp = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(timestamp);
      await save(f.path, (source) => source.replace('Because', 'Local answer'));
      f.rems.get('answer')!.text = ['Remote answer'];
      f.rems.get('answer')!.public = { updatedAt: timestamp - 1_000 };
      if (side === 'local') {
        f.rems.get('answer')!.public!.updatedAt = timestamp + 1_000;
        clock.mockReturnValue(timestamp + 2_000);
        await save(f.path, (source) => source.replace('Local answer', 'Because'));
      } else {
        await pushWorkspace(directory, async () => f.backend);
        f.rems.get('answer')!.text = ['Because'];
        f.rems.get('answer')!.public!.updatedAt = timestamp + 1_000;
      }
      const preview = (await pushWorkspace(directory, async () => f.backend)) as {
        planHash: string;
        resolutions: Array<{ historyPath: string }>;
      };
      expect(preview).toMatchObject({
        status: 'preview',
        resolutions: [{ id: 'answer', winner: side }],
      });
      const archived = JSON.parse(
        await readPrivate(directory, preview.resolutions[0]!.historyPath)
      );
      expect(archived[side].text).toEqual(['Because']);
      expect(f.calls).toEqual([]);
      expect(
        await pushWorkspace(directory, async () => f.backend, {
          apply: true,
          planHash: preview.planHash,
        })
      ).toMatchObject({ status: 'verified' });
      expect(f.rems.get('answer')!.text).toEqual(['Because']);
      const after = await inspectLocal(directory);
      expect(after.parsed.get(f.path)!.nodes.find((node) => node.key === 'answer')!.text).toEqual([
        'Because',
      ]);
      expect(after.state.localVersions).toEqual({});
      expect(after.state.remoteVersions!.answer).not.toHaveProperty('sinceBaseline');
      expect(await pushWorkspace(directory, async () => f.backend)).toMatchObject({
        status: 'unchanged',
      });
    }
  );

  it.each(['local', 'remote'] as const)(
    'does not turn a same-content %s observation into a new version',
    async (side) => {
      const f = await prepare(),
        timestamp = Date.now();
      const before = await loadState(directory);
      if (side === 'local') {
        await save(f.path, (source) => source);
        f.rems.get('answer')!.text = ['Remote answer'];
        f.rems.get('answer')!.public = { updatedAt: timestamp - 1_000 };
      } else {
        await save(f.path, (source) => source.replace('Because', 'Local answer'));
        f.rems.get('answer')!.public = { updatedAt: timestamp + 1_000 };
      }
      const preview = await pushWorkspace(directory, async () => f.backend);
      expect(preview).toMatchObject({
        status: 'preview',
        resolutions: [],
        incoming: side === 'local' ? ['answer'] : [],
        outgoing: side === 'remote' ? ['answer'] : [],
      });
      const after = await loadState(directory);
      if (side === 'local') expect(after.localVersions).toEqual({});
      else expect(after.remoteVersions!.answer).toEqual(before.remoteVersions!.answer);
      expect(f.calls).toEqual([]);
    }
  );

  it.each(['preview', 'unknown'] as const)(
    'reads a version-less manifest without changing its seal but refuses its retired %s journal',
    async (journalState) => {
      const f = await prepare();
      f.rems.get('answer')!.public = { updatedAt: Date.now() - 1_000 };
      const context = await inspectLocal(directory),
        localPlan = planLocal(context),
        remote = new Map(
          (await f.backend.read([...context.native.keys()])).map((rem) => [rem.id, rem])
        );
      const currentPlan = reconcile(context, localPlan, remote).plan;
      const priorPlan: Partial<typeof currentPlan> = { ...currentPlan };
      delete priorPlan.resolutions;
      const oldHash = hash(priorPlan),
        journalKey = `workspace-v1:kb:${hash(directory)}:${oldHash}`;
      const oldState = context.state;
      delete oldState.localVersions;
      delete oldState.remoteVersions;
      oldState.pending = { planHash: oldHash, journalKey };
      await localStore('kb').setLocal(journalKey, {
        version: 1,
        planHash: oldHash,
        guardHash: hash('old-preview-guard'),
        state: journalState,
        steps: journalState === 'preview' ? {} : { 'answer:text': 'unknown' },
        ids: {},
      });
      await saveState(directory, oldState);
      const mirror = await readPrivate(directory, '.sync/state.json'),
        source = await readPrivate(directory, f.path),
        stateHash = hash(oldState);
      expect(hash(await loadState(directory))).toBe(stateHash);
      expect(await loadState(directory)).not.toHaveProperty('localVersions');
      expect(await loadState(directory)).not.toHaveProperty('remoteVersions');
      expect(planLocal(await inspectLocal(directory)).baseHash).toBe(localPlan.baseHash);
      expect((await workspace.readWorkspace(directory, f.path)).content).toBe(source);
      expect(await readPrivate(directory, '.sync/state.json')).toBe(mirror);
      await expect(pushWorkspace(directory, async () => f.backend)).rejects.toThrow(
        'Prior write outcome'
      );
      await expect(
        save(f.path, (source) => source.replace('Because', 'Must not overwrite'))
      ).rejects.toThrow('Prior write outcome');
      expect(hash(await loadState(directory))).toBe(stateHash);
      expect(f.calls).toEqual([]);
    }
  );

  it.each(['missing', 'equal', 'future', 'invalid'] as const)(
    'keeps both versions when the remote clock is %s',
    async (kind) => {
      const f = await prepare();
      await save(f.path, (source) => source.replace('Because', 'Local answer'));
      const timestamp = (await loadState(directory)).localVersions!.answer!.timestamp!;
      f.rems.get('answer')!.text = ['Remote answer'];
      f.rems.get('answer')!.public =
        kind === 'missing'
          ? {}
          : {
              updatedAt:
                kind === 'equal' ? timestamp : kind === 'future' ? timestamp + 600_000 : -1,
            };
      const result = (await pushWorkspace(directory, async () => f.backend)) as {
        conflicts: Array<{ localSnapshot: string; remoteSnapshot: string }>;
      };
      expect(result).toMatchObject({ status: 'conflict', complete: false });
      expect(
        JSON.parse(await readPrivate(directory, result.conflicts[0]!.localSnapshot)).text
      ).toEqual(['Local answer']);
      expect(
        JSON.parse(await readPrivate(directory, result.conflicts[0]!.remoteSnapshot)).text
      ).toEqual(['Remote answer']);
      expect(f.calls).toEqual([]);
    }
  );

  it.each(['markdown', 'local-clock', 'remote-content'] as const)(
    'refuses a frozen plan after %s changes',
    async (change) => {
      const f = await prepare();
      await save(f.path, (source) => source.replace('Because', 'Local answer'));
      const timestamp = (await loadState(directory)).localVersions!.answer!.timestamp!;
      f.rems.get('answer')!.text = ['Remote answer'];
      f.rems.get('answer')!.public = { updatedAt: timestamp - 1_000 };
      const preview = (await pushWorkspace(directory, async () => f.backend)) as {
        planHash: string;
      };
      if (change === 'markdown')
        await edit(f.path, (source) => source.replace('Local answer', 'Later local answer'));
      else if (change === 'local-clock') {
        const state = await loadState(directory);
        state.localVersions!.answer!.timestamp = timestamp + 1;
        await saveState(directory, state);
      } else f.rems.get('answer')!.text = ['Later remote answer'];
      await expect(
        pushWorkspace(directory, async () => f.backend, { apply: true, planHash: preview.planHash })
      ).rejects.toThrow('frozen');
      expect(f.calls).toEqual([]);
    }
  );

  it('performs zero overwrites when history storage fails', async () => {
    const f = await prepare();
    await save(f.path, (source) => source.replace('Because', 'Local answer'));
    const timestamp = (await loadState(directory)).localVersions!.answer!.timestamp!;
    f.rems.get('answer')!.text = ['Remote answer'];
    f.rems.get('answer')!.public = { updatedAt: timestamp - 1_000 };
    vi.spyOn(fileOps, 'writePrivateOnce').mockRejectedValue(new Error('history disk failure'));
    await expect(pushWorkspace(directory, async () => f.backend)).rejects.toThrow(
      'history disk failure'
    );
    expect(await readPrivate(directory, f.path)).toContain('Local answer');
    expect(f.rems.get('answer')!.text).toEqual(['Remote answer']);
    expect(f.calls).toEqual([]);
  });

  it('archives the actual opaque local content for a remote-missing conflict', async () => {
    const f = await prepare(),
      before = contentProjection(f.rems.get('opaque')!);
    f.rems.delete('opaque');
    const result = (await pushWorkspace(directory, async () => f.backend)) as {
      conflicts: Array<{ id: string; localSnapshot: string; localHash: string }>;
    };
    const conflict = result.conflicts.find((item) => item.id === 'opaque')!;
    const record = JSON.parse(await readPrivate(directory, conflict.localSnapshot));
    expect(record).toEqual(before);
    expect(hash(record)).toBe(conflict.localHash);
    expect(f.calls).toEqual([]);
  });

  it('refuses apply when the same immutable history identity contains different content', async () => {
    const f = await prepare();
    await save(f.path, (source) => source.replace('Because', 'Local answer'));
    const timestamp = (await loadState(directory)).localVersions!.answer!.timestamp!;
    f.rems.get('answer')!.text = ['Remote answer'];
    f.rems.get('answer')!.public = { updatedAt: timestamp - 1_000 };
    const preview = (await pushWorkspace(directory, async () => f.backend)) as {
      planHash: string;
      resolutions: Array<{ historyPath: string }>;
    };
    await writePrivate(directory, preview.resolutions[0]!.historyPath, '{}\n');
    await expect(
      pushWorkspace(directory, async () => f.backend, { apply: true, planHash: preview.planHash })
    ).rejects.toThrow('Immutable history record differs');
    expect(f.rems.get('answer')!.text).toEqual(['Remote answer']);
    expect(await readPrivate(directory, f.path)).toContain('Local answer');
    expect(f.calls).toEqual([]);
  });
});

describe('controlled RemNote workspace', () => {
  it.each(['markdown', 'new-file', 'readonly'])(
    'preserves a concurrent %s file created while initial import reads remotely',
    async (kind) => {
      const f = fixture(),
        original = f.backend.enumerate,
        path = kind === 'readonly' ? '_readonly/user.json' : kind + '.md';
      f.backend.enumerate = vi.fn(async () => {
        const result = await original();
        await writePrivate(directory, path, 'LOCAL_DRAFT');
        return result;
      });
      await expect(importWorkspace(directory, 'kb', async () => f.backend)).rejects.toThrow(
        'changed during sync'
      );
      expect(await readPrivate(directory, path)).toBe('LOCAL_DRAFT');
      await expect(authoritativeState(directory)).rejects.toThrow('No sync manifest');
      expect(f.calls).toEqual([]);
    }
  );
  it.each(['displace', 'exclusive-link'])(
    'does not overwrite a last-moment editor save at %s',
    async (point) => {
      const f = await prepare();
      await edit(f.path, (s) => addNodes(s, { race: 'text' }, '\n- New note ^local-race\n'));
      const preview = (await pushWorkspace(directory, async () => f.backend)) as {
        planHash: string;
      };
      const method = point === 'displace' ? 'displacePrivate' : 'linkPrivate',
        original = fileOps[method];
      let injected = false;
      const spy = vi.spyOn(fileOps, method).mockImplementation(async (root, a, b) => {
        const target = point === 'displace' ? a : b;
        if (!injected && target === f.path) {
          injected = true;
          await writePrivate(root, target, 'LOCAL_DRAFT');
        }
        return original(root, a, b);
      });
      expect(
        await pushWorkspace(directory, async () => f.backend, {
          apply: true,
          planHash: preview.planHash,
        })
      ).toMatchObject({ status: 'publication-incomplete' });
      spy.mockRestore();
      expect(injected).toBe(true);
      expect(await readPrivate(directory, f.path)).toBe('LOCAL_DRAFT');
      expect((await authoritativeState(directory)).snapshotAt).toBe(f.state.snapshotAt);
    }
  );
  it.each(['publication', 'manifest', 'mirror'])(
    'recovers a verified native write after %s authority failure without replay',
    async (kind) => {
      const f = await prepare();
      await edit(f.path, (s) => s.replace('Because', 'Edited'));
      const preview = (await pushWorkspace(directory, async () => f.backend)) as {
        planHash: string;
      };
      const original = LocalState.prototype.setLocal;
      const writeOriginal = fileOps.writePrivate;
      let failed = false;
      let injectedPoint: string | undefined;
      const spy = vi
        .spyOn(LocalState.prototype, 'setLocal')
        .mockImplementation(async function (key, value) {
          const v = value as { complete?: boolean; pending?: unknown };
          if (
            !failed &&
            (kind === 'publication'
              ? key.startsWith('publication:') && value !== null
              : kind === 'manifest' &&
                key.startsWith('manifest:') &&
                v.complete === true &&
                !v.pending)
          ) {
            failed = true;
            injectedPoint = key.startsWith('publication:') ? 'publication' : 'manifest';
            throw new Error('disk unavailable');
          }
          return original.call(this, key, value);
        });
      const mirrorSpy = vi
        .spyOn(fileOps, 'writePrivate')
        .mockImplementation(async (root, path, content, max) => {
          if (
            kind === 'mirror' &&
            !failed &&
            path === '.sync/state.json' &&
            !JSON.parse(content).pending
          ) {
            failed = true;
            injectedPoint = 'mirror';
            throw new Error('mirror unavailable');
          }
          return writeOriginal(root, path, content, max);
        });
      expect(
        await pushWorkspace(directory, async () => f.backend, {
          apply: true,
          planHash: preview.planHash,
        })
      ).toMatchObject({ status: 'publication-incomplete' });
      expect(injectedPoint).toBe(kind);
      spy.mockRestore();
      mirrorSpy.mockRestore();
      const writes = f.calls.length;
      expect(await recoverWorkspace(directory, async () => f.backend)).toMatchObject({
        complete: true,
        remoteWrites: 0,
      });
      expect(f.calls).toHaveLength(writes);
      expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
      expect(await diffWorkspace(directory)).toMatchObject({ changes: [] });
    }
  );
  it.each(['authority', 'mirror'])(
    'keeps preview recoverable after %s failure with no remote writes',
    async (kind) => {
      const f = await prepare();
      await edit(f.path, (s) => s.replace('Because', 'Changed'));
      const original = LocalState.prototype.setLocal,
        writeOriginal = fileOps.writePrivate;
      let failed = false;
      const stateSpy = vi
        .spyOn(LocalState.prototype, 'setLocal')
        .mockImplementation(async function (key, value) {
          if (
            kind === 'authority' &&
            !failed &&
            key.startsWith('manifest:') &&
            (value as { pending?: unknown }).pending
          ) {
            failed = true;
            throw new Error('authority fault');
          }
          return original.call(this, key, value);
        });
      const mirrorSpy = vi
        .spyOn(fileOps, 'writePrivate')
        .mockImplementation(async (root, path, content, max) => {
          if (
            kind === 'mirror' &&
            !failed &&
            path === '.sync/state.json' &&
            JSON.parse(content).pending
          ) {
            failed = true;
            throw new Error('mirror fault');
          }
          return writeOriginal(root, path, content, max);
        });
      await expect(pushWorkspace(directory, async () => f.backend)).rejects.toThrow('fault');
      stateSpy.mockRestore();
      mirrorSpy.mockRestore();
      const factory = vi.fn(async () => f.backend);
      expect(await recoverWorkspace(directory, factory)).toMatchObject({
        complete: true,
        remoteWrites: 0,
      });
      expect(factory).not.toHaveBeenCalled();
      expect(f.calls).toEqual([]);
      expect(await pushWorkspace(directory, async () => f.backend)).toMatchObject({
        status: 'preview',
      });
    }
  );
  it('retains an atomic manifest across two consecutive mirror failures and repairs it offline', async () => {
    const f = await prepare(),
      original = fileOps.writePrivate;
    const spy = vi
      .spyOn(fileOps, 'writePrivate')
      .mockImplementation(async (root, path, content, max) => {
        if (path === '.sync/state.json') throw new Error('mirror failure');
        return original(root, path, content, max);
      });
    for (const snapshotAt of ['round1', 'round2'])
      await expect(saveState(directory, { ...f.state, snapshotAt })).rejects.toThrow();
    spy.mockRestore();
    const factory = vi.fn(async () => f.backend);
    expect(await recoverWorkspace(directory, factory)).toMatchObject({
      complete: true,
      remoteWrites: 0,
    });
    expect(factory).not.toHaveBeenCalled();
    expect((await loadState(directory)).snapshotAt).toBe('round2');
  });
  it('imports lossless official records, preserves orphan cards and string types, and remains zero-diff', async () => {
    const f = fixture(),
      nativeRems = [...f.rems.values()];
    nativeRems.find((r) => r.id === 'opaque')!.type = 'future-type';
    const docs = nativeRems.map((rem) => ({
      _id: rem.id,
      parent: rem.parent,
      key: rem.text,
      unknown: { nested: [null, 17, { a: true }] },
    }));
    const header = {
      knowledgebaseId: 'kb',
      exportVersion: 1,
      exportDate: '2026-11-14T01:00:00.000Z',
    };
    const bytes = zipSync({
      'rem.json': Buffer.from(JSON.stringify({ ...header, docs })),
      'cards.json': Buffer.from(
        JSON.stringify({
          ...header,
          exportDate: '2026-11-14T01:00:00.250Z',
          docs: [
            { rId: 'question', history: [1] },
            { rId: 'missing-historical', unknown: true },
          ],
        })
      ),
      'user_data.json': Buffer.from('{"mustNotTrack":true}'),
    });
    const archive = join(temporary, 'export.rem'),
      snapshot = join(temporary, 'public.json');
    await writeFile(archive, bytes, { mode: 0o600 });
    await writeFile(
      snapshot,
      JSON.stringify({
        schemaVersion: 1,
        knowledgeBaseId: 'kb',
        sourceSha256: createHash('sha256').update(bytes).digest('hex'),
        exportDate: header.exportDate,
        snapshots: nativeRems.map((rem) => ({
          $type: 'rem',
          id: rem.id,
          parent: rem.parent,
          children: rem.children,
          text: rem.text,
          backText: rem.backText,
          type: rem.type,
        })),
        flags: Object.fromEntries(
          nativeRems.map((rem) => [
            rem.id,
            {
              document: rem.document,
              folder: rem.folder,
              cardItem: rem.cardItem,
              practice: rem.practice,
              enablePractice: rem.enablePractice,
              unsupported: rem.unsupported ?? '',
            },
          ])
        ),
      }),
      { mode: 0o600 }
    );
    const factory = vi.fn(async () => f.backend);
    expect(
      await importWorkspace(directory, 'kb', factory, { export: archive, snapshot })
    ).toMatchObject({ complete: true, globalDiscoveryComplete: true });
    expect(factory).not.toHaveBeenCalled();
    expect(await diffWorkspace(directory)).toMatchObject({ changes: [] });
    expect(
      JSON.parse(await readPrivate(directory, '.remnote/originals/rems/question.json'))
    ).toEqual(docs.find((doc) => doc._id === 'question'));
    expect(
      JSON.parse(await readPrivate(directory, '.remnote/originals/cards/000001.json'))
    ).toEqual({ rId: 'missing-historical', unknown: true });
    expect((await fileOps.allFiles(directory)).some((path) => path.includes('user_data'))).toBe(
      false
    );
    await writePrivate(directory, '.remnote/originals/cards/000001.json', '{}');
    expect(await lintWorkspace(directory)).toMatchObject({ ok: false });
  });
  it('exports the native Folder/Document layout, round trips through lint and has zero diff', async () => {
    const f = await prepare();
    expect(f.path).toContain('HOME');
    expect(f.path).toContain('Today');
    expect(f.state.documents[f.path]!.nodeIds).toContain('chapter');
    expect(f.state.entries.chapter!.editable).toBe(true);
    expect(f.state.entries.opaque!.editable).toBe(false);
    expect(await readPrivate(directory, f.path)).not.toContain('content:');
    expect(
      (await inspectLocal(directory)).parsed.get(f.path)!.metadata!.rems.question!.content
    ).toBe('multiline');
    expect(Object.keys(f.state.documents)).toEqual([
      'HOME/HOME.md',
      'HOME/Today.md',
      'HOME/Today/Child doc.md',
    ]);
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    expect(await diffWorkspace(directory)).toMatchObject({ changes: [], deletes: 0, moves: 0 });
    const factory = vi.fn(async () => f.backend);
    expect(await pushWorkspace(directory, factory)).toMatchObject({
      status: 'unchanged',
      discoveryScope: 'bound-ids',
      globalDiscoveryComplete: false,
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(f.backend.readPublic).toHaveBeenCalled();
  });
  it('updates an existing answer in place and seals the new no-op baseline', async () => {
    const f = await prepare();
    await edit(f.path, (s) => s.replace('Because', 'A clearer reason'));
    const preview = (await pushWorkspace(directory, async () => f.backend)) as { planHash: string };
    expect(f.calls).toEqual([]);
    expect(
      await pushWorkspace(directory, async () => f.backend, {
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({ status: 'verified', updated: ['answer'], cardsPreserved: true });
    expect(f.rems.get('answer')!.text).toEqual(['A clearer reason']);
    expect(f.rems.get('question')!.cardItem).toBe(false);
    expect(f.rems.get('question')!.backText).toEqual([]);
    expect(await diffWorkspace(directory)).toMatchObject({ changes: [] });
  });
  it('creates a new multiline card and answers with durable localKey to native-ID mapping', async () => {
    const f = await prepare();
    await edit(f.path, (s) =>
      addNodes(
        s,
        { q: 'multiline', a: 'text' },
        '\n- New question ^local-q\n  - New answer ^local-a\n'
      )
    );
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    const preview = (await pushWorkspace(directory, async () => f.backend)) as { planHash: string };
    const result = await pushWorkspace(directory, async () => f.backend, {
      apply: true,
      planHash: preview.planHash,
    });
    expect(result).toMatchObject({
      status: 'verified',
      ids: { [newKeys.q!]: 'created_1', [newKeys.a!]: 'created_2' },
    });
    expect(f.rems.get('created_1')!.document).toBe(false);
    expect(f.rems.get('created_1')!.cardItem).toBe(false);
    expect(f.rems.get('created_2')!.parent).toBe('created_1');
    expect(f.rems.get('created_2')!.cardItem).toBe(true);
    expect(f.backend.setCardItem).toHaveBeenCalledWith('created_2', true);
    expect(await readPrivate(directory, IDENTITY)).toContain('"local-q": "created_1"');
    expect(await readPrivate(directory, f.path)).toContain('New question ^local-q');
    expect((await loadState(directory)).entries.created_1!.blockId).toBe('local-q');
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    expect(await diffWorkspace(directory)).toMatchObject({ changes: [] });
  });
  it('supports exact native references and code answer blocks', async () => {
    const f = await prepare();
    await edit(f.path, (s) =>
      addNodes(
        s,
        { q: 'multiline', a: 'text' },
        '\n- Coding ^local-q\n  - ^local-a\n\n    ```typescript\n    const x = 1;\n    ```\n'
      )
    );
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    const preview = (await pushWorkspace(directory, async () => f.backend)) as { planHash: string };
    expect(
      await pushWorkspace(directory, async () => f.backend, {
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({ status: 'verified' });
    expect(f.rems.get('created_2')!.cardItem).toBe(true);
    expect(f.rems.get('created_2')!.text).toEqual([
      { i: 'm', code: true, language: 'typescript', text: 'const x = 1;' },
    ]);
  });
  it.each([
    [
      'duplicate key',
      (s: string) => addNodes(s, { same: 'text' }, '\n- A ^local-same\n- B ^local-same\n'),
      'DUPLICATE_ID',
    ],
    [
      'empty card',
      (s: string) => addNodes(s, { q: 'multiline' }, '\n- Empty ^local-q\n'),
      'EMPTY_ANSWER',
    ],
    ['new embed', (s: string) => s.replace('Why? ^', '![[HOME/Today]] ^'), 'UNSUPPORTED_EMBED'],
    ['remove ID', (s: string) => s.replace(`^${nativeBlockId('answer')}`, ''), 'MISSING_ID'],
    [
      'unknown reference',
      (s: string) => s.replace('Because', '[missing](remnote:missing)'),
      'DANGLING_REFERENCE',
    ],
    ['opaque edit', (s: string) => s.replace('Cloze', 'Changed cloze'), 'OPAQUE_EDIT'],
    [
      'card-kind change',
      (s: string) =>
        renderFrontmatter({ rems: { [nativeBlockId('question')]: { content: 'text' } } }) + s,
      'IMMUTABLE_STRUCTURE',
    ],
  ])('lint rejects %s before any remote call', async (_label, change, code) => {
    const f = await prepare();
    await edit(f.path, change);
    const lint = (await lintWorkspace(directory)) as {
      diagnostics: Array<{ code: string; line: number }>;
    };
    expect(lint.diagnostics.some((d) => d.code === code)).toBe(true);
    expect(lint.diagnostics.every((d) => d.line > 0)).toBe(true);
    const factory = vi.fn(async () => f.backend);
    await expect(pushWorkspace(directory, factory)).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
  it('refuses a second import and missing files, never converting absence to deletion', async () => {
    const f = await prepare();
    await edit(f.path, (s) => s.replace('Because', 'Local edit'));
    await expect(importWorkspace(directory, 'kb', async () => f.backend)).rejects.toThrow(
      'refuses'
    );
    await rm(join(directory, f.path));
    expect(await statusWorkspace(directory)).toMatchObject({ missing: [f.path] });
    await expect(pushWorkspace(directory, async () => f.backend)).rejects.toThrow('MISSING_FILE');
    expect(f.calls).toEqual([]);
  });
  it('rejects changed files after preview and detects remote conflicts before writes', async () => {
    const f = await prepare();
    await edit(f.path, (s) => s.replace('Because', 'Edit'));
    const preview = (await pushWorkspace(directory, async () => f.backend)) as { planHash: string };
    await edit(f.path, (s) => s.replace('Edit', 'Later edit'));
    await expect(
      pushWorkspace(directory, async () => f.backend, { apply: true, planHash: preview.planHash })
    ).rejects.toThrow('frozen');
    f.rems.get('answer')!.text = ['Remote edit'];
    expect(await pushWorkspace(directory, async () => f.backend)).toMatchObject({
      status: 'conflict',
      conflicts: [expect.objectContaining({ id: 'answer', reason: 'untrusted-edit-order' })],
    });
    expect(f.calls).toEqual([]);
  });
  it('never retries unknown writes, even when the mutation already took effect', async () => {
    const f = await prepare();
    await edit(f.path, (s) => s.replace('Because', 'Edited'));
    const preview = (await pushWorkspace(directory, async () => f.backend)) as { planHash: string };
    const original = f.backend.writeField;
    f.backend.writeField = vi.fn(async (...args) => {
      await original(...args);
      throw new Error('Lost acknowledgement');
    });
    expect(
      await pushWorkspace(directory, async () => f.backend, {
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({ status: 'unknown', complete: false });
    await expect(
      pushWorkspace(directory, async () => f.backend, { apply: true, planHash: preview.planHash })
    ).rejects.toThrow('reconciliation');
    expect(f.backend.writeField).toHaveBeenCalledTimes(1);
  });
  it('persists a returned create ID before a follow-up read failure', async () => {
    const f = await prepare();
    await edit(f.path, (s) => addNodes(s, { n: 'text' }, '\n- Note ^local-n\n'));
    const preview = (await pushWorkspace(directory, async () => f.backend)) as { planHash: string };
    const read = f.backend.read;
    f.backend.read = vi.fn(async (ids) => {
      if (ids.includes('created_1')) throw new Error('read lost');
      return read(ids);
    });
    expect(
      await pushWorkspace(directory, async () => f.backend, {
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({ status: 'unknown', ids: { [newKeys.n!]: 'created_1' } });
    expect(f.backend.create).toHaveBeenCalledTimes(1);
  });
  it('records incomplete global discovery and does not substitute a known-root scan', async () => {
    const f = fixture();
    f.backend.enumerate = vi.fn(async () => {
      throw new Error('SDK array exceeds maximum length 1000');
    });
    expect(await importWorkspace(directory, 'kb', async () => f.backend)).toMatchObject({
      complete: false,
      status: 'incomplete',
    });
    expect(await statusWorkspace(directory)).toMatchObject({ complete: false, rems: 0 });
    await expect(diffWorkspace(directory)).rejects.toThrow('incomplete');
    expect(f.backend.read).not.toHaveBeenCalled();
  });
  it('rejects read-only native object or manifest tampering', async () => {
    const f = await prepare();
    await writePrivate(directory, f.state.entries.opaque!.rawPath, '{}');
    expect(await lintWorkspace(directory)).toMatchObject({ ok: false });
    const statePath = join(directory, '.sync/state.json'),
      raw = JSON.parse(await readFile(statePath, 'utf8'));
    raw.kbId = 'other';
    await writeFile(statePath, JSON.stringify(raw));
    await expect(lintWorkspace(directory)).rejects.toThrow('integrity');
  });
  it('enforces private files, symlink boundaries and a unique writer', async () => {
    const f = await prepare();
    await symlink(join(directory, f.path), join(directory, 'linked.md'));
    await expect(lintWorkspace(directory)).rejects.toThrow('Symlink');
    await rm(join(directory, 'linked.md'));
    await chmod(join(directory, f.path), 0o644);
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    await chmod(join(directory, f.state.entries.answer!.rawPath), 0o644);
    expect(await lintWorkspace(directory)).toMatchObject({ ok: false });
    await chmod(join(directory, f.state.entries.answer!.rawPath), 0o600);
    await chmod(join(directory, f.path), 0o600);
    await withWorkspaceLock(directory, async () => {
      await expect(importWorkspace(directory, 'kb', async () => f.backend)).rejects.toThrow(
        'locked'
      );
    });
  });
  it('rejects cross-KB reuse', async () => {
    const f = await prepare();
    await expect(importWorkspace(directory, 'another', async () => f.backend)).rejects.toThrow(
      'another KB'
    );
  });
  it('deletes only the explicitly frozen card subtree within scope and verifies absence', async () => {
    const f = await prepare(),
      options = { deleteId: 'question', scopeRoot: 'daily' };
    const preview = (await pushWorkspace(directory, async () => f.backend, options)) as {
      planHash: string;
      deletion: { ids: string[] };
    };
    expect(preview.deletion.ids).toEqual(['answer', 'question']);
    expect(f.calls).toEqual([]);
    expect(
      await pushWorkspace(directory, async () => f.backend, {
        ...options,
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({ status: 'verified', deleted: ['answer', 'question'] });
    expect(f.rems.has('question')).toBe(false);
    expect(f.rems.has('answer')).toBe(false);
    expect(f.rems.has('chapter')).toBe(true);
    expect(await diffWorkspace(directory)).toMatchObject({ changes: [] });
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
  });
  it('rejects out-of-scope, answer-only, folder and missing explicit delete boundaries offline', async () => {
    const f = await prepare(),
      factory = vi.fn(async () => f.backend);
    for (const options of [
      { deleteId: 'question' },
      { deleteId: 'question', scopeRoot: 'basic' },
      { deleteId: 'answer', scopeRoot: 'daily' },
      { deleteId: 'daily', scopeRoot: 'home' },
      { deleteId: 'daily', scopeRoot: 'daily' },
    ])
      await expect(pushWorkspace(directory, factory, options)).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });
  it('refuses deletion when a new descendant appears after preview', async () => {
    const f = await prepare(),
      options = { deleteId: 'question', scopeRoot: 'daily' };
    const preview = (await pushWorkspace(directory, async () => f.backend, options)) as {
      planHash: string;
    };
    f.rems.get('question')!.children.push('external');
    f.rems.set('external', native('external', ['External'], { parent: 'question' }));
    await expect(
      pushWorkspace(directory, async () => f.backend, {
        ...options,
        apply: true,
        planHash: preview.planHash,
      })
    ).rejects.toThrow('frozen');
    expect(f.backend.remove).not.toHaveBeenCalled();
  });
  it('requires both destructive gates and never retries an unknown deletion', async () => {
    const f = await prepare(),
      options = { deleteId: 'question', scopeRoot: 'daily' };
    const preview = (await pushWorkspace(directory, async () => f.backend, options)) as {
      planHash: string;
    };
    f.backend.identity = vi.fn(async () => ({ kbId: 'kb', writable: true, destructive: false }));
    await expect(
      pushWorkspace(directory, async () => f.backend, {
        ...options,
        apply: true,
        planHash: preview.planHash,
      })
    ).rejects.toThrow('--allow-destructive');
    f.backend.identity = vi.fn(async () => ({ kbId: 'kb', writable: true, destructive: true }));
    const remove = f.backend.remove;
    f.backend.remove = vi.fn(async (id) => {
      await remove(id);
      throw new Error('delete acknowledgement lost');
    });
    expect(
      await pushWorkspace(directory, async () => f.backend, {
        ...options,
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({ status: 'unknown' });
    await expect(
      pushWorkspace(directory, async () => f.backend, {
        ...options,
        apply: true,
        planHash: preview.planHash,
      })
    ).rejects.toThrow('reconciliation');
    expect(f.backend.remove).toHaveBeenCalledTimes(1);
  });
  it('parses only the controlled outline, not arbitrary markdown documents', () => {
    expect(
      parseFrontmatter('test.md', '# Root <!-- rem:r -->\n\n| table |\n').diagnostics
    ).not.toEqual([]);
  });
  it('imports an exact subtree without global discovery, retaining its native external parent', async () => {
    const f = fixture();
    expect(
      await importWorkspace(directory, 'kb', async () => f.backend, { rootId: 'chapter' })
    ).toMatchObject({
      status: 'imported',
      scope: 'subtree',
      globalDiscoveryComplete: false,
      rems: 3,
    });
    expect(f.backend.enumerate).not.toHaveBeenCalled();
    const state = await loadState(directory);
    expect(Object.keys(state.documents)).toEqual(['Chapter.md']);
    expect(await diffWorkspace(directory)).toMatchObject({ changes: [] });
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    await expect(importWorkspace(directory, 'kb', async () => f.backend)).rejects.toThrow(
      'initialized'
    );
    await expect(
      importWorkspace(directory, 'kb', async () => f.backend, { rootId: 'daily' })
    ).rejects.toThrow('initialized');
    expect(f.backend.subtree).toHaveBeenCalledTimes(1);
  });
  it('never refreshes even a clean local source after remote top-level additions', async () => {
    const f = await prepare();
    f.rems.set('newRoot', native('newRoot'));
    const factory = vi.fn(async () => f.backend);
    await expect(importWorkspace(directory, 'kb', factory)).rejects.toThrow('initialized');
    expect(await statusWorkspace(directory)).toMatchObject({
      scope: 'library',
      rems: 8,
    });
    expect(factory).not.toHaveBeenCalled();
    expect(f.backend.enumerate).toHaveBeenCalledTimes(1);
    expect(f.backend.subtree).not.toHaveBeenCalled();
  });
  it('deletes within a scoped root whose real parent is outside the working copy', async () => {
    const f = fixture();
    await importWorkspace(directory, 'kb', async () => f.backend, { rootId: 'chapter' });
    const options = { deleteId: 'question', scopeRoot: 'chapter' };
    const preview = (await pushWorkspace(directory, async () => f.backend, options)) as {
      planHash: string;
    };
    expect(
      await pushWorkspace(directory, async () => f.backend, {
        ...options,
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({ complete: true });
    expect(f.rems.get('chapter')?.parent).toBe('daily');
    expect(f.rems.has('question')).toBe(false);
    expect(f.rems.has('daily')).toBe(true);
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
  });
  it('retains native external/dangling refs but rejects adding or retargeting unknown refs', async () => {
    const f = fixture();
    f.rems.get('answer')!.text = ['See ', { i: 'q', _id: 'outside' }];
    await importWorkspace(directory, 'kb', async () => f.backend, { rootId: 'chapter' });
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    expect(await diffWorkspace(directory)).toMatchObject({ changes: [] });
    const path = 'Chapter.md',
      baseline = await readPrivate(directory, path);
    await writePrivate(directory, path, baseline.replaceAll('outside', 'newUnknown'));
    expect(await lintWorkspace(directory)).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'DANGLING_REFERENCE' }),
      ]),
    });
    await writePrivate(
      directory,
      path,
      addNodes(baseline, { copy: 'text' }, '\n- [outside](remnote:outside) ^local-copy\n')
    );
    expect(await lintWorkspace(directory)).toMatchObject({ ok: false });
  });
  it('merges a remote-only existing question edit as incoming, preserving native Rem/Card IDs', async () => {
    const f = await prepare();
    const cards = await f.backend.cardFacts('question');
    f.rems.get('question')!.text = ['Why now?'];
    const preview = (await pushWorkspace(directory, async () => f.backend)) as { planHash: string };
    expect(preview).toMatchObject({ status: 'preview', incoming: ['question'], updates: 0 });
    expect(f.calls).toEqual([]);
    expect(
      await pushWorkspace(directory, async () => f.backend, {
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({ status: 'verified', updated: [], incoming: ['question'] });
    expect(await readPrivate(directory, f.path)).toContain(
      `Why now? ^${nativeBlockId('question')}`
    );
    expect(await f.backend.cardFacts('question')).toEqual(cards);
    expect(f.calls).toEqual([]);
  });
  it('treats an untouched softbreak node as incoming rather than a fabricated local conflict', async () => {
    const f = fixture();
    f.rems.get('answer')!.text = ['First line\nSecond line'];
    await importWorkspace(directory, 'kb', async () => f.backend);
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    expect(await diffWorkspace(directory)).toMatchObject({ changes: [] });
    f.rems.get('answer')!.text = ['First line\nRemote second line'];
    const preview = (await pushWorkspace(directory, async () => f.backend)) as { planHash: string };
    expect(preview).toMatchObject({ status: 'preview', incoming: ['answer'], updates: 0 });
    expect(
      await pushWorkspace(directory, async () => f.backend, {
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({ status: 'verified', incoming: ['answer'], updated: [], remoteWrites: 0 });
    expect(f.calls).toEqual([]);
    const state = await loadState(directory),
      path = state.entries.answer!.path;
    const parsed = (await inspectLocal(directory)).parsed.get(path)!;
    expect(parsed.nodes.find((node) => node.key === 'answer')!.text).toEqual([
      'First line\nRemote second line',
    ]);
  });
  it('merges different Rem edits in one file in both directions without losing either edit', async () => {
    const f = await prepare();
    await edit(f.path, (s) => s.replace('Because', 'Local answer'));
    f.rems.get('question')!.text = ['Remote question'];
    const preview = (await pushWorkspace(directory, async () => f.backend)) as { planHash: string };
    expect(preview).toMatchObject({ incoming: ['question'], updates: 1 });
    expect(
      await pushWorkspace(directory, async () => f.backend, {
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({ status: 'verified', updated: ['answer'] });
    expect(f.rems.get('answer')!.text).toEqual(['Local answer']);
    const source = await readPrivate(directory, f.path);
    expect(source).toContain('Remote question');
    expect(source).toContain('Local answer');
    expect(await diffWorkspace(directory)).toMatchObject({ changes: [] });
  });
  it('converges equal edits without remote writes and keeps both versions of an unordered conflict', async () => {
    const f = await prepare();
    await edit(f.path, (s) => s.replace('Because', 'Same answer'));
    f.rems.get('answer')!.text = ['Same answer'];
    const preview = (await pushWorkspace(directory, async () => f.backend)) as { planHash: string };
    expect(preview).toMatchObject({ updates: 0, incoming: [], converged: ['answer'] });
    expect(
      await pushWorkspace(directory, async () => f.backend, {
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({ status: 'verified' });
    expect(f.calls).toEqual([]);
    await edit(f.path, (s) => s.replace('Same answer', 'Local version'));
    f.rems.get('answer')!.text = ['Remote version'];
    const conflict = (await pushWorkspace(directory, async () => f.backend)) as {
      conflicts: Array<{ remoteSnapshot: string }>;
    };
    expect(conflict).toMatchObject({
      status: 'conflict',
      complete: false,
      conflicts: [expect.objectContaining({ id: 'answer', reason: 'untrusted-edit-order' })],
    });
    expect(await readPrivate(directory, f.path)).toContain('Local version');
    expect(
      JSON.parse(await readPrivate(directory, conflict.conflicts[0]!.remoteSnapshot)).text
    ).toEqual(['Remote version']);
    expect(f.calls).toEqual([]);
  });
  it('rejects a new remote revision between preview and apply before any write', async () => {
    const f = await prepare();
    await edit(f.path, (s) => s.replace('Because', 'Local edit'));
    const preview = (await pushWorkspace(directory, async () => f.backend)) as { planHash: string };
    f.rems.get('question')!.text = ['A later remote question'];
    await expect(
      pushWorkspace(directory, async () => f.backend, { apply: true, planHash: preview.planHash })
    ).rejects.toThrow('frozen');
    expect(f.calls).toEqual([]);
  });
  it('treats review history as remote-owned metadata, not a content conflict or a field to write', async () => {
    const f = await prepare();
    await edit(f.path, (s) => s.replace('Because', 'Local answer'));
    f.rems.get('question')!.cards = [
      {
        id: 'card-question',
        remId: 'question',
        type: 'forward',
        createdAt: 1,
        repetitionHistory: [{ time: 20 }],
        nextRepetitionTime: 30,
        lastRepetitionTime: 20,
        timesWrongInRow: 0,
      },
    ];
    const preview = (await pushWorkspace(directory, async () => f.backend)) as { planHash: string };
    expect(preview).toMatchObject({ incoming: [], updates: 1 });
    expect(
      await pushWorkspace(directory, async () => f.backend, {
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({ status: 'verified' });
    expect(
      JSON.parse(
        await readPrivate(directory, (await loadState(directory)).entries.question!.rawPath)
      ).cards[0].repetitionHistory
    ).toEqual([{ time: 20 }]);
    expect(f.calls).toEqual(['answer:text']);
  });
  it('retains partial native facts and unknown public fields without applying schema defaults to originals', async () => {
    const f = fixture();
    f.rems.get('answer')!.facts = { isTodo: null, propertyType: 0 };
    f.rems.get('answer')!.collected = ['isTodo', 'propertyType'];
    f.rems.get('answer')!.public = {
      futureField: { nested: [null, { value: 'original' }] },
      updatedAt: 10,
    };
    expect(await importWorkspace(directory, 'kb', async () => f.backend)).toMatchObject({
      complete: true,
    });
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    const state = await loadState(directory),
      entry = state.entries.answer!;
    const raw = JSON.parse(await readPrivate(directory, entry.rawPath));
    expect(raw.facts).toEqual({ isTodo: null, propertyType: 0 });
    expect(raw.public.futureField).toEqual({ nested: [null, { value: 'original' }] });
    const meta = (await inspectLocal(directory)).parsed.get(entry.path)!.metadata!.rems.answer!;
    if (meta.id === null) throw new Error('Expected existing native metadata');
    expect(meta.native.collected).toContain('isTodo');
    expect(meta.native.collected).not.toContain('isQuote');
    expect(meta.native.isTodo).toBeNull();
    expect(meta.native.isQuote).toBeNull();
  });
  it('accepts review-only changes between preview and apply without overwriting history or scheduling', async () => {
    const f = await prepare();
    await edit(f.path, (source) => source.replace('Because', 'Local answer'));
    const preview = (await pushWorkspace(directory, async () => f.backend)) as { planHash: string };
    const card = (await f.backend.read(['question']))[0]!.cards![0]!;
    f.rems.get('question')!.cards = [
      {
        ...card,
        repetitionHistory: [{ time: 25 }],
        nextRepetitionTime: 40,
        lastRepetitionTime: 25,
      },
    ];
    f.rems.get('question')!.public = { updatedAt: 25, localUpdatedAt: 50 };
    expect(
      await pushWorkspace(directory, async () => f.backend, {
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({ status: 'verified', updated: ['answer'] });
    const state = await loadState(directory),
      raw = JSON.parse(await readPrivate(directory, state.entries.question!.rawPath));
    expect(raw.cards[0]).toMatchObject({
      id: card.id,
      repetitionHistory: [{ time: 25 }],
      nextRepetitionTime: 40,
    });
    expect(f.calls).toEqual(['answer:text']);
  });
  it('applies incoming-only edits with the native write gate disabled', async () => {
    const f = await prepare();
    f.rems.get('answer')!.text = ['Remote answer'];
    f.backend.identity = vi.fn(async () => ({ kbId: 'kb', writable: false, destructive: false }));
    const preview = (await pushWorkspace(directory, async () => f.backend)) as { planHash: string };
    expect(
      await pushWorkspace(directory, async () => f.backend, {
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({ status: 'verified', incoming: ['answer'], updated: [] });
    expect(f.calls).toEqual([]);
    expect(await readPrivate(directory, f.path)).toContain('Remote answer');
  });
  it('keeps an entire mixed batch write-free when one Rem has an unordered content conflict', async () => {
    const f = await prepare();
    await edit(f.path, (source) =>
      addNodes(
        source.replace('Because', 'Local answer'),
        { n: 'text' },
        '\n- New local note ^local-n\n'
      )
    );
    f.rems.get('answer')!.text = ['Remote answer'];
    f.rems.get('question')!.text = ['Incoming question'];
    const before = await readPrivate(directory, f.path);
    expect(await pushWorkspace(directory, async () => f.backend)).toMatchObject({
      status: 'conflict',
      complete: false,
      remoteWrites: 0,
    });
    expect(await readPrivate(directory, f.path)).toBe(before);
    expect(f.calls).toEqual([]);
    expect((await loadState(directory)).entries).toEqual(f.state.entries);
  });
  it.each(['missing', 'new-child', 'move'] as const)(
    'reports remote %s without silently claiming global discovery or deleting content',
    async (kind) => {
      const f = await prepare();
      const before = await readPrivate(directory, f.path);
      if (kind === 'missing') f.rems.delete('answer');
      else if (kind === 'new-child') {
        f.rems.get('chapter')!.children.push('unbound');
        f.rems.set('unbound', native('unbound', ['Remote new child'], { parent: 'chapter' }));
      } else {
        f.rems.get('answer')!.parent = 'chapter';
        f.rems.get('question')!.children = [];
        f.rems.get('chapter')!.children.push('answer');
      }
      const result = (await pushWorkspace(directory, async () => f.backend)) as {
        conflicts: Array<{ reason: string }>;
      };
      expect(result).toMatchObject({
        status: 'conflict',
        complete: false,
        discoveryScope: 'bound-ids',
        globalDiscoveryComplete: false,
        remoteWrites: 0,
      });
      expect(
        result.conflicts.some(
          (conflict) =>
            conflict.reason === (kind === 'missing' ? 'remote-missing' : 'remote-structure')
        )
      ).toBe(true);
      expect(await readPrivate(directory, f.path)).toBe(before);
      expect(f.calls).toEqual([]);
      expect(f.backend.enumerate).toHaveBeenCalledTimes(1);
    }
  );
  it('publishes local aliases, tags, comments and filename changes without moving or rewriting a native Rem', async () => {
    const f = await prepare();
    const renamedPath = 'HOME/Renamed.md';
    await edit(f.path, (source) => {
      const parsed = parseFrontmatter(f.path, source),
        metadata = parsed.attributes!;
      metadata.title = 'Display only';
      metadata.aliases = ['Alternative'];
      metadata.tags = ['obsidian-tag'];
      return (
        renderFrontmatter(metadata).replace(
          'title: Display only',
          'title: "Display only" # preserve comment'
        ) +
        `<!-- remnote:${parsed.documentKey} -->\n\n` +
        parsed.body
      );
    });
    await rename(join(directory, f.path), join(directory, renamedPath));
    // Update the parent's real wiki link after the local rename.
    const homePath = f.state.entries.home!.path;
    await edit(homePath, (source) => source.replaceAll('HOME/Today|', 'HOME/Renamed|'));
    const before = await readPrivate(directory, renamedPath);
    expect(await diffWorkspace(directory)).toMatchObject({ changes: [], remoteChecked: false });
    const preview = (await pushWorkspace(directory, async () => f.backend)) as { planHash: string };
    expect(
      await pushWorkspace(directory, async () => f.backend, {
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({ status: 'verified', updated: [] });
    expect((await loadState(directory)).entries.answer!.path).toBe(renamedPath);
    expect(await readPrivate(directory, renamedPath)).toBe(before);
    expect(f.rems.get('daily')!.text).toEqual(['Today']);
    expect(f.calls).toEqual([]);
  });
  it('rejects broken wiki links after a local rename before connecting remotely', async () => {
    const f = await prepare(),
      factory = vi.fn(async () => f.backend);
    await rename(join(directory, f.path), join(directory, 'HOME/Renamed.md'));
    await expect(pushWorkspace(directory, factory)).rejects.toThrow('Unknown');
    expect(factory).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });
  it('keeps newly published local block IDs stable and resolves subsequent wiki links to their native IDs', async () => {
    const f = await prepare();
    await edit(f.path, (source) =>
      addNodes(source, { note: 'text' }, '\n- New note ^local-note\n')
    );
    const first = (await pushWorkspace(directory, async () => f.backend)) as { planHash: string };
    const applied = (await pushWorkspace(directory, async () => f.backend, {
      apply: true,
      planHash: first.planHash,
    })) as { ids: Record<string, string> };
    const created = applied.ids[newKeys.note!]!;
    expect((await loadState(directory)).entries[created]!.blockId).toBe('local-note');
    await edit(f.path, (source) =>
      source.replace('Because', '[[HOME/Today#^local-note|New note]]')
    );
    const second = (await pushWorkspace(directory, async () => f.backend)) as { planHash: string };
    expect(
      await pushWorkspace(directory, async () => f.backend, {
        apply: true,
        planHash: second.planHash,
      })
    ).toMatchObject({ status: 'verified' });
    expect(f.rems.get('answer')!.text).toEqual([{ i: 'q', _id: created }]);
    expect(await readPrivate(directory, f.path)).toContain('^local-note');
  });
  it('ignores Obsidian UI files and publishes ordinary 0644 Markdown while keeping metadata private', async () => {
    const f = await prepare();
    await mkdir(join(directory, '.obsidian'), { mode: 0o700 });
    await writeFile(join(directory, '.obsidian/workspace.json'), '{}', { mode: 0o644 });
    await writeFile(join(directory, 'HOME/.DS_Store'), 'ui-state', { mode: 0o644 });
    await edit(f.path, (source) => source.replace('Because', 'New answer'));
    await chmod(join(directory, f.path), 0o644);
    f.rems.get('question')!.text = ['Incoming question'];
    const preview = (await pushWorkspace(directory, async () => f.backend)) as { planHash: string };
    await writeFile(join(directory, '.obsidian/workspace.json'), '{"active":"other"}');
    expect(
      await pushWorkspace(directory, async () => f.backend, {
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({ status: 'verified' });
    expect((await stat(join(directory, f.path))).mode & 0o777).toBe(0o600);
    expect(
      (await fileOps.allFiles(directory)).some(
        (path) => path.includes('.obsidian') || path.includes('.DS_Store')
      )
    ).toBe(false);
    await chmod(join(directory, '.sync/state.json'), 0o644);
    await expect(statusWorkspace(directory)).rejects.toThrow('Unsafe');
  });
  it('restores a displaced concurrent 0644 editor save without relaxing staging permissions', async () => {
    const f = await prepare();
    await edit(f.path, (source) => source.replace('Because', 'New answer'));
    f.rems.get('question')!.text = ['Incoming question'];
    const preview = (await pushWorkspace(directory, async () => f.backend)) as { planHash: string };
    const original = fileOps.displacePrivate;
    let injected = false;
    vi.spyOn(fileOps, 'displacePrivate').mockImplementation(async (root, path, backup) => {
      if (!injected && path === f.path) {
        injected = true;
        await writeFile(join(root, path), 'EDITOR_SAVE');
        await chmod(join(root, path), 0o644);
      }
      await original(root, path, backup);
    });
    expect(
      await pushWorkspace(directory, async () => f.backend, {
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({ status: 'publication-incomplete' });
    expect(injected).toBe(true);
    expect(await readPrivate(directory, f.path)).toBe('EDITOR_SAVE');
    expect((await stat(join(directory, f.path))).mode & 0o777).toBe(0o600);
  });
  it('uses safe stable paths for literal .md names, case and Unicode collisions', () => {
    const rems = [
      native('a', ['Note.md']),
      native('b', ['note']),
      native('c', ['Café']),
      native('d', ['Cafe\u0301']),
      native('e', ['A#B|C^D%[E]']),
    ];
    const paths = documentPaths(rems);
    expect(paths.get('a')).toBe('Note.md');
    expect(
      new Set([...paths.values()].map((path) => path.normalize('NFC').toLowerCase())).size
    ).toBe(rems.length);
    for (const path of paths.values()) expect(path).not.toMatch(/[#|^%[\]]/);
    expect(documentPaths([...rems].reverse())).toEqual(paths);
  });
});
