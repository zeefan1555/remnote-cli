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
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diffWorkspace,
  lintWorkspace,
  importWorkspace,
  pushWorkspace,
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
import { parseDocument } from '../../../src/business/workspace/markdown.js';
import { parseFrontmatter, renderFrontmatter } from '../../../src/business/workspace/metadata.js';
import {
  contentProjection,
  immutableProjection,
} from '../../../src/business/workspace/snapshots.js';
import { reconcile } from '../../../src/business/workspace/reconcile.js';
import { readPublication } from '../../../src/business/workspace/publication.js';

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
function addNodes(
  source: string,
  nodes: Record<string, 'text' | 'multiline'>,
  body: string
): string {
  const parsed = parseFrontmatter('test.md', source),
    metadata = parsed.metadata!;
  for (const [key, content] of Object.entries(nodes))
    metadata.rems[`new:${key}`] = { id: null, block: `local-${key}`, content };
  return renderFrontmatter(metadata) + parsed.body + body;
}

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
      changed: ['new:a', 'new:q'],
      remoteWrites: 0,
    });
    expect(Object.keys((await loadState(directory)).localVersions!).sort()).toEqual([
      'new:a',
      'new:q',
    ]);
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
      ids: { 'new:q': 'created_1', 'new:a': 'created_2' },
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
      const current = await workspace.readWorkspace(directory, f.path);
      const basic = parseDocument(f.path, current.content).document.nodes.find(
        (node) => node.key === 'basic'
      )!;
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
    'reads a version-less manifest without changing its seal and respects its %s journal',
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
      if (journalState === 'unknown') {
        await expect(pushWorkspace(directory, async () => f.backend)).rejects.toThrow(
          'Prior write outcome'
        );
        await expect(
          save(f.path, (source) => source.replace('Because', 'Must not overwrite'))
        ).rejects.toThrow('Prior write outcome');
        expect(hash(await loadState(directory))).toBe(stateHash);
      } else {
        const preview = (await pushWorkspace(directory, async () => f.backend)) as {
          planHash: string;
        };
        expect(preview).toMatchObject({ status: 'preview', remoteWrites: 0 });
        expect(preview.planHash).not.toBe(oldHash);
        expect((await loadState(directory)).pending!.planHash).toBe(preview.planHash);
      }
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
    expect(await readPrivate(directory, f.path)).toContain('content: multiline');
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
      ids: { 'new:q': 'created_1', 'new:a': 'created_2' },
    });
    expect(f.rems.get('created_1')!.document).toBe(false);
    expect(f.rems.get('created_1')!.cardItem).toBe(false);
    expect(f.rems.get('created_2')!.parent).toBe('created_1');
    expect(f.rems.get('created_2')!.cardItem).toBe(true);
    expect(f.backend.setCardItem).toHaveBeenCalledWith('created_2', true);
    expect(await readPrivate(directory, f.path)).toContain('id: created_1');
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
    ['remove ID', (s: string) => s.replace('^rn-616e73776572', ''), 'BLOCK_BINDING'],
    [
      'unknown reference',
      (s: string) => s.replace('Because', '[missing](remnote:missing)'),
      'DANGLING_REFERENCE',
    ],
    ['opaque edit', (s: string) => s.replace('Cloze ^', 'Changed cloze ^'), 'OPAQUE_EDIT'],
    [
      'card-kind change',
      (s: string) => s.replace('content: multiline', 'content: text'),
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
    ).toMatchObject({ status: 'unknown', ids: { 'new:n': 'created_1' } });
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
      parseDocument('test.md', '# Root <!-- rem:r -->\n\n| table |\n').diagnostics
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
    expect(await readPrivate(directory, f.path)).toContain('Why now? ^rn-7175657374696f6e');
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
    const parsed = parseDocument(path, await readPrivate(directory, path));
    expect(parsed.document.nodes.find((node) => node.key === 'answer')!.text).toEqual([
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
    const meta = parseFrontmatter(entry.path, await readPrivate(directory, entry.path)).metadata!
      .rems.answer!;
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
        metadata = parsed.metadata!;
      metadata.title = 'Display only';
      metadata.aliases = ['Alternative'];
      metadata.tags = ['obsidian-tag'];
      return (
        renderFrontmatter(metadata).replace(
          'schema: remnote-sync/1',
          'schema: "remnote-sync/1" # preserve comment'
        ) + parsed.body
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
    const created = applied.ids['new:note']!;
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
