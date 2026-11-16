import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alignWorkspaceBaseline } from '../../../src/business/workspace/baseline.js';
import { insertBaselineChildren } from '../../../src/business/workspace/baseline-children.js';
import {
  inspectLocal,
  loadState,
  saveState,
  writeSnapshot,
} from '../../../src/business/workspace/local.js';
import * as files from '../../../src/business/workspace/files.js';
import { readPublication, recoverWorkspace } from '../../../src/business/workspace/publication.js';
import {
  hash,
  type WorkspaceBackend,
  type WorkspaceRem,
} from '../../../src/business/workspace/types.js';

let temporary: string, directory: string;
beforeEach(async () => {
  temporary = await realpath(await mkdtemp(join(tmpdir(), 'remnote-exact-children-test-')));
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
async function fixture(multiline = false, knownReferences = false) {
  const old = [
    native('doc', { document: true, children: ['parent', 'sibling'] }),
    native('parent', {
      parent: 'doc',
      children: ['first', 'last'],
      propertyValues: [],
      cards: [
        {
          id: 'card_parent',
          remId: 'parent',
          type: 'forward',
          createdAt: 1,
          repetitionHistory: [{ score: 1 }],
          nextRepetitionTime: 2,
          lastRepetitionTime: 1,
          timesWrongInRow: 0,
        },
      ],
    }),
    native('first', { parent: 'parent', children: ['nested'] }),
    native('nested', { parent: 'first' }),
    native('last', { parent: 'parent' }),
    native('sibling', { parent: 'doc' }),
  ];
  if (multiline) {
    old[1]!.backText = [];
    old[2]!.children = [];
    old[2]!.cardItem = true;
    old[4]!.cardItem = true;
    old.splice(3, 1);
  }
  if (knownReferences) old.find((rem) => rem.id === 'last')!.references = ['known'];
  const state = await writeSnapshot(directory, 'kb', old);
  const path = state.entries.doc!.path;
  const rems = new Map(old.map((rem) => [rem.id, structuredClone(rem)]));
  const additions = Array.from({ length: 12 }, (_, i) =>
    native(`added_${i}`, {
      parent: 'parent',
      text: i % 2 ? [] : [`new ${i}`],
      cardItem: multiline || i === 0,
      public: { id: `added_${i}`, retained: 'native evidence' },
    })
  );
  for (const rem of additions) rems.set(rem.id, rem);
  rems.get('parent')!.children = [
    additions[0]!.id,
    'first',
    ...additions.slice(1, 7).map((r) => r.id),
    'last',
    ...additions.slice(7).map((r) => r.id),
  ];
  const backend = {
    identity: vi.fn(async () => ({ kbId: 'kb', writable: false })),
    read: vi.fn(async (ids: string[]) =>
      ids.filter((id) => rems.has(id)).map((id) => structuredClone(rems.get(id)!))
    ),
  } as unknown as WorkspaceBackend;
  const connect = vi.fn(async () => backend);
  const options = {
    paths: [path],
    acceptNewParent: ['parent'],
    acceptNewChild: additions.map((r) => r.id),
  };
  return { old, state, path, rems, backend, connect, options };
}

describe('explicit exact new children baseline initialization', () => {
  it.each([
    'old-type',
    'old-portal',
    'old-type-changed',
    'current-type',
    'current-portal',
  ] as const)('never reads an exact child across a Portal boundary: %s', async (variant) => {
    const portal = { type: null, directlyIncludedRemIds: [], query: null, filter: null };
    const isOldPortal = variant === 'old-type' || variant === 'old-type-changed';
    const old = [
      native('doc', { document: true, children: ['parent'] }),
      native('parent', {
        parent: 'doc',
        ...(isOldPortal ? { type: 6, portal } : {}),
        ...(variant === 'old-portal' ? { portal } : {}),
      }),
    ];
    const state = await writeSnapshot(directory, 'kb', old);
    const path = state.entries.doc!.path;
    const source = await files.readPrivate(directory, path);
    const rems = new Map(old.map((rem) => [rem.id, structuredClone(rem)]));
    const parent = rems.get('parent')!;
    parent.children.push('new');
    if (variant === 'old-type-changed') {
      parent.type = null;
      delete parent.portal;
    }
    if (variant === 'current-type') parent.type = 6;
    if (variant === 'current-portal') parent.portal = portal;
    rems.set('new', native('new', { parent: 'parent' }));
    const backend = {
      identity: vi.fn(async () => ({ kbId: 'kb', writable: false })),
      read: vi.fn(async (ids: string[]) => ids.map((id) => structuredClone(rems.get(id)!))),
    } as unknown as WorkspaceBackend;
    await expect(
      alignWorkspaceBaseline(directory, async () => backend, {
        paths: [path],
        acceptNewParent: ['parent'],
        acceptNewChild: ['new'],
      })
    ).rejects.toThrow(/Portal/);
    expect(backend.read).not.toHaveBeenCalledWith(
      expect.arrayContaining(['new']),
      expect.anything()
    );
    expect(await files.readPrivate(directory, path)).toBe(source);
    expect(await loadState(directory)).toEqual(state);
    expect(await readPublication(directory)).toBeUndefined();
  });
  it('retains known references when the SDK omits this supplemental field', async () => {
    const f = await fixture(false, true);
    delete f.rems.get('last')!.references;
    const preview = await alignWorkspaceBaseline(directory, f.connect, f.options);
    await alignWorkspaceBaseline(directory, f.connect, {
      ...f.options,
      apply: true,
      planHash: preview.planHash,
    });
    expect((await inspectLocal(directory)).native.get('last')!.references).toEqual(['known']);
  });
  it('checks the parent again before re-reading new children during apply', async () => {
    const f = await fixture();
    const source = await files.readPrivate(directory, f.path);
    const preview = await alignWorkspaceBaseline(directory, f.connect, f.options);
    let parentReads = 0;
    const calls: string[][] = [];
    vi.spyOn(f.backend, 'read').mockImplementation(async (ids) => {
      calls.push(ids);
      if (ids.includes('parent') && ++parentReads === 2) f.rems.get('parent')!.type = 6;
      return ids.map((id) => structuredClone(f.rems.get(id)!));
    });
    await expect(
      alignWorkspaceBaseline(directory, f.connect, {
        ...f.options,
        apply: true,
        planHash: preview.planHash,
      })
    ).rejects.toThrow(/Portal/);
    expect(calls.filter((ids) => ids.includes('added_0'))).toHaveLength(1);
    expect(await files.readPrivate(directory, f.path)).toBe(source);
    expect(await loadState(directory)).toEqual(f.state);
    expect(await readPublication(directory)).toBeUndefined();
  });
  it('does not mask unknown tags when preserving uncollected references', async () => {
    const f = await fixture(false, true);
    delete f.rems.get('last')!.references;
    f.rems.get('last')!.tags = null;
    await expect(alignWorkspaceBaseline(directory, f.connect, f.options)).rejects.toThrow(
      'Unknown native tags'
    );
    expect(await loadState(directory)).toEqual(f.state);
  });
  it.each([[[]], [['different']]])(
    'rejects actually observed reference drift %j',
    async (references) => {
      const f = await fixture(false, true);
      f.rems.get('last')!.references = references;
      await expect(alignWorkspaceBaseline(directory, f.connect, f.options)).rejects.toThrow(
        'drifted'
      );
      expect(await loadState(directory)).toEqual(f.state);
    }
  );
  it('inserts under two exact parents without changing any existing source bytes', async () => {
    const f = await fixture();
    const additions = ['added_0', 'sibling_added'];
    f.rems.get('parent')!.children = ['first', 'last', 'added_0'];
    f.rems.get('sibling')!.children = ['sibling_added'];
    f.rems.set('sibling_added', native('sibling_added', { parent: 'sibling' }));
    f.options.acceptNewParent = ['parent', 'sibling'];
    f.options.acceptNewChild = additions;
    const source = (await files.readPrivate(directory, f.path)).replace('- last ', '-   last  ');
    await files.writePrivate(directory, f.path, source);
    f.state.documents[f.path]!.fileHash = hash(source);
    await saveState(directory, f.state);
    const preview = await alignWorkspaceBaseline(directory, f.connect, f.options);
    await alignWorkspaceBaseline(directory, f.connect, {
      ...f.options,
      apply: true,
      planHash: preview.planHash,
    });
    const after = await inspectLocal(directory);
    const written = await files.readPrivate(directory, f.path);
    expect(
      written
        .split('\n')
        .filter(
          (line) => !additions.some((id) => line.includes(`^${after.state.entries[id]!.blockId}`))
        )
        .join('\n')
    ).toBe(source);
    expect(after.diagnostics).toEqual([]);
    expect(after.dirty).toEqual([]);
  });
  it.each(['extra', 'order', 'body', 'wrong-parent', 'empty-parent', 'stale'] as const)(
    'rejects %s in a multi-parent acceptance',
    async (kind) => {
      const f = await fixture();
      f.rems.get('parent')!.children = ['first', 'last', 'added_0'];
      f.rems.get('sibling')!.children = ['sibling_added'];
      f.rems.set('sibling_added', native('sibling_added', { parent: 'sibling' }));
      f.options.acceptNewParent = ['parent', 'sibling'];
      f.options.acceptNewChild = ['added_0', 'sibling_added'];
      if (kind === 'extra') f.rems.get('parent')!.children.push('added_1');
      if (kind === 'order') f.rems.get('parent')!.children = ['last', 'first', 'added_0'];
      if (kind === 'body') f.rems.get('sibling')!.text = ['unexpected edit'];
      if (kind === 'wrong-parent') f.rems.get('sibling_added')!.parent = 'parent';
      if (kind === 'empty-parent') {
        f.options.acceptNewParent.push('first');
      }
      if (kind === 'stale') {
        const preview = await alignWorkspaceBaseline(directory, f.connect, f.options);
        f.options.acceptNewParent.reverse();
        await expect(
          alignWorkspaceBaseline(directory, f.connect, {
            ...f.options,
            apply: true,
            planHash: preview.planHash,
          })
        ).rejects.toThrow();
      } else
        await expect(alignWorkspaceBaseline(directory, f.connect, f.options)).rejects.toThrow();
      expect(await loadState(directory)).toEqual(f.state);
    }
  );
  it('keeps a multiline parent and all original cards while accepting twelve answer leaves including six empty leaves', async () => {
    const f = await fixture(true);
    const source = (await files.readPrivate(directory, f.path)).replace(/\n/g, '\r\n');
    await files.writePrivate(directory, f.path, source);
    f.state.documents[f.path]!.fileHash = hash(source);
    await saveState(directory, f.state);
    const before = await inspectLocal(directory);
    expect(before.diagnostics).toEqual([]);
    expect(before.parsed.get(f.path)!.nodes.find((n) => n.key === 'parent')!.kind).toBe(
      'multiline'
    );
    const preview = await alignWorkspaceBaseline(directory, f.connect, f.options);
    await alignWorkspaceBaseline(directory, f.connect, {
      ...f.options,
      apply: true,
      planHash: preview.planHash,
    });
    const after = await inspectLocal(directory);
    expect(after.diagnostics).toEqual([]);
    expect(after.dirty).toEqual([]);
    expect(after.parsed.get(f.path)!.nodes.find((n) => n.key === 'parent')!.kind).toBe('multiline');
    expect(after.state.entries.parent!.editable).toBe(true);
    expect(after.native.get('parent')!.cards).toEqual(f.old[1]!.cards);
    expect(after.native.get('parent')!.backText).toEqual([]);
    const written = await files.readPrivate(directory, f.path);
    expect(
      written
        .split('\r\n')
        .filter(
          (line) =>
            !f.options.acceptNewChild.some((id) =>
              line.includes(`^${after.state.entries[id]!.blockId}`)
            )
        )
        .join('\r\n')
    ).toBe(source);
  });
  it('refuses to downgrade a multiline parent when a new leaf is not a card item', async () => {
    const f = await fixture(true);
    f.rems.get('added_0')!.cardItem = false;
    await expect(alignWorkspaceBaseline(directory, f.connect, f.options)).rejects.toThrow(
      'parent content kind'
    );
    expect(await loadState(directory)).toEqual(f.state);
  });
  it('refuses a stale plan hash when the exact acceptance set changes', async () => {
    const f = await fixture();
    const preview = await alignWorkspaceBaseline(directory, f.connect, f.options);
    f.options.acceptNewChild = [...f.options.acceptNewChild].reverse();
    await expect(
      alignWorkspaceBaseline(directory, f.connect, {
        ...f.options,
        apply: true,
        planHash: preview.planHash,
      })
    ).rejects.toThrow('preview changed');
    expect(await loadState(directory)).toEqual(f.state);
  });
  it('previews zero writes and adds only the exact leaves in native order, preserving all existing nodes and records', async () => {
    const f = await fixture();
    const before = await inspectLocal(directory);
    expect(before.diagnostics).toEqual([]);
    const source = await files.readPrivate(directory, f.path);
    const preview = await alignWorkspaceBaseline(directory, f.connect, f.options);
    expect(preview).toMatchObject({ status: 'preview', remoteWrites: 0, childrenAccepted: 12 });
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
    expect(after.native.get('parent')).toEqual({
      ...f.old[1],
      children: f.rems.get('parent')!.children,
    });
    for (const old of f.old.filter((r) => r.id !== 'parent')) {
      expect(after.native.get(old.id)).toEqual(old);
      expect(after.state.entries[old.id]).toEqual(f.state.entries[old.id]);
    }
    const strip = (nodes: typeof before.parsed extends Map<string, infer V> ? V : never) =>
      nodes.nodes
        .filter((n) => !f.options.acceptNewChild.includes(n.key))
        .map(({ line: _line, children, ...node }) => ({
          ...node,
          children: children.filter((id) => !f.options.acceptNewChild.includes(id)),
        }));
    expect(strip(after.parsed.get(f.path)!)).toEqual(strip(before.parsed.get(f.path)!));
    const written = await files.readPrivate(directory, f.path);
    expect(
      written
        .split('\n')
        .filter(
          (line) =>
            !f.options.acceptNewChild.some((id) =>
              line.includes(`^${after.state.entries[id]!.blockId}`)
            )
        )
        .join('\n')
    ).toBe(source);
    for (const id of f.options.acceptNewChild) expect(after.native.get(id)).toEqual(f.rems.get(id));
    await expect(alignWorkspaceBaseline(directory, f.connect, f.options)).rejects.toThrow(
      'already bound'
    );
  });

  it.each([
    'missing-list',
    'duplicate',
    'bound',
    'extra',
    'missing',
    'reorder',
    'remove',
    'wrong-parent',
    'nonleaf',
    'unsafe',
    'unknown-flag',
    'tags',
    'old-text',
    'old-card',
  ] as const)('rejects %s without publication', async (kind) => {
    const f = await fixture();
    if (kind === 'missing-list') f.options.acceptNewChild = [];
    if (kind === 'duplicate') f.options.acceptNewChild.push(f.options.acceptNewChild[0]!);
    if (kind === 'bound') f.options.acceptNewChild.push('first');
    if (kind === 'extra') f.rems.get('parent')!.children.push('unrequested');
    if (kind === 'missing') f.options.acceptNewChild.pop();
    if (kind === 'reorder')
      f.rems.get('parent')!.children = ['last', 'first', ...f.options.acceptNewChild];
    if (kind === 'remove') f.rems.get('parent')!.children = ['first', ...f.options.acceptNewChild];
    if (kind === 'wrong-parent') f.rems.get('added_0')!.parent = 'doc';
    if (kind === 'nonleaf') f.rems.get('added_0')!.children = ['descendant'];
    if (kind === 'unsafe')
      f.rems.get('added_0')!.text = [{ i: 'image', url: 'https://example.invalid/' }];
    if (kind === 'unknown-flag') f.rems.get('added_0')!.cardItem = null;
    if (kind === 'tags') f.rems.get('added_0')!.tags = ['unbound-tag'];
    if (kind === 'old-text') f.rems.get('last')!.text = ['changed'];
    if (kind === 'old-card') f.rems.get('parent')!.cards = [];
    await expect(alignWorkspaceBaseline(directory, f.connect, f.options)).rejects.toThrow();
    expect(await loadState(directory)).toEqual(f.state);
    expect(await readPublication(directory)).toBeUndefined();
  });

  it.each(['parent', 'leaf', 'history', 'source', 'leaf-public'] as const)(
    'refuses concurrent %s changes before publication',
    async (kind) => {
      const f = await fixture();
      const preview = await alignWorkspaceBaseline(directory, f.connect, f.options);
      let calls = 0;
      vi.spyOn(f.backend, 'read').mockImplementation(async (ids) => {
        if (++calls === 2) {
          if (kind === 'parent') f.rems.get('parent')!.children.reverse();
          if (kind === 'leaf') f.rems.get('added_0')!.text = ['changed'];
          if (kind === 'leaf-public') f.rems.get('added_0')!.public!.retained = 'changed';
          if (kind === 'history')
            f.rems.get('parent')!.cards![0]!.repetitionHistory = [{ score: 2 }];
          if (kind === 'source')
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
          planHash: preview.planHash,
        })
      ).rejects.toThrow();
      expect(await loadState(directory)).toEqual(f.state);
    }
  );

  it('uses the local recovery ledger, never a native journal', async () => {
    const f = await fixture();
    const preview = await alignWorkspaceBaseline(directory, f.connect, f.options);
    const fault = vi
      .spyOn(files, 'linkPrivate')
      .mockRejectedValueOnce(new Error('synthetic interruption'));
    await expect(
      alignWorkspaceBaseline(directory, f.connect, {
        ...f.options,
        apply: true,
        planHash: preview.planHash,
      })
    ).rejects.toThrow('synthetic interruption');
    expect((await readPublication(directory))!.recovery).toEqual({ kind: 'local' });
    fault.mockRestore();
    await recoverWorkspace(directory);
    const after = await inspectLocal(directory);
    expect(after.diagnostics).toEqual([]);
    expect(after.dirty).toEqual([]);
    expect(hash(after.native.get('added_0'))).toBe(hash(f.rems.get('added_0')));
  });
});

describe('lossless exact-child insertion', () => {
  it('preserves BOM, CRLF, YAML comments, unusual indentation and old descendants', () => {
    const source =
      '\uFEFF---\r\n# preserve\r\naliases: [Day] # unchanged\r\n---\r\n<!-- remnote:doc -->\r\n\r\n# Day\r\n\r\n-   parent ^p\r\n    -   first ^f\r\n        - nested ^nested\r\n    - last ^l\r\n- sibling ^s\r\n';
    const rendered =
      '<!-- remnote:doc -->\n\n# Day\n\n- parent ^p\n  - new ^n1\n  - first ^f\n    - nested ^nested\n  - last ^l\n  - ^n2\n- sibling ^s\n';
    const actual = insertBaselineChildren(
      'Day.md',
      source,
      rendered,
      { block: 'p', root: false },
      ['n1', 'f', 'l', 'n2'],
      new Set(['n1', 'n2'])
    );
    expect(actual).toBe(
      source
        .replace('    -   first', '    - new ^n1\r\n    -   first')
        .replace('- sibling', '    - ^n2\r\n- sibling')
    );
  });
  it.each([true, false])(
    'adds the first child of a root=%s parent without replacing source',
    (root) => {
      const source = root
        ? '<!-- remnote:p -->\n\n# Parent\n'
        : '<!-- remnote:doc -->\n\n# Day\n\n-   parent ^p\n- sibling ^s\n';
      const rendered = root
        ? '<!-- remnote:p -->\n\n# Parent\n\n- new ^n\n'
        : '<!-- remnote:doc -->\n\n# Day\n\n- parent ^p\n  - new ^n\n- sibling ^s\n';
      const actual = insertBaselineChildren(
        'Day.md',
        source,
        rendered,
        { block: 'p', root },
        ['n'],
        new Set(['n'])
      );
      expect(actual).toBe(
        root ? source + '\n- new ^n\n' : source.replace('- sibling', '    - new ^n\n- sibling')
      );
    }
  );
  it('refuses an invisible old sibling anchor', () => {
    expect(() =>
      insertBaselineChildren(
        'Day.md',
        '# Day\n',
        '# Day\n\n- new ^n\n',
        { block: 'p', root: true },
        ['n', 'hidden'],
        new Set(['n'])
      )
    ).toThrow('No visible');
  });
});
