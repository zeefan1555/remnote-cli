import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
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
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  diffWorkspace,
  lintWorkspace,
  importWorkspace,
  pushWorkspace as syncWorkspace,
  statusWorkspace,
  recoverWorkspace,
  resumeWorkspace,
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
  publicationStore,
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
  workspaceIdentity,
} from '../../../src/business/workspace/identity.js';
import * as metadataOps from '../../../src/business/workspace/metadata.js';
import {
  contentProjection,
  immutableProjection,
} from '../../../src/business/workspace/snapshots.js';
import { reconcile } from '../../../src/business/workspace/reconcile.js';
import {
  readPublication,
  recoverWorkspace as recoverLocalPublication,
  type Publication,
} from '../../../src/business/workspace/publication.js';
import type { Journal } from '../../../src/business/workspace/resume.js';
import { formatWorkspace } from '../../../src/business/workspace/format.js';
import { stringify as yamlStringify } from 'yaml';
import { createProgram } from '../../../src/remnote-cli/cli.js';
import { DirectClient } from '../../../src/remnote-cli/client/direct-client.js';

let temporary: string, directory: string;
const syntheticCliChildren = new Set<ChildProcess>();
beforeEach(async () => {
  temporary = await realpath(await mkdtemp(join(tmpdir(), 'remnote-workspace-test-')));
  directory = join(temporary, 'remnote-obsidian');
  vi.stubEnv('REMNOTE_CLI_CONFIG', join(temporary, 'config', 'connection.json'));
});
afterEach(async () => {
  await Promise.all(
    [...syntheticCliChildren].map(async (child) => {
      const ended = once(child, 'exit');
      child.kill('SIGKILL');
      await ended;
    })
  );
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
    tags: [],
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
    readProbe: vi.fn(async (ids, options) =>
      ids.flatMap((id) =>
        rems.has(id)
          ? [
              {
                snapshot: snapshot(rems.get(id)!).public!,
                tags: rems.get(id)!.tags ?? [],
                ...(options?.powerupCodes?.[id]?.length
                  ? {
                      powerupPresence: Object.fromEntries(
                        options.powerupCodes[id].map((code) => [
                          code,
                          rems.get(id)!.powerupPresence?.[code] ??
                            rems.get(id)!.powerups?.some((powerup) => powerup.code === code) ??
                            false,
                        ])
                      ),
                    }
                  : {}),
              },
            ]
          : []
      )
    ),
    read: vi.fn(async (ids, options) =>
      ids.flatMap((id) =>
        rems.has(id)
          ? [
              {
                ...snapshot(rems.get(id)!),
                ...(options?.tags ? { tags: rems.get(id)!.tags ?? [] } : {}),
                ...(options?.powerupCodes?.[id]?.length
                  ? {
                      powerupPresence: Object.fromEntries(
                        options.powerupCodes[id].map((code) => [
                          code,
                          rems.get(id)!.powerupPresence?.[code] ??
                            rems.get(id)!.powerups?.some((powerup) => powerup.code === code) ??
                            false,
                        ])
                      ),
                    }
                  : {}),
              },
            ]
          : []
      )
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
          markdown ? ['Workspace question'] : [],
          markdown ? { cardItem: false, backText: [], practice: 'forward' } : {}
        )
      );
      return id;
    }),
    writeField: vi.fn(async (id, field, value) => {
      calls.push(`${id}:${field}`);
      rems.set(id, { ...rems.get(id)!, [field]: structuredClone(value) });
    }),
    addTag: vi.fn(async (id, tagId) => {
      calls.push(`${id}:tag:add:${tagId}`);
      rems.get(id)!.tags = [...new Set([...(rems.get(id)!.tags ?? []), tagId])].sort();
    }),
    removeTag: vi.fn(async (id, tagId) => {
      calls.push(`${id}:tag:remove:${tagId}`);
      rems.get(id)!.tags = (rems.get(id)!.tags ?? []).filter((tag) => tag !== tagId);
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
    setCardCluster: vi.fn(async (id) => {
      calls.push(`${id}:cardCluster`);
      rems.get(id)!.powerupPresence = { ...rems.get(id)!.powerupPresence, cc: true };
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

async function prepare(setup?: (f: ReturnType<typeof fixture>) => void) {
  const f = fixture();
  setup?.(f);
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

/** Exercise the public parser/command in an owned process; SDK effects stay in this synthetic fixture. */
function syntheticCli(
  backend: WorkspaceBackend,
  args: string[],
  pause?: 'lock' | 'writeField' | 'create'
) {
  const entry = resolve('src/remnote-cli/index.ts');
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    const fs = (await import('node:fs/promises')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const originalOpen = fs.open;
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (${JSON.stringify(pause)} === 'lock' && args[0] === ${JSON.stringify(join(directory, '.sync'))}) {
        const originalSync = handle.sync.bind(handle);
        handle.sync = async () => {
          await originalSync();
          process.send({ checkpoint: 'lock' });
          await new Promise(() => { setInterval(() => {}, 1000); });
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    const { DirectClient } = await import(${JSON.stringify(pathToFileURL(resolve('src/remnote-cli/client/direct-client.ts')).href)});
    const { localStore } = await import(${JSON.stringify(pathToFileURL(resolve('src/business/workspace/local.ts')).href)});
    const pending = new Map();
    let id = 0;
    process.on('message', reply => {
      const entry = pending.get(reply.id);
      if (!entry) return;
      pending.delete(reply.id);
      reply.error ? entry.reject(new Error(reply.error)) : entry.resolve(reply.value);
    });
    const backend = { journal: localStore('kb') };
    for (const method of ${JSON.stringify(Object.keys(backend).filter((key) => key !== 'journal'))}) {
      backend[method] = (...args) => new Promise((resolve, reject) => {
        pending.set(++id, { resolve, reject });
        process.send({ id, method, args });
      });
    }
    DirectClient.prototype.workspaceBackend = async () => backend;
    process.argv = [process.execPath, ${JSON.stringify(entry)}, ...${JSON.stringify(args)}];
    await import(${JSON.stringify(pathToFileURL(entry).href)});
    process.disconnect();
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced' }
  );
  syntheticCliChildren.add(child);
  child.once('exit', () => syntheticCliChildren.delete(child));
  let stdout = '',
    stderr = '';
  child.stdout!.on('data', (data) => {
    stdout += data;
  });
  child.stderr!.on('data', (data) => {
    stderr += data;
  });
  let reached!: () => void;
  const checkpoint = new Promise<void>((resolve) => {
    reached = resolve;
  });
  child.on(
    'message',
    async (message: { id: number; method?: string; args: unknown[]; checkpoint?: string }) => {
      if (message.checkpoint) {
        reached();
        return;
      }
      const methods = backend as unknown as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >;
      try {
        const value = await methods[message.method!]!(...message.args);
        if (message.method === pause) {
          reached();
          return;
        }
        if (child.connected) child.send({ id: message.id, value });
      } catch (error) {
        if (child.connected) child.send({ id: message.id, error: (error as Error).message });
      }
    }
  );
  const result = once(child, 'close').then(([code, signal]) => ({ code, signal, stdout, stderr }));
  return {
    child,
    result,
    checkpoint: pause
      ? Promise.race([
          checkpoint,
          result.then((result) => {
            throw new Error(`CLI exited before checkpoint: ${JSON.stringify(result)}`);
          }),
        ])
      : Promise.resolve(),
  };
}

describe('first-class tag and Card Cluster creation', () => {
  it('does not replace an unknown existing native cardItem flag with inferred local nesting', async () => {
    const f = await prepare((f) => {
      f.rems.get('answer')!.cardItem = null;
    });
    const read = await workspace.readWorkspace(directory, f.path);
    expect(read.outline.nodes.answer).toMatchObject({
      cardItem: null,
      observed: { cardItem: null },
    });
  });
  async function unusedTags() {
    const f = fixture();
    f.rems.get('home')!.children.push('unused');
    f.rems.set('unused', native('unused', ['Unused'], { parent: 'home' }));
    await importWorkspace(directory, 'kb', async () => f.backend);
    const state = await loadState(directory),
      path = state.entries.answer!.path;
    return { ...f, state, path };
  }
  it('resolves a never-used native full-path tag without changing the sealed registry until publication', async () => {
    const f = await unusedTags();
    const identity = await readPrivate(directory, IDENTITY);
    await edit(f.path, (s) => s.replace('Because', 'Because #HOME/Unused'));
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    const preview = await syncWorkspace(directory, async () => f.backend, { paths: [f.path] });
    expect(preview).toMatchObject({
      status: 'preview',
      remoteWrites: 0,
      selection: { verificationIds: expect.arrayContaining(['unused', 'home']) },
    });
    expect((await loadState(directory)).tagIds).toEqual({});
    expect(await readPrivate(directory, IDENTITY)).toBe(identity);
    expect(
      await syncWorkspace(directory, async () => f.backend, { apply: true, paths: [f.path] })
    ).toMatchObject({ status: 'verified' });
    expect((await loadState(directory)).tagIds).toEqual({ 'HOME/Unused': 'unused' });
    expect(f.rems.get('answer')!.tags).toEqual(['unused']);
  });
  it.each(['renamed', 'missing'] as const)(
    'refuses a newly bound tag that is remotely %s before all writes',
    async (mode) => {
      const f = await unusedTags();
      await edit(f.path, (s) => s.replace('Because', 'Changed answer #HOME/Unused'));
      if (mode === 'renamed') f.rems.get('unused')!.text = ['Elsewhere'];
      else f.rems.delete('unused');
      await expect(
        syncWorkspace(directory, async () => f.backend, { apply: true, paths: [f.path] })
      ).rejects.toThrow(/tag|dependency|ancestor/i);
      expect(f.calls).toEqual([]);
    }
  );
  it('rejects case/normalized path collisions while equal basenames under different ancestors stay exact', async () => {
    const f = fixture();
    f.rems.set('tag1', native('tag1', ['A B']));
    f.rems.set('tag2', native('tag2', ['a_b']));
    await importWorkspace(directory, 'kb', async () => f.backend);
    const path = (await loadState(directory)).entries.answer!.path;
    await edit(path, (s) => s.replace('Because', 'Because #A_B'));
    expect(await lintWorkspace(directory)).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'TAG' })]),
    });
    const factory = vi.fn(async () => f.backend);
    await expect(syncWorkspace(directory, factory, { apply: true })).rejects.toThrow('Ambiguous');
    expect(factory).not.toHaveBeenCalled();
  });
  it('does not publish or write newly resolved tags from an unselected file', async () => {
    const f = await unusedTags();
    await edit(f.path, (s) => s.replace('Because', 'Because #HOME/Unused'));
    expect(
      await syncWorkspace(directory, async () => f.backend, {
        apply: true,
        paths: [f.state.entries.subdoc!.path],
      })
    ).toMatchObject({ status: 'unchanged' });
    expect((await loadState(directory)).tagIds).toEqual({});
    expect(f.calls).toEqual([]);
  });
  it('resumes a lost tag-attachment acknowledgment by exact membership without applying it twice', async () => {
    const f = await unusedTags();
    await edit(f.path, (s) => s.replace('Because', 'Because #HOME/Unused'));
    const original = vi.mocked(f.backend.addTag).getMockImplementation()!;
    vi.mocked(f.backend.addTag).mockImplementationOnce(async (id, tag) => {
      await original(id, tag);
      throw new Error('tag ack lost');
    });
    const interrupted = (await syncWorkspace(directory, async () => f.backend, {
      apply: true,
      paths: [f.path],
    })) as { planHash: string };
    expect(interrupted).toMatchObject({ status: 'unknown' });
    expect(
      await resumeWorkspace(directory, async () => f.backend, interrupted.planHash)
    ).toMatchObject({ status: 'verified', resumed: true, remoteWrites: 0 });
    expect(f.backend.addTag).toHaveBeenCalledTimes(1);
    expect(f.rems.get('answer')!.tags).toEqual(['unused']);
  });
  it('rejects an unprojectable incoming tag before an unrelated outgoing edit can write', async () => {
    const f = await prepare();
    await edit(f.path, (s) => s.replace('Because', 'Local edit'));
    f.rems.get('chapter')!.tags = ['unknown-native-tag'];
    await expect(syncWorkspace(directory, async () => f.backend, { apply: true })).rejects.toThrow(
      'Unmapped native tag'
    );
    expect(f.calls).toEqual([]);
  });
  it('adds a newly discovered outside dependency when a remote-only selected Rem changes', async () => {
    const f = fixture();
    f.rems.get('question')!.text = [{ i: 'q', _id: 'home' }];
    await importWorkspace(directory, 'kb', async () => f.backend);
    const path = (await loadState(directory)).entries.question!.path;
    f.rems.get('question')!.text = [{ i: 'q', _id: 'home' }, ' changed remotely'];
    expect(
      await syncWorkspace(directory, async () => f.backend, { apply: true, paths: [path] })
    ).toMatchObject({
      status: 'verified',
      selection: { verificationIds: expect.arrayContaining(['home']) },
    });
    expect(vi.mocked(f.backend.read).mock.calls.flatMap(([ids]) => ids)).toContain('home');
    expect(f.calls).toEqual([]);
  });
  it.each(['clean', 'dirty', 'display-tags'] as const)(
    'activates old unbound tag projection only by explicit clean format: %s',
    async (mode) => {
      const f = await prepare(),
        state = await loadState(directory);
      delete state.tagIds;
      if (mode === 'display-tags') {
        await edit(f.path, (s) => renderFrontmatter({ tags: ['old-display'] }) + s);
        state.documents[f.path]!.fileHash = hash(await readPrivate(directory, f.path));
      }
      await saveState(directory, state);
      await writePrivate(
        directory,
        IDENTITY,
        JSON.stringify(workspaceIdentity(state), null, 2) + '\n'
      );
      if (mode === 'dirty') await edit(f.path, (s) => s.replace('Because', 'User changed this'));
      const factory = vi.fn(async () => f.backend);
      await expect(syncWorkspace(directory, factory, { apply: true })).rejects.toThrow(
        'Tag projection'
      );
      expect(factory).not.toHaveBeenCalled();
      if (mode === 'clean') {
        expect(await formatWorkspace(directory)).toMatchObject({
          status: 'formatted',
          remoteWrites: 0,
        });
        expect((await loadState(directory)).tagIds).toEqual({});
      } else
        await expect(formatWorkspace(directory)).rejects.toThrow(
          mode === 'dirty' ? 'locally edited' : 'display-only'
        );
      expect(f.calls).toEqual([]);
    }
  );
  async function newTopic() {
    const f = await prepare();
    await edit(f.path, (s) => {
      const source = addNodes(
        s,
        { topic: 'text', q: 'multiline', a: 'text' },
        '\n- A new theme ^local-topic\n  - New question ^local-q\n    - New answer ^local-a\n'
      );
      const parsed = parseFrontmatter(f.path, source);
      parsed.attributes!.rems!['local-topic']!.cardCluster = true;
      return (
        renderFrontmatter(parsed.attributes) +
        `<!-- remnote:${parsed.documentKey} -->\n\n` +
        parsed.body
      );
    });
    return f;
  }
  it('creates a genuine empty answer separator but rejects empty ordinary notes and questions', async () => {
    const f = await prepare();
    await edit(f.path, (s) =>
      addNodes(
        s,
        { q: 'multiline' },
        '\n- Question ^local-q\n  - First ^first\n  - ^separator\n  - Last ^last\n'
      )
    );
    const result = (await syncWorkspace(directory, async () => f.backend, {
      apply: true,
      paths: [f.path],
    })) as { ids: Record<string, string> };
    expect(result).toMatchObject({ status: 'verified' });
    const separator = result.ids[localNodeKey('daily', 'separator')]!;
    expect(f.rems.get(separator)).toMatchObject({ text: [], cardItem: true, children: [] });
    await edit(f.path, (s) => s + '\n- ^empty-note\n');
    const factory = vi.fn(async () => f.backend);
    await expect(syncWorkspace(directory, factory, { apply: true })).rejects.toThrow(
      'EMPTY_QUESTION'
    );
    expect(factory).not.toHaveBeenCalled();
  });
  it.each(['existing', 'card-item', 'question', 'false'] as const)(
    'refuses unsupported Card Cluster intent: %s',
    async (mode) => {
      const f = await prepare();
      await edit(f.path, (s) => {
        const source = addNodes(
          s,
          { q: 'multiline', a: 'text' },
          '\n- Question ^local-q\n  - Answer ^local-a\n'
        );
        const header = parseFrontmatter(f.path, source);
        const block =
          mode === 'existing'
            ? f.state.entries.chapter!.blockId
            : mode === 'card-item'
              ? 'local-a'
              : 'local-q';
        const yaml = renderFrontmatter({
          ...header.attributes,
          rems: {
            ...header.attributes!.rems,
            [block]: { ...header.attributes!.rems?.[block], cardCluster: true },
          },
        });
        return (
          (mode === 'false' ? yaml.replace('cardCluster: true', 'cardCluster: false') : yaml) +
          `<!-- remnote:${header.documentKey} -->\n\n` +
          header.body
        );
      });
      const factory = vi.fn(async () => f.backend);
      await expect(syncWorkspace(directory, factory, { apply: true })).rejects.toThrow();
      expect(factory).not.toHaveBeenCalled();
    }
  );
  it('creates a true native Card Cluster plus multiline card in one guarded call and removes the one-shot intent', async () => {
    const f = await newTopic(),
      before = await workspace.readWorkspace(directory, f.path);
    const key = localNodeKey('daily', 'local-topic');
    expect(before.outline.nodes[key] as { observed: unknown }).toMatchObject({
      intent: { cardCluster: true },
      powerups: { cc: true },
      observed: null,
    });
    const result = (await syncWorkspace(directory, async () => f.backend, {
      apply: true,
      paths: [f.path],
      expectedFileHash: before.fileHash,
    })) as { ids: Record<string, string>; outline: { nodes: Record<string, unknown> } };
    expect(result).toMatchObject({ status: 'verified', complete: true });
    expect(result.outline.nodes[result.ids[key]!]).toMatchObject({
      observed: { powerups: { cc: true } },
    });
    expect(f.backend.setCardCluster).toHaveBeenCalledTimes(1);
    expect(await readPrivate(directory, f.path)).not.toContain('cardCluster:');
    vi.mocked(f.backend.read).mockClear();
    expect(
      await syncWorkspace(directory, async () => f.backend, { apply: true, paths: [f.path] })
    ).toMatchObject({ status: 'unchanged', remoteWrites: 0 });
    expect(f.backend.setCardCluster).toHaveBeenCalledTimes(1);
    expect(f.backend.read).not.toHaveBeenCalled();
    f.rems.get(result.ids[key]!)!.powerupPresence = { cc: false };
    await expect(
      syncWorkspace(directory, async () => f.backend, { apply: true, paths: [f.path] })
    ).rejects.toThrow('Powerup');
  });
  it('resumes a lost Card Cluster ack with the original guarded proof, never repeats cc or creates', async () => {
    const f = await newTopic(),
      before = await workspace.readWorkspace(directory, f.path);
    const original = vi.mocked(f.backend.setCardCluster).getMockImplementation()!;
    vi.mocked(f.backend.setCardCluster).mockImplementationOnce(async (id) => {
      await original(id);
      throw new Error('lost cc ack');
    });
    const interrupted = (await syncWorkspace(directory, async () => f.backend, {
      apply: true,
      paths: [f.path],
      expectedFileHash: before.fileHash,
    })) as { planHash: string; ids: Record<string, string> };
    expect(interrupted).toMatchObject({ status: 'unknown' });
    const result = (await resumeWorkspace(
      directory,
      async () => f.backend,
      interrupted.planHash
    )) as { verification: { nativeBefore: unknown } };
    expect(result).toMatchObject({
      status: 'verified',
      resumed: true,
      existingCardsPreserved: true,
      verification: { fileHash: before.fileHash, planHash: interrupted.planHash },
    });
    expect(f.backend.create).toHaveBeenCalledTimes(3);
    expect(f.backend.setCardCluster).toHaveBeenCalledTimes(1);
    expect(result.verification.nativeBefore).toMatchObject({
      question: { cardIds: ['card_question'] },
    });
  });
  it('refuses a modified original guarded proof before reconnecting on resume', async () => {
    const f = await newTopic(),
      before = await workspace.readWorkspace(directory, f.path);
    vi.mocked(f.backend.setCardCluster).mockRejectedValueOnce(new Error('cc unavailable'));
    const interrupted = (await syncWorkspace(directory, async () => f.backend, {
      apply: true,
      paths: [f.path],
      expectedFileHash: before.fileHash,
    })) as { planHash: string };
    const state = await loadState(directory),
      journal = await f.backend.journal.getLocal<
        import('../../../src/business/workspace/resume.js').Journal
      >(state.pending!.journalKey);
    journal!.proof!.nativeBefore.question!.reviewHash = 'tampered';
    await f.backend.journal.setLocal(state.pending!.journalKey, journal);
    const factory = vi.fn(async () => f.backend);
    await expect(resumeWorkspace(directory, factory, interrupted.planHash)).rejects.toThrow(
      'proof binding'
    );
    expect(factory).not.toHaveBeenCalled();
  });
  it('does not claim a failed native cc setter succeeded or replay its uncertain step', async () => {
    const f = await newTopic();
    vi.mocked(f.backend.setCardCluster).mockRejectedValueOnce(new Error('native cc failed'));
    const interrupted = (await syncWorkspace(directory, async () => f.backend, {
      apply: true,
      paths: [f.path],
    })) as { planHash: string };
    expect(interrupted).toMatchObject({ status: 'unknown' });
    await expect(
      resumeWorkspace(directory, async () => f.backend, interrupted.planHash)
    ).rejects.toThrow(/created Rem differs/);
    expect(f.backend.setCardCluster).toHaveBeenCalledTimes(1);
  });
  it('keeps full read and guard scope bounded for one edit among many unrelated bound Rems', async () => {
    const f = fixture();
    for (let i = 0; i < 80; i++) f.rems.set(`unrelated_${i}`, native(`unrelated_${i}`));
    await importWorkspace(directory, 'kb', async () => f.backend);
    const state = await loadState(directory),
      path = state.entries.answer!.path;
    await edit(path, (s) => s.replace('Because', 'One small edit'));
    vi.mocked(f.backend.read).mockClear();
    vi.mocked(f.backend.guard).mockClear();
    expect(await syncWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
      status: 'verified',
    });
    expect(vi.mocked(f.backend.readProbe).mock.calls.flatMap(([ids]) => ids)).toContain(
      'unrelated_79'
    );
    expect(
      vi
        .mocked(f.backend.read)
        .mock.calls.flatMap(([ids]) => ids)
        .some((id) => id.startsWith('unrelated_'))
    ).toBe(false);
    expect(
      vi
        .mocked(f.backend.guard)
        .mock.calls.flatMap(([ids]) => ids)
        .some((id) => id.startsWith('unrelated_'))
    ).toBe(false);
  });
});

// The pre-existing reconciliation fixtures explicitly exercise the whole bound graph.
const pushWorkspace: typeof syncWorkspace = (directory, backend, options = {}) =>
  syncWorkspace(directory, backend, {
    ...(options.deleteId || options.scopeRoot ? {} : { scope: 'all' }),
    ...options,
  });

describe('scoped publication proof', () => {
  it.each(['complete', 'recover'] as const)(
    'preserves the first verified outgoing observation through later review: %s',
    async (mode) => {
      const f = await prepare((f) => {
        f.rems.get('basic')!.public = { updatedAt: 1 };
      });
      await edit(f.path, (source) => source.replace('Back', 'Outgoing back'));
      const write = f.backend.writeField,
        read = f.backend.read;
      let wrote = false,
        observed = false;
      f.backend.writeField = async (...args) => {
        await write(...args);
        f.rems.get('basic')!.public = { updatedAt: 10 };
        wrote = true;
      };
      f.backend.read = async (...args) => {
        const result = await read(...args);
        if (wrote && !observed && args[0].includes('basic')) {
          observed = true;
          f.rems.get('basic')!.public = { updatedAt: 25 };
        }
        return result;
      };
      const set = LocalState.prototype.setLocal;
      const interrupt = vi
        .spyOn(LocalState.prototype, 'setLocal')
        .mockImplementation(async function (this: LocalState, key, value) {
          if (mode === 'recover' && key.startsWith('publication:') && value !== null)
            throw new Error('Before ledger');
          return set.call(this, key, value);
        });
      expect(await syncWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
        status: mode === 'recover' ? 'publication-incomplete' : 'verified',
      });
      interrupt.mockRestore();
      if (mode === 'recover')
        expect(await recoverWorkspace(directory, async () => f.backend)).toMatchObject({
          status: 'recovered',
          remoteWrites: 0,
        });
      expect(observed).toBe(true);
      expect((await loadState(directory)).remoteVersions!.basic!.timestamp).toBe(10);
      expect(f.rems.get('basic')!.public!.updatedAt).toBe(25);
      expect(f.calls).toEqual(['basic:backText']);
    }
  );

  it.each([
    ['normal', 10, 20, 20],
    ['missing', 10, null, null],
    ['backward', 20, 10, null],
  ] as const)(
    'keeps first observed P clock through same-run review drift: %s',
    async (_case, beforeTime, contentTime, expectedTime) => {
      const f = await prepare((f) => {
        f.rems.get('basic')!.public = { updatedAt: beforeTime };
      });
      f.rems.get('basic')!.backText = ['Incoming back'];
      f.rems.get('basic')!.public = contentTime === null ? {} : { updatedAt: contentTime };
      const guard = f.backend.guard;
      f.backend.guard = async (ids) => {
        const result = await guard(ids);
        f.rems.get('basic')!.public = { updatedAt: 30 };
        return result;
      };
      expect(await syncWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
        status: 'verified',
        incoming: ['basic'],
      });
      const state = await loadState(directory);
      expect(state.remoteVersions!.basic!.timestamp).toBe(expectedTime);
      expect(state.remoteVersions!.basic!.sinceBaseline).toBeUndefined();
      expect(f.calls).toEqual([]);
    }
  );

  it('preserves observed A to B to A time while clearing published sinceBaseline', async () => {
    const f = await prepare((f) => {
      f.rems.get('basic')!.public = { updatedAt: 10 };
    });
    f.rems.get('basic')!.backText = ['B'];
    f.rems.get('basic')!.public = { updatedAt: 20 };
    expect(await syncWorkspace(directory, async () => f.backend)).toMatchObject({
      incoming: ['basic'],
    });
    expect((await loadState(directory)).remoteVersions!.basic).toMatchObject({
      timestamp: 20,
      sinceBaseline: true,
    });
    f.rems.get('basic')!.backText = ['Back'];
    f.rems.get('basic')!.public = { updatedAt: 30 };
    expect(await syncWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
      status: 'verified',
    });
    expect((await loadState(directory)).remoteVersions!.basic).toMatchObject({ timestamp: 30 });
    expect((await loadState(directory)).remoteVersions!.basic!.sinceBaseline).toBeUndefined();
    expect(f.calls).toEqual([]);
  });

  it.each(['all', 'guarded'] as const)(
    'retains complete original publication for %s',
    async (mode) => {
      const f = await prepare();
      await edit(f.path, (source) => source.replace('Because', 'Full proof answer'));
      const before = await workspace.readWorkspace(directory, f.path);
      const result = (await syncWorkspace(directory, async () => f.backend, {
        apply: true,
        ...(mode === 'all'
          ? { scope: 'all' as const }
          : { paths: [f.path], expectedFileHash: before.fileHash }),
      })) as { planHash: string };
      expect(result).toMatchObject({ status: 'verified' });
      const journal = (await localStore('kb').getLocal<Journal>(
        `workspace-v2:kb:${hash(directory)}:${result.planHash}`
      ))!;
      expect(journal.final!.publicationIds).toEqual([...journal.selection.reconcileIds].sort());
    }
  );

  async function stagedFixture(point: 'before-install' | 'displaced' | 'installed') {
    const f = await prepare();
    await edit(f.path, (source) => source.replace('Because', 'Frozen answer'));
    const set = LocalState.prototype.setLocal,
      displace = fileOps.displacePrivate,
      link = fileOps.linkPrivate;
    const stateSpy = vi.spyOn(LocalState.prototype, 'setLocal').mockImplementation(async function (
      this: LocalState,
      key,
      value
    ) {
      if (point === 'installed' && key.startsWith('publication:') && value === null)
        throw new Error('After installed state');
      return set.call(this, key, value);
    });
    const displaceSpy = vi.spyOn(fileOps, 'displacePrivate').mockImplementation(async (...args) => {
      if (point === 'before-install') throw new Error('Before first installation');
      return displace(...args);
    });
    const linkSpy = vi.spyOn(fileOps, 'linkPrivate').mockImplementation(async (...args) => {
      if (point === 'displaced' && args[2] === f.state.entries.answer!.rawPath)
        throw new Error('After exact target displacement');
      return link(...args);
    });
    expect(await syncWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
      status: 'publication-incomplete',
    });
    stateSpy.mockRestore();
    displaceSpy.mockRestore();
    linkSpy.mockRestore();
    const publication = (await readPublication(directory))!;
    expect(publication.recovery.kind).toBe('sync');
    if (point === 'installed') expect((await loadState(directory)).pending).toBeUndefined();
    return { f, publication };
  }

  const payloadSnapshot = async (publication: Publication) =>
    Promise.all(
      [
        ...new Set([
          ...Object.keys(publication.baseline),
          ...publication.writes.flatMap(({ path, stage, backup }) => [
            path,
            backup,
            ...(stage ? [stage] : []),
          ]),
        ]),
      ].map(async (path) => {
        try {
          return [
            path,
            hash(await readFile(join(directory, path), 'utf8')),
            (await stat(join(directory, path))).mode,
          ];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [path, null];
          throw error;
        }
      })
    );

  it('refuses a sync ledger appearing after the unlocked lookup and before locked recovery', async () => {
    const { f, publication } = await stagedFixture('installed'),
      before = await payloadSnapshot(publication),
      authoritative = await authoritativeState(directory),
      get = LocalState.prototype.getLocal;
    let initial = true;
    const lookup = vi.spyOn(LocalState.prototype, 'getLocal').mockImplementation(async function <T>(
      this: LocalState,
      key: string | undefined
    ): Promise<T | undefined> {
      if (initial && key === `publication:${hash(directory)}`) {
        initial = false;
        return undefined;
      }
      return get.call(this, key) as Promise<T | undefined>;
    });
    const factory = vi.fn(async () => f.backend);
    await expect(recoverWorkspace(directory, factory)).rejects.toThrow(
      'Unfinished local snapshot publication'
    );
    lookup.mockRestore();
    expect(factory).not.toHaveBeenCalled();
    expect(await authoritativeState(directory)).toEqual(authoritative);
    expect(await payloadSnapshot(publication)).toEqual(before);
    expect(await readPublication(directory)).toEqual(publication);
  });

  it.each([
    'missing',
    'extra',
    'source',
    'hash',
    'time',
    'content',
    'next-clock',
    'sinceBaseline',
  ] as const)(
    'rejects sealed P version %s mismatch before activating installed recovery',
    async (kind) => {
      const { f, publication } = await stagedFixture('installed');
      if (publication.recovery.kind !== 'sync') throw new Error('Expected sync binding');
      const journal = (await localStore('kb').getLocal<Journal>(publication.recovery.journalKey))!,
        versions = journal.final!.remoteVersions,
        version = versions.answer!,
        { finalProofHash } = await import('../../../src/business/workspace/resume.js');
      if (kind === 'missing') delete versions.answer;
      if (kind === 'extra') versions.basic = { ...version };
      if (kind === 'source') version.source = 'cli-save';
      if (kind === 'hash') version.contentHash = 'not-a-digest';
      if (kind === 'time') version.timestamp = -1;
      if (kind === 'content') version.contentHash = '0'.repeat(64);
      if (kind === 'next-clock') version.timestamp = 100;
      if (kind === 'sinceBaseline') version.sinceBaseline = true;
      journal.final!.proofHash = finalProofHash(journal);
      publication.recovery.proofHash = journal.final!.proofHash;
      const { integrityHash: _seal, ...unsealed } = publication;
      publication.integrityHash = hash(unsealed);
      await localStore('kb').setLocal(publication.recovery.journalKey, journal);
      await publicationStore().setLocal(`publication:${hash(directory)}`, publication);
      const factory = vi.fn(async () => f.backend),
        before = await payloadSnapshot(publication),
        authoritative = await authoritativeState(directory);
      await expect(recoverWorkspace(directory, factory)).rejects.toThrow(
        /publication proof|content version proof/
      );
      expect(factory).not.toHaveBeenCalled();
      expect(await payloadSnapshot(publication)).toEqual(before);
      expect(await authoritativeState(directory)).toEqual(authoritative);
    }
  );

  it.each(['root', 'kb', 'plan', 'journal', 'proof', 'live-kb'] as const)(
    'refuses installed sync publication with a mismatched %s binding',
    async (field) => {
      const { f, publication } = await stagedFixture('installed'),
        authoritative = await authoritativeState(directory),
        bytes = await payloadSnapshot(publication),
        altered = structuredClone(publication);
      if (altered.recovery.kind !== 'sync') throw new Error('Expected sync binding');
      if (field === 'root') altered.directory += '-different';
      if (field === 'kb') altered.next.kbId = 'another-kb';
      if (field === 'plan') altered.recovery.planHash = '0'.repeat(64);
      if (field === 'journal') altered.recovery.journalKey += '-different';
      if (field === 'proof') altered.recovery.proofHash = '0'.repeat(64);
      if (field === 'live-kb')
        f.backend.identity = vi.fn(async () => ({ kbId: 'another-kb', writable: true }));
      const { integrityHash: _seal, ...unsealed } = altered;
      altered.integrityHash = hash(unsealed);
      await publicationStore().setLocal(`publication:${hash(directory)}`, altered);
      const factory = vi.fn(async () => f.backend),
        install = vi.spyOn(fileOps, 'linkPrivate'),
        calls = [...f.calls];
      await expect(recoverWorkspace(directory, factory)).rejects.toThrow(
        /binding|metadata|KB mismatch/
      );
      expect(factory).toHaveBeenCalledTimes(field === 'live-kb' ? 1 : 0);
      expect(install).not.toHaveBeenCalled();
      expect(f.calls).toEqual(calls);
      expect(await authoritativeState(directory)).toEqual(authoritative);
      expect(await payloadSnapshot(publication)).toEqual(bytes);
      expect(await publicationStore().getLocal(`publication:${hash(directory)}`)).toEqual(altered);
    }
  );

  it.each([
    ['before-install', 'corrupt'],
    ['before-install', 'oversize'],
    ['displaced', 'mode'],
    ['displaced', 'backup'],
    ['installed', 'corrupt'],
    ['installed', 'unsafe-path'],
  ] as const)(
    'prechecks sync payloads at %s for %s before native activation',
    async (point, fault) => {
      const { f, publication } = await stagedFixture(point),
        item = publication.writes.find(({ path }) => path === f.state.entries.answer!.rawPath)!;
      if (fault === 'corrupt') await writePrivate(directory, item.stage!, 'corrupt');
      if (fault === 'oversize')
        await writeFile(join(directory, item.stage!), 'x'.repeat(4 * 1024 * 1024 + 1), {
          mode: 0o600,
        });
      if (fault === 'mode') await chmod(join(directory, item.stage!), 0o644);
      if (fault === 'backup')
        await writeFile(join(directory, item.backup), 'corrupt backup', { mode: 0o600 });
      if (fault === 'unsafe-path') {
        item.stage = '../out-of-vault';
        const { integrityHash: _seal, ...unsealed } = publication;
        publication.integrityHash = hash(unsealed);
        await publicationStore().setLocal(`publication:${hash(directory)}`, publication);
      }
      const before = await payloadSnapshot(publication),
        authoritative = await authoritativeState(directory),
        factory = vi.fn(async () => f.backend),
        install = vi.spyOn(fileOps, 'linkPrivate'),
        calls = [...f.calls];
      await expect(recoverWorkspace(directory, factory)).rejects.toThrow(
        /integrity|oversized|Unsafe|Concurrent|escapes/
      );
      expect(factory).not.toHaveBeenCalled();
      expect(install).not.toHaveBeenCalled();
      expect(f.calls).toEqual(calls);
      expect(await authoritativeState(directory)).toEqual(authoritative);
      expect(await payloadSnapshot(publication)).toEqual(before);
      expect(await readPublication(directory)).toEqual(publication);
    }
  );

  it('uses only recorded G on recovery and seals unchanged selected identities outside P and G', async () => {
    const { f, publication } = await stagedFixture('installed');
    if (publication.recovery.kind !== 'sync') throw new Error('Expected sync binding');
    const journal = (await localStore('kb').getLocal<Journal>(publication.recovery.journalKey))!,
      frozenIds = Object.keys(journal.final!.hashes).sort();
    expect(journal.final!.publicationIds).toEqual(['answer']);
    expect(journal.selection.reconcileIds).toContain('basic');
    expect(frozenIds).not.toContain('basic');
    vi.mocked(f.backend.read).mockClear();
    vi.mocked(f.backend.readProbe).mockClear();
    for (const method of ['enumerate', 'discover', 'subtree'] as const)
      f.backend[method] = vi.fn(async () => {
        throw new Error(`No ${method} during recovery`);
      });
    expect(await recoverWorkspace(directory, async () => f.backend)).toMatchObject({
      status: 'recovered',
      remoteWrites: 0,
    });
    expect(
      vi
        .mocked(f.backend.read)
        .mock.calls.flatMap(([ids]) => ids)
        .sort()
    ).toEqual(frozenIds);
    expect(f.backend.readProbe).not.toHaveBeenCalled();
    for (const method of ['enumerate', 'discover', 'subtree'] as const)
      expect(f.backend[method]).not.toHaveBeenCalled();
    const local = await inspectLocal(directory),
      { publishedBaselineHash } = await import('../../../src/business/workspace/resume.js');
    expect(publishedBaselineHash(journal, local.native)).toBe(journal.final!.publishedBaselineHash);
    local.native.get('basic')!.text = ['Changed unchanged selected baseline'];
    expect(publishedBaselineHash(journal, local.native)).not.toBe(
      journal.final!.publishedBaselineHash
    );
    await writePrivate(
      directory,
      local.state.entries.basic!.rawPath,
      JSON.stringify(local.native.get('basic'))
    );
    const factory = vi.fn(async () => f.backend);
    await expect(resumeWorkspace(directory, factory, journal.planHash)).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(['unstaged', 'staged', 'installed'] as const)(
    'recovers %s publication despite remote-only review and scheduling changes',
    async (point) => {
      const f = await prepare((f) => {
        f.rems.get('basic')!.public = { updatedAt: 10 };
      });
      await edit(f.path, (source) => source.replace('Back', 'Published back'));
      const before = await loadState(directory),
        raw = new Map(
          await Promise.all(
            Object.entries(before.entries)
              .filter(([id]) => id !== 'basic')
              .map(
                async ([id, entry]) => [id, await readPrivate(directory, entry.rawPath)] as const
              )
          )
        ),
        original = LocalState.prototype.setLocal,
        link = fileOps.linkPrivate;
      const stateSpy = vi
        .spyOn(LocalState.prototype, 'setLocal')
        .mockImplementation(async function (this: LocalState, key, value) {
          if (
            key.startsWith('publication:') &&
            ((point === 'unstaged' && value !== null) || (point === 'installed' && value === null))
          )
            throw new Error('Interrupt publication');
          return original.call(this, key, value);
        });
      const fileSpy = vi
        .spyOn(fileOps, 'linkPrivate')
        .mockImplementation(async (root, from, to) => {
          if (point === 'staged' && to === before.entries.basic!.rawPath)
            throw new Error('Interrupt staged payload');
          return link(root, from, to);
        });
      expect(await syncWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
        status: 'publication-incomplete',
      });
      stateSpy.mockRestore();
      fileSpy.mockRestore();
      const nativeBefore = await f.backend.read(['basic', 'question']);
      for (const rem of nativeBefore) {
        f.rems.get(rem.id)!.cards = rem.cards!.map((card) => ({
          ...card,
          repetitionHistory: [{ time: 25 }],
          nextRepetitionTime: 40,
          lastRepetitionTime: 25,
          timesWrongInRow: 0,
        }));
        f.rems.get(rem.id)!.public = { updatedAt: 25, localUpdatedAt: 50 };
        f.rems.get(rem.id)!.facts = { updatedAt: 25, localUpdatedAt: 50, createdAt: 1 };
      }
      const remoteOnly = structuredClone([...f.rems]),
        calls = [...f.calls];
      expect(await recoverWorkspace(directory, async () => f.backend)).toMatchObject({
        status: 'recovered',
        remoteWrites: 0,
      });
      expect([...f.rems]).toEqual(remoteOnly);
      expect(f.calls).toEqual(calls);
      const after = await loadState(directory);
      expect(after.remoteVersions!.basic!.timestamp).toBe(10);
      for (const [id, bytes] of raw) {
        expect(await readPrivate(directory, after.entries[id]!.rawPath)).toBe(bytes);
        expect(after.localVersions?.[id]).toEqual(before.localVersions?.[id]);
        expect(after.remoteVersions?.[id]).toEqual(before.remoteVersions?.[id]);
      }
      expect(
        (await inspectLocal(directory)).native.get('basic')!.cards!.map(({ id }) => id)
      ).toEqual(nativeBefore.find(({ id }) => id === 'basic')!.cards!.map(({ id }) => id));
      expect(await readPrivate(directory, f.path)).toContain('Published back');
    }
  );

  it.each(['ledger', 'stage', 'throw'] as const)(
    'keeps the writer lock and fails closed when %s changes during native recovery',
    async (kind) => {
      const f = await prepare();
      await edit(f.path, (source) => source.replace('Because', 'Sealed answer'));
      const original = LocalState.prototype.setLocal;
      const failure = vi.spyOn(LocalState.prototype, 'setLocal').mockImplementation(async function (
        this: LocalState,
        key,
        value
      ) {
        if (key.startsWith('publication:') && value === null)
          throw new Error('Before clearing installed publication');
        return original.call(this, key, value);
      });
      expect(await syncWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
        status: 'publication-incomplete',
      });
      failure.mockRestore();
      const publication = (await readPublication(directory))!,
        calls = [...f.calls],
        identity = f.backend.identity;
      f.backend.identity = async () => {
        await expect(withWorkspaceLock(directory, async () => true)).rejects.toThrow(
          /lock|writer/i
        );
        if (kind === 'throw') throw new Error('Injected native verifier failure');
        if (kind === 'stage') {
          const item = publication.writes.find(
            (item) => item.path === f.state.entries.answer!.rawPath
          )!;
          await writePrivate(directory, item.stage!, 'changed staged payload');
        } else {
          const { publicationStore } = await import('../../../src/business/workspace/local.js');
          await publicationStore().setLocal(`publication:${hash(directory)}`, {
            ...publication,
            integrityHash: '0'.repeat(64),
          });
        }
        return identity();
      };
      await expect(recoverWorkspace(directory, async () => f.backend)).rejects.toThrow(
        /publication|Staged|verifier/
      );
      expect(f.calls).toEqual(calls);
      const { publicationStore } = await import('../../../src/business/workspace/local.js');
      expect(await publicationStore().getLocal(`publication:${hash(directory)}`)).toBeTruthy();
    }
  );

  it('does not use stale Powerup facts when recovering an unknown-native dependency', async () => {
    const f = await prepare((f) => {
      f.rems.get('basic')!.text = [{ i: 'q', _id: 'subdoc' }];
      f.rems.get('subdoc')!.unsupported = 'unverified-native-flags';
      f.rems.get('subdoc')!.powerupPresence = { cc: false };
    });
    await edit(f.path, (source) => source.replace('Back', 'Recovery answer'));
    const original = LocalState.prototype.setLocal;
    const failure = vi.spyOn(LocalState.prototype, 'setLocal').mockImplementation(async function (
      this: LocalState,
      key,
      value
    ) {
      if (key.startsWith('publication:') && value !== null) throw new Error('Before ledger');
      return original.call(this, key, value);
    });
    expect(await syncWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
      status: 'publication-incomplete',
    });
    failure.mockRestore();
    f.rems.get('subdoc')!.powerupPresence!.cc = true;
    await expect(recoverWorkspace(directory, async () => f.backend)).rejects.toThrow('subdoc/cc');
    expect(f.calls).toEqual(['basic:backText']);
  });

  it.each(['body', 'tag'] as const)(
    'leaves a late unrelated %s edit for the next original discovery',
    async (kind) => {
      const f = await prepare();
      await edit(f.path, (source) => source.replace('Because', 'New answer'));
      const before = await loadState(directory),
        raw = await readPrivate(directory, before.entries.basic!.rawPath);
      const guard = f.backend.guard;
      let late = false;
      f.backend.guard = async (ids) => {
        const result = await guard(ids);
        if (!late) {
          late = true;
          if (kind === 'body') f.rems.get('basic')!.text = ['Late unrelated body'];
          else f.rems.get('basic')!.tags = ['home'];
        }
        return result;
      };
      const result = (await syncWorkspace(directory, async () => f.backend, { apply: true })) as {
        planHash: string;
      };
      expect(result).toMatchObject({ status: 'verified', updated: ['answer'] });
      const after = await loadState(directory);
      expect(await readPrivate(directory, after.entries.basic!.rawPath)).toBe(raw);
      expect(after.localVersions?.basic).toEqual(before.localVersions?.basic);
      expect(after.remoteVersions?.basic).toEqual(before.remoteVersions?.basic);
      expect(
        await resumeWorkspace(
          directory,
          async () => {
            throw new Error('ordinary completed resume is offline');
          },
          result.planHash
        )
      ).toMatchObject({ status: 'already-complete' });
      expect(await syncWorkspace(directory, async () => f.backend)).toMatchObject({
        incoming: ['basic'],
      });
    }
  );

  it.each(['before', 'after'] as const)(
    'checks in-selection reference dependencies at the %s public boundary',
    async (boundary) => {
      const f = await prepare((f) => {
        f.rems.get('basic')!.text = [{ i: 'q', _id: 'subdoc' }];
      });
      await edit(f.path, (source) => source.replace('Back', 'Edited back'));
      const probe = f.backend.readProbe;
      let checks = 0;
      f.backend.readProbe = async (ids, options) => {
        checks++;
        if (checks === (boundary === 'before' ? 2 : 3))
          f.rems.get('subdoc')!.text = ['Late dependency'];
        return probe(ids, options);
      };
      expect(await syncWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
        status: 'conflict',
        complete: false,
        error: expect.stringMatching(/Concurrent remote change.*subdoc/),
      });
      expect(f.calls).toHaveLength(boundary === 'before' ? 0 : 1);
    }
  );

  it.each([undefined, null])(
    'observes previously uncollected tag dependencies (%s) without publishing their baseline',
    async (unknownTags) => {
      const f = await prepare((f) => {
        f.rems.get('subdoc')!.tags = ['basic'];
        f.rems.get('basic')!.tags = unknownTags;
      });
      const path = f.state.entries.subdoc!.path;
      const before = await loadState(directory);
      const raw = await readPrivate(directory, before.entries.basic!.rawPath);
      f.rems.get('subdoc')!.text = ['Incoming child document'];
      vi.mocked(f.backend.readProbe).mockClear();
      const result = await syncWorkspace(directory, async () => f.backend, {
        apply: true,
        paths: [path],
      });
      expect(result).toMatchObject({ status: 'verified', incoming: ['subdoc'], remoteWrites: 0 });
      expect(result.selection!.reconcileIds).toEqual(['subdoc']);
      expect(vi.mocked(f.backend.readProbe).mock.calls[0]![0]).toEqual(['subdoc']);
      const probes = vi.mocked(f.backend.readProbe).mock.calls.map(([ids]) => ids);
      expect(probes.slice(-2)).toEqual([
        ['basic', 'daily', 'home', 'subdoc'],
        ['basic', 'daily', 'home', 'subdoc'],
      ]);
      const after = await loadState(directory);
      for (const id of Object.keys(before.entries).filter((id) => id !== 'subdoc')) {
        expect(after.entries[id]).toEqual(before.entries[id]);
        expect(after.localVersions?.[id]).toEqual(before.localVersions?.[id]);
        expect(after.remoteVersions?.[id]).toEqual(before.remoteVersions?.[id]);
      }
      expect(await readPrivate(directory, before.entries.basic!.rawPath)).toEqual(raw);
      expect((await inspectLocal(directory)).native.get('subdoc')!.text).toEqual([
        'Incoming child document',
      ]);
      expect(f.calls).toEqual([]);
    }
  );

  it('closes newly observed dependency tags transitively without expanding S or P', async () => {
    const f = await prepare((f) => {
      f.rems.get('subdoc')!.tags = ['basic'];
      f.rems.get('basic')!.tags = undefined;
      f.rems.get('opaque')!.tags = undefined;
    });
    const path = f.state.entries.subdoc!.path;
    await edit(f.path, (source) => source.replace('Front', 'Unselected local front'));
    const untouched = await readPrivate(directory, f.path);
    f.rems.get('subdoc')!.text = ['Incoming child document'];
    f.rems.get('basic')!.tags = ['opaque'];
    f.rems.get('opaque')!.tags = ['chapter'];
    const result = await syncWorkspace(directory, async () => f.backend, {
      apply: true,
      paths: [path],
    });
    expect(result).toMatchObject({ status: 'verified', incoming: ['subdoc'], remoteWrites: 0 });
    expect(result.selection!.reconcileIds).toEqual(['subdoc']);
    expect(await readPrivate(directory, f.path)).toEqual(untouched);
    const probes = vi.mocked(f.backend.readProbe).mock.calls.map(([ids]) => ids);
    const expected = ['basic', 'chapter', 'daily', 'home', 'opaque', 'subdoc'];
    expect(probes.slice(-2)).toEqual([expected, expected]);
    expect(f.calls).toEqual([]);
  });

  it.each(['known-tags', 'text', 'children', 'parent', 'type', 'powerup', 'unbound-tag'] as const)(
    'refuses an unobserved dependency with changed %s before journal or publication',
    async (change) => {
      const f = await prepare((f) => {
        f.rems.get('subdoc')!.tags = ['basic'];
        if (change !== 'known-tags') f.rems.get('basic')!.tags = undefined;
        if (change === 'powerup') f.rems.get('basic')!.powerupPresence = { cc: false };
      });
      const before = await loadState(directory);
      const path = before.entries.subdoc!.path;
      const markdown = await readPrivate(directory, path);
      f.rems.get('subdoc')!.text = ['Incoming child document'];
      const dependency = f.rems.get('basic')!;
      if (change === 'known-tags') dependency.tags = ['chapter'];
      if (change === 'text') dependency.text = ['Changed dependency'];
      if (change === 'children') dependency.children = ['opaque'];
      if (change === 'parent') dependency.parent = 'home';
      if (change === 'type') dependency.type = 1;
      if (change === 'powerup') dependency.powerupPresence!.cc = true;
      if (change === 'unbound-tag') dependency.tags = ['unbound'];
      await expect(
        syncWorkspace(directory, async () => f.backend, { apply: true, paths: [path] })
      ).rejects.toThrow(/verification dependency|Verification dependency/);
      expect(await loadState(directory)).toEqual(before);
      expect(await readPrivate(directory, path)).toEqual(markdown);
      expect(await readPublication(directory)).toBeUndefined();
      expect(f.calls).toEqual([]);
    }
  );

  it.each(['full-read', 'before', 'after'] as const)(
    'refuses newly observed dependency membership drift at the %s boundary',
    async (boundary) => {
      const f = await prepare((f) => {
        f.rems.get('subdoc')!.tags = ['basic'];
        f.rems.get('basic')!.tags = undefined;
      });
      const path = f.state.entries.subdoc!.path;
      const markdown = await readPrivate(directory, path);
      f.rems.get('subdoc')!.text = ['Incoming child document'];
      const probe = f.backend.readProbe,
        read = f.backend.read;
      if (boundary === 'full-read')
        f.backend.read = async (ids, options) => {
          if (ids.includes('basic')) f.rems.get('basic')!.tags = ['chapter'];
          return read(ids, options);
        };
      let publicChecks = 0;
      f.backend.readProbe = async (ids, options) => {
        if (ids.includes('basic') && ids.includes('subdoc')) {
          publicChecks++;
          if (publicChecks === (boundary === 'before' ? 1 : 2))
            f.rems.get('basic')!.tags = ['chapter'];
        }
        return probe(ids, options);
      };
      const result = syncWorkspace(directory, async () => f.backend, {
        apply: true,
        paths: [path],
      });
      if (boundary === 'full-read')
        await expect(result).rejects.toThrow('Verification dependency changed: basic');
      else
        expect(await result).toMatchObject({
          status: 'conflict',
          complete: false,
          error: expect.stringMatching(/Concurrent remote change.*basic/),
        });
      expect(await readPrivate(directory, path)).toEqual(markdown);
      expect(f.calls).toEqual([]);
    }
  );

  it.each(['unstaged', 'staged'] as const)(
    'recovers %s publication using frozen newly observed tags, never the unknown baseline',
    async (point) => {
      const f = await prepare((f) => {
        f.rems.get('subdoc')!.tags = ['basic'];
        f.rems.get('basic')!.tags = undefined;
      });
      const path = f.state.entries.subdoc!.path;
      const before = await loadState(directory);
      const raw = await readPrivate(directory, before.entries.basic!.rawPath);
      f.rems.get('subdoc')!.text = ['Incoming child document'];
      const original = LocalState.prototype.setLocal,
        link = fileOps.linkPrivate;
      const storeSpy = vi
        .spyOn(LocalState.prototype, 'setLocal')
        .mockImplementation(async function (this: LocalState, key, value) {
          if (point === 'unstaged' && key.startsWith('publication:') && value !== null)
            throw new Error('Before publication');
          return original.call(this, key, value);
        });
      const fileSpy = vi
        .spyOn(fileOps, 'linkPrivate')
        .mockImplementation(async (root, from, to) => {
          if (point === 'staged' && to === before.entries.subdoc!.rawPath)
            throw new Error('After displacement');
          return link(root, from, to);
        });
      expect(
        await syncWorkspace(directory, async () => f.backend, { apply: true, paths: [path] })
      ).toMatchObject({ status: 'publication-incomplete' });
      storeSpy.mockRestore();
      fileSpy.mockRestore();
      const state = await loadState(directory);
      const journal = (await localStore('kb').getLocal<Journal>(state.pending!.journalKey))!;
      expect(journal.final!.publicationIds).toEqual(['subdoc']);
      expect(Object.keys(journal.final!.hashes).sort()).toEqual([
        'basic',
        'daily',
        'home',
        'subdoc',
      ]);
      f.rems.get('basic')!.tags = ['chapter'];
      await expect(recoverWorkspace(directory, async () => f.backend)).rejects.toThrow(
        'Remote changed after verified sync'
      );
      f.rems.get('basic')!.tags = [];
      expect(await recoverWorkspace(directory, async () => f.backend)).toMatchObject({
        status: 'recovered',
        remoteWrites: 0,
      });
      expect(await readPrivate(directory, before.entries.basic!.rawPath)).toEqual(raw);
      expect((await loadState(directory)).entries.basic).toEqual(before.entries.basic);
      expect(f.calls).toEqual([]);
    }
  );

  it.each(['staging', 'installed'] as const)(
    'verifies frozen G while recovering %s publication after pending disappears',
    async (point) => {
      const f = await prepare();
      await edit(f.path, (source) => source.replace('Because', 'Published answer'));
      const original = LocalState.prototype.setLocal,
        link = fileOps.linkPrivate;
      const stateSpy = vi
        .spyOn(LocalState.prototype, 'setLocal')
        .mockImplementation(async function (this: LocalState, key, value) {
          if (point === 'installed' && key.startsWith('publication:') && value === null)
            throw new Error('After next manifest');
          return original.call(this, key, value);
        });
      const fileSpy = vi
        .spyOn(fileOps, 'linkPrivate')
        .mockImplementation(async (root, from, to) => {
          if (point === 'staging' && to === f.state.entries.answer!.rawPath)
            throw new Error('After displacement');
          return link(root, from, to);
        });
      expect(await syncWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
        status: 'publication-incomplete',
      });
      stateSpy.mockRestore();
      fileSpy.mockRestore();
      const pending = await readPublication(directory),
        calls = [...f.calls];
      expect(pending!.recovery.kind).toBe('sync');
      if (point === 'installed') expect((await loadState(directory)).pending).toBeUndefined();
      await expect(recoverLocalPublication(directory)).rejects.toThrow(
        'exact native proof verifier'
      );
      f.rems.get('answer')!.text = ['Changed after verification'];
      await expect(recoverWorkspace(directory, async () => f.backend)).rejects.toThrow(
        'Remote changed after verified sync'
      );
      expect(await readPublication(directory)).toEqual(pending);
      expect(f.calls).toEqual(calls);
      f.rems.get('answer')!.text = ['Published answer'];
      expect(await recoverWorkspace(directory, async () => f.backend)).toMatchObject({
        status: 'recovered',
        remoteWrites: 0,
      });
      expect(f.calls).toEqual(calls);
    }
  );

  it.each([
    'publicationIds',
    'publishedBaselineHash',
    'hashes',
    'selection',
    'inputHash',
    'structuralIds',
  ] as const)('rejects tampered %s before recovering or blessing any baseline', async (field) => {
    const f = await prepare();
    await edit(f.path, (source) => source.replace('Because', 'Proof answer'));
    const original = LocalState.prototype.setLocal;
    const failure = vi.spyOn(LocalState.prototype, 'setLocal').mockImplementation(async function (
      this: LocalState,
      key,
      value
    ) {
      if (key.startsWith('publication:') && value !== null) throw new Error('Before publication');
      return original.call(this, key, value);
    });
    expect(await syncWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
      status: 'publication-incomplete',
    });
    failure.mockRestore();
    const before = await loadState(directory),
      store = localStore('kb'),
      key = before.pending!.journalKey;
    const journal = (await store.getLocal<Journal>(key))!;
    if (field === 'selection') journal.selection.reconcileIds = ['answer'];
    else if (field === 'publicationIds' || field === 'structuralIds')
      journal.final![field] = ['basic'];
    else if (field === 'hashes') delete journal.final!.hashes.chapter;
    else journal.final![field] = '0'.repeat(64);
    await store.setLocal(key, journal);
    const factory = vi.fn(async () => f.backend),
      calls = [...f.calls];
    await expect(recoverWorkspace(directory, factory)).rejects.toThrow('publication proof');
    expect(factory).not.toHaveBeenCalled();
    expect(await loadState(directory)).toEqual(before);
    expect(f.calls).toEqual(calls);
  });

  it.each(['before', 'after'] as const)(
    'retains unknown native dependency public facts at the %s boundary',
    async (boundary) => {
      const f = await prepare((f) => {
        f.rems.get('basic')!.text = [{ i: 'q', _id: 'subdoc' }];
        f.rems.get('subdoc')!.unsupported = 'unverified-native-flags';
        f.rems.get('subdoc')!.powerupPresence = { cc: false };
      });
      await edit(f.path, (source) => source.replace('Back', 'Unknown dependency answer'));
      const read = f.backend.read,
        probe = f.backend.readProbe;
      f.backend.read = async (ids, options) =>
        (await read(ids, options)).map((rem) =>
          rem.id === 'subdoc' ? { ...rem, unsupported: undefined } : rem
        );
      let checks = 0;
      f.backend.readProbe = async (ids, options) => {
        checks++;
        if (checks === (boundary === 'before' ? 2 : 3))
          f.rems.get('subdoc')!.powerupPresence!.cc = true;
        return probe(ids, options);
      };
      expect(await syncWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
        status: 'conflict',
        complete: false,
        error: expect.stringMatching(/Powerup.*subdoc/),
      });
      expect(f.calls).toHaveLength(boundary === 'before' ? 0 : 1);
      expect((await inspectLocal(directory)).native.get('subdoc')!.unsupported).toBe(
        'unverified-native-flags'
      );
    }
  );
});

it('CLI relocate keeps a nonempty imported identity/card baseline usable by offline status and lint', async () => {
  const f = await prepare();
  const before = await loadState(directory);
  const paths = await fileOps.allFiles(directory);
  const hashes = new Map(
    await Promise.all(
      paths.map(async (path) => [path, hash(await readPrivate(directory, path))] as const)
    )
  );
  const destination = join(temporary, 'renamed-vault');
  const backend = vi.spyOn(DirectClient.prototype, 'workspaceBackend');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const args of [
    ['relocate', directory, destination],
    ['status', destination],
    ['lint', destination],
  ])
    await createProgram('test').parseAsync(['node', 'remnote-cli', 'sync', ...args]);
  expect(backend).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledTimes(3);
  expect(await loadState(destination)).toEqual({ ...before, directory: destination });
  expect(await statusWorkspace(destination)).toMatchObject({
    complete: true,
    rems: 8,
    missing: [],
    dirty: [],
    diagnostics: [],
  });
  expect(await lintWorkspace(destination)).toMatchObject({ ok: true, diagnostics: [] });
  for (const path of paths)
    expect(hash(await readPrivate(destination, path))).toBe(hashes.get(path));
  expect(f.calls).toEqual([]);
  await expect(statusWorkspace(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

describe('selected incremental sync', () => {
  it('probes clean selected native content and tags without full history; empty directories stay offline', async () => {
    const f = await prepare(),
      factory = vi.fn(async () => f.backend);
    await mkdir(join(directory, 'Empty'));
    expect(await syncWorkspace(directory, factory)).toMatchObject({
      status: 'unchanged',
      remoteChecked: true,
      remoteWrites: 0,
      checkedCount: 8,
    });
    expect(f.backend.read).not.toHaveBeenCalled();
    expect(f.backend.guard).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(1);
    factory.mockClear();
    expect(await syncWorkspace(directory, factory, { paths: ['Empty'] })).toMatchObject({
      status: 'unchanged',
      remoteChecked: false,
      checkedCount: 0,
      checkedIds: [],
      remoteWrites: 0,
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it('guards the exact input file and returns fresh zero-write native proof, including known powerups', async () => {
    const f = await prepare((f) => {
      f.rems.get('chapter')!.powerups = [{ code: 'cc', slots: [] }];
    });
    const read = await workspace.readWorkspace(directory, f.path);
    expect(read.outline).toMatchObject({
      schema: 'remnote-outline/1',
      nodes: { chapter: { powerups: { cc: true }, pinned: null } },
    });
    const result = await syncWorkspace(directory, async () => f.backend, {
      apply: true,
      paths: [f.path],
      expectedFileHash: read.fileHash,
    });
    expect(result).toMatchObject({
      status: 'verified',
      remoteWrites: 0,
      verification: {
        fileHash: read.fileHash,
        nativeBefore: {
          question: {
            cardIds: ['card_question'],
            reviewHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
        nativeAfter: { question: { cardIds: ['card_question'] } },
        observedHashes: { chapter: expect.any(String) },
      },
      outline: { nodes: { chapter: { observed: { powerups: { cc: true } } } } },
    });
    const factory = vi.fn(async () => f.backend);
    await expect(
      syncWorkspace(directory, factory, {
        apply: true,
        paths: [f.path],
        expectedFileHash: '0'.repeat(64),
      })
    ).rejects.toThrow('current --expected-file-hash');
    expect(factory).not.toHaveBeenCalled();
  });

  it('merges local and remote direct tag deltas separately from remote body edits', async () => {
    const f = await prepare((f) => {
      f.rems.get('question')!.tags = ['home'];
      f.rems.get('basic')!.tags = ['chapter'];
    });
    await edit(f.path, (source) => source.replace('Why? #HOME', 'Why? #HOME/Today/Chapter'));
    f.rems.get('question')!.text = ['Remote why'];
    f.rems.get('question')!.tags = ['home', 'chapter'];
    const result = await syncWorkspace(directory, async () => f.backend, {
      apply: true,
      paths: [f.path],
    });
    expect(result).toMatchObject({ status: 'verified', incoming: ['question'], remoteWrites: 1 });
    expect(f.calls).toEqual(['question:tag:remove:home']);
    expect(f.rems.get('question')).toMatchObject({ text: ['Remote why'], tags: ['chapter'] });
    expect(await readPrivate(directory, f.path)).toContain('Remote why #HOME/Today/Chapter');
    expect(await syncWorkspace(directory, async () => f.backend)).toMatchObject({
      status: 'unchanged',
      remoteWrites: 0,
    });
  });

  it('rejects tag removal before any text writes when the existing destructive capability gate is disabled', async () => {
    const f = await prepare((f) => {
      f.rems.get('question')!.tags = ['home'];
    });
    await edit(f.path, (source) => source.replace('Why? #HOME', 'Edited why'));
    f.backend.identity = vi.fn(async () => ({ kbId: 'kb', writable: true, destructive: false }));
    await expect(syncWorkspace(directory, async () => f.backend, { apply: true })).rejects.toThrow(
      '--allow-destructive'
    );
    expect(f.calls).toEqual([]);
    expect(f.rems.get('question')!.text).toEqual(['Why?']);
  });

  it('detects remote-only body and tag changes by default without a local edit', async () => {
    const f = await prepare((f) => {
      f.rems.get('basic')!.tags = ['home'];
    });
    f.rems.get('answer')!.text = ['Remote-only answer'];
    f.rems.get('question')!.tags = ['home'];
    const result = await syncWorkspace(directory, async () => f.backend, {
      apply: true,
      paths: [f.path],
    });
    expect(result).toMatchObject({
      status: 'verified',
      incoming: ['answer', 'question'],
      remoteWrites: 0,
    });
    expect(await readPrivate(directory, f.path)).toContain('Remote-only answer');
    expect(await readPrivate(directory, f.path)).toContain('Why? #HOME');
    expect(f.calls).toEqual([]);
  });

  it('merges selected local A and remote C without absorbing dirty unselected B or its new note', async () => {
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
      incoming: ['basic'],
      selection: { reconcileIds: ['answer', 'basic', 'chapter', 'daily', 'opaque', 'question'] },
    });
    const after = await loadState(directory);
    expect(await readPrivate(directory, bPath)).toBe(bBytes);
    expect(await readPrivate(directory, before.entries.subdoc!.rawPath)).toBe(bRaw);
    expect(await readPrivate(directory, before.entries.basic!.rawPath)).not.toBe(cRaw);
    expect(after.entries.subdoc).toEqual(before.entries.subdoc);
    expect(after.documents[bPath]).toEqual(before.documents[bPath]);
    expect(after.localVersions).toEqual(before.localVersions);
    expect(after.remoteVersions!.subdoc).toEqual(before.remoteVersions!.subdoc);
    expect(after.remoteVersions!.basic).not.toEqual(before.remoteVersions!.basic);
    expect(Object.keys(after.entries)).not.toContain('created_1');
    expect(vi.mocked(f.backend.readProbe).mock.calls.flatMap(([ids]) => ids)).toContain('basic');
    const later = await syncWorkspace(directory, async () => f.backend, {
      scope: 'all',
      apply: true,
    });
    expect(later).toMatchObject({
      status: 'verified',
      incoming: [],
      outgoing: ['subdoc', 'created_1'],
    });
    expect(f.calls.filter((call) => call === 'create')).toHaveLength(1);
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    expect(await diffWorkspace(directory)).toMatchObject({ changes: [] });
  });

  it.each(['home'] as const)(
    'does not publish the remote-only content or clock of verification dependency %s',
    async (id) => {
      const f = await prepare();
      await edit(f.path, (s) => s.replace('Because', 'Edited A'));
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

  it('publishes selected remote parent content together with a new ordinary note', async () => {
    const f = await prepare();
    await edit(f.path, (s) => s + '\n- New ordinary note\n');
    f.rems.get('daily')!.text = ['Remote parent title'];
    f.rems.get('daily')!.public = { updatedAt: Date.now() - 1000 };
    const before = await loadState(directory);
    expect(
      await syncWorkspace(directory, async () => f.backend, { paths: [f.path], apply: true })
    ).toMatchObject({ status: 'verified', incoming: ['daily'], outgoing: ['created_1'] });
    const after = await loadState(directory),
      parent = JSON.parse(await readPrivate(directory, after.entries.daily!.rawPath));
    expect(parent.children).toContain('created_1');
    expect(parent.public.children).toContain('created_1');
    expect(parent.text).toEqual(['Remote parent title']);
    expect(parent.public.text).toEqual(['Remote parent title']);
    expect(after.remoteVersions!.daily).not.toEqual(before.remoteVersions!.daily);
    expect(await readPrivate(directory, f.path)).toContain('# Remote parent title');
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    expect(await syncWorkspace(directory, async () => f.backend, { scope: 'all' })).toMatchObject({
      status: 'unchanged',
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
      const result = syncWorkspace(directory, async () => f.backend, {
        paths: [f.path],
        apply: true,
      });
      if (failure === 'missing')
        await expect(result).resolves.toMatchObject({
          status: 'conflict',
          complete: false,
          remoteWrites: 0,
          conflicts: [expect.objectContaining({ id: 'daily', reason: 'remote-missing' })],
        });
      else await expect(result).rejects.toThrow();
      expect(f.calls).toEqual([]);
    }
  );

  it('probes and publishes selected layout while preserving unselected content and clocks', async () => {
    const f = await prepare(),
      bPath = f.state.entries.subdoc!.path;
    await edit(f.path, (s) => s.replace('Because', 'Unselected A'));
    await syncWorkspace(directory, async () => f.backend, { paths: [f.path] });
    const before = await loadState(directory),
      raw = await readPrivate(directory, before.entries.subdoc!.rawPath);
    const renamed = 'HOME/Personal.md';
    await rename(join(directory, bPath), join(directory, renamed));
    await edit(renamed, (s) => '---\naliases: [Personal] # Reading note\n---\n' + s + '\n');
    await edit(f.path, (s) => s.replaceAll('HOME/Today/Child doc|', 'HOME/Personal|'));
    const source = await readPrivate(directory, renamed),
      aBytes = await readPrivate(directory, f.path),
      factory = vi.fn(async () => f.backend);
    const preview = (await syncWorkspace(directory, factory, { paths: [renamed] })) as {
      planHash: string;
    };
    expect(preview).toMatchObject({
      status: 'preview',
      remoteChecked: true,
      remoteWrites: 0,
    });
    expect((await loadState(directory)).entries).toEqual(before.entries);
    expect(
      await syncWorkspace(directory, factory, {
        paths: [renamed],
        apply: true,
        planHash: preview.planHash,
      })
    ).toMatchObject({
      status: 'verified',
      remoteChecked: true,
      remoteWrites: 0,
    });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(await readPrivate(directory, renamed)).toBe(source);
    expect(await readPrivate(directory, f.path)).toBe(aBytes);
    expect(await readPrivate(directory, before.entries.subdoc!.rawPath)).toBe(raw);
    const after = await loadState(directory);
    expect(after.pending).toBeUndefined();
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

  it('requires both swapped paths and probes native identity before publishing', async () => {
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
    ).toMatchObject({ status: 'verified', remoteChecked: true });
    const after = await loadState(directory);
    expect(after.entries.daily!.path).toBe(other);
    expect(after.entries.subdoc!.path).toBe(f.path);
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    expect(factory).toHaveBeenCalledTimes(1);
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
    expect(factory).toHaveBeenCalled();
    expect((await loadState(directory)).documents).toEqual(f.state.documents);
  });

  it.each(['publication', 'staging'] as const)(
    'recovers partial %s without native replay or dependency absorption',
    async (point) => {
      const f = await prepare(),
        bPath = f.state.entries.subdoc!.path;
      await edit(f.path, (s) => s.replace('Because', 'Selected A') + '\n- New selected note\n');
      await edit(bPath, (s) => s + '\n- Pending B\n');
      f.rems.get('home')!.text = ['Remote dependency'];
      const before = await loadState(directory),
        bytes = await readPrivate(directory, bPath),
        raw = await readPrivate(directory, before.entries.home!.rawPath);
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
      expect(await readPrivate(directory, before.entries.home!.rawPath)).toBe(raw);
      expect((await loadState(directory)).remoteVersions!.home).toEqual(
        before.remoteVersions!.home
      );
      expect(await syncWorkspace(directory, async () => f.backend, { scope: 'all' })).toMatchObject(
        { incoming: ['home'], creates: 1 }
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
      (source) => renderFrontmatter({ title: 'Local title', aliases: ['Alias'] }) + source
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
    const paths = ['AGENTS.md', '.agents/skills/remnote-obsidian/SKILL.md'];
    for (const path of paths) await writePrivate(directory, path, '# Synthetic guide\n');
    const local = await inspectLocal(directory);
    expect(local.diagnostics).toEqual([]);
    const frozen = await local.inputs.freeze();
    for (const path of paths) expect(frozen.hashes()[path]).toBe(hash('# Synthetic guide\n'));
    for (const path of ['README.md', 'Other/SKILL.md', '.agents/skills/remnote-data/SKILL.md']) {
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

describe('explicit interrupted sync resume', () => {
  it('re-enters public recovery after repeated actual process deaths with identical lock and baseline', async () => {
    const f = await prepare(),
      path = join(directory, '.sync/writer.lock');
    const before = await stat(path),
      marker = await readFile(path),
      state = await loadState(directory);
    for (let i = 0; i < 2; i++) {
      const running = syntheticCli(f.backend, ['sync', 'recover', directory], 'lock');
      await running.checkpoint;
      await expect(withWorkspaceLock(directory, async () => {})).rejects.toThrow('locked');
      running.child.kill('SIGKILL');
      expect(await running.result).toMatchObject({ code: null, signal: 'SIGKILL' });
      expect(await loadState(directory)).toEqual(state);
      expect((await stat(path)).ino).toBe(before.ino);
      expect(await readFile(path)).toEqual(marker);
    }
    const result = await syntheticCli(f.backend, ['sync', 'recover', directory]).result;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'nothing-to-recover',
      remoteWrites: 0,
    });
    expect(f.calls).toEqual([]);
  }, 15000);

  it.each(['exact-after', 'before-state', 'create-without-id'] as const)(
    'preserves journal identity after public apply/resume process death: %s',
    async (mode) => {
      const f = await prepare();
      if (mode === 'create-without-id')
        await edit(f.path, (s) => addNodes(s, { n: 'text' }, '\n- Note ^local-n\n'));
      else await edit(f.path, (s) => s.replace('Because', 'Edited'));
      if (mode === 'before-state')
        f.backend.writeField = vi.fn(async (id, field) => {
          // Synthetic server accepted a request, but its effect is not visible.
          f.calls.push(`${id}:${field}`);
        });
      const running = syntheticCli(
        f.backend,
        ['sync', 'apply', directory],
        mode === 'create-without-id' ? 'create' : 'writeField'
      );
      await running.checkpoint;
      const path = join(directory, '.sync/writer.lock'),
        before = await stat(path),
        marker = await readFile(path);
      const pending = (await loadState(directory)).pending!;
      expect(pending.planHash).toMatch(/^[a-f0-9]{64}$/);
      const store = localStore('kb'),
        journal = await store.getLocal(pending.journalKey);
      expect(journal).toMatchObject({ state: 'applying' });
      await expect(withWorkspaceLock(directory, async () => {})).rejects.toThrow('locked');
      running.child.kill('SIGKILL');
      expect(await running.result).toMatchObject({ code: null, signal: 'SIGKILL' });
      expect(await store.getLocal(pending.journalKey)).toEqual(journal);
      expect((await loadState(directory)).pending).toEqual(pending);
      const calls = [...f.calls];
      expect(calls).toHaveLength(1);
      const recovery = await syntheticCli(f.backend, ['sync', 'recover', directory]).result;
      expect(recovery.code).toBe(1);
      expect(recovery.stderr).toContain('Remote outcome is not verified');
      expect(await store.getLocal(pending.journalKey)).toEqual(journal);
      const args = ['sync', 'resume', directory, '--plan-hash', pending.planHash];
      const interruptedResume = syntheticCli(f.backend, args, 'lock');
      await interruptedResume.checkpoint;
      interruptedResume.child.kill('SIGKILL');
      expect(await interruptedResume.result).toMatchObject({ code: null, signal: 'SIGKILL' });
      expect(await store.getLocal(pending.journalKey)).toEqual(journal);
      const result = await syntheticCli(f.backend, args).result;
      expect(f.calls).toEqual(calls);
      expect((await stat(path)).ino).toBe(before.ino);
      expect(await readFile(path)).toEqual(marker);
      if (mode === 'exact-after') {
        expect(result).toMatchObject({ code: 0, signal: null, stderr: '' });
        expect(JSON.parse(result.stdout)).toMatchObject({
          status: 'verified',
          complete: true,
          remoteWrites: 0,
        });
        expect((await loadState(directory)).pending).toBeUndefined();
        const repeated = await syntheticCli(f.backend, args).result;
        expect(repeated.code).toBe(0);
        expect(JSON.parse(repeated.stdout)).toMatchObject({
          status: 'already-complete',
          remoteWrites: 0,
        });
      } else {
        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(
          mode === 'create-without-id' ? /identity|ID/ : /resume|remote/i
        );
        expect((await loadState(directory)).pending).toEqual(pending);
        expect(await store.getLocal(pending.journalKey)).toEqual(journal);
      }
    },
    15000
  );

  it('rejects a known-create ID pointing to an unselected baseline Rem before connection', async () => {
    const f = fixture();
    f.rems.set('outside', native('outside', null));
    await importWorkspace(directory, 'kb', async () => f.backend);
    const state = await loadState(directory),
      path = state.entries.daily!.path;
    await edit(path, (s) => addNodes(s, { n: 'text' }, '\n- New note ^local-n\n'));
    const read = f.backend.read;
    f.backend.read = vi.fn(async (ids, options) => {
      if (ids.includes('created_1')) throw new Error('Lost create read');
      return read(ids, options);
    });
    const result = (await syncWorkspace(directory, async () => f.backend, {
      apply: true,
      paths: [path],
    })) as { planHash: string };
    f.backend.read = read;
    const pending = (await loadState(directory)).pending!,
      store = localStore('kb');
    const journal = await store.getLocal<{ ids: Record<string, string> }>(pending.journalKey);
    journal!.ids[newKeys.n!] = 'outside';
    await store.setLocal(pending.journalKey, journal);
    const before = [...f.calls],
      factory = vi.fn(async () => f.backend);
    await expect(resumeWorkspace(directory, factory, result.planHash)).rejects.toThrow(
      /identity|baseline/i
    );
    expect(factory).not.toHaveBeenCalled();
    expect(f.calls).toEqual(before);
    expect(f.rems.get('outside')!.text).toBeNull();
  });

  it('recognizes an existing basic card backText effect without replay or recreation', async () => {
    const f = await prepare();
    await edit(f.path, (s) => s.replace('> Back', '> Updated back'));
    const write = f.backend.writeField;
    f.backend.writeField = vi.fn(async (...args) => {
      await write(...args);
      if (args[1] === 'backText') throw new Error('Lost basic backText response');
    });
    const result = (await syncWorkspace(directory, async () => f.backend, { apply: true })) as {
      planHash: string;
    };
    expect(result).toMatchObject({ status: 'unknown' });
    expect(await resumeWorkspace(directory, async () => f.backend, result.planHash)).toMatchObject({
      status: 'verified',
      complete: true,
    });
    expect(f.backend.create).not.toHaveBeenCalled();
    expect(f.calls.filter((call) => call === 'basic:backText')).toHaveLength(1);
    expect(f.rems.get('basic')).toMatchObject({
      text: ['Front'],
      backText: ['Updated back'],
      parent: 'daily',
    });
  });

  async function interruptedCreate() {
    const f = await prepare();
    await edit(f.path, (s) =>
      addNodes(
        s,
        { q: 'multiline', a: 'text', n: 'text' },
        '\n- New question \\#card ^local-q\n  - First answer ^local-a\n  - Second answer ^local-n\n'
      )
    );
    const read = f.backend.read;
    f.backend.read = vi.fn(async (ids, options) => {
      if (ids.includes('created_2')) throw new Error('Create follow-up read lost');
      return read(ids, options);
    });
    const result = (await syncWorkspace(directory, async () => f.backend, {
      apply: true,
      paths: [f.path],
    })) as { planHash: string; ids: Record<string, string> };
    expect(result).toMatchObject({
      status: 'unknown',
      ids: {
        [newKeys.q!]: 'created_1',
        [newKeys.a!]: 'created_2',
      },
    });
    f.backend.read = read;
    return { ...f, result };
  }

  it('reuses a known empty orphan, finishes the same plan and makes repeat resume a no-op', async () => {
    const f = await interruptedCreate();
    const writes = f.calls.length;
    // Anonymous shape observed through SdkWorkspaceBackend.read, not the CLI inspect projection.
    Object.assign(f.rems.get('created_2')!, {
      facts: {
        isTable: false,
        isProperty: false,
        isPowerup: false,
        isPowerupSlot: false,
        isPowerupProperty: false,
        isPowerupEnum: false,
        isPowerupPropertyListItem: false,
      },
    });
    expect(f.rems.get('created_2')).toMatchObject({
      text: [],
      backText: null,
      type: null,
      parent: null,
      children: [],
      practice: 'forward',
      enablePractice: true,
      document: false,
      folder: false,
      cardItem: false,
    });
    const result = await resumeWorkspace(directory, async () => f.backend, f.result.planHash);
    expect(result).toMatchObject({
      status: 'verified',
      complete: true,
      resumed: true,
      ids: { [newKeys.q!]: 'created_1', [newKeys.a!]: 'created_2', [newKeys.n!]: 'created_3' },
      remoteWrites: f.calls.length - writes,
    });
    expect(f.backend.create).toHaveBeenCalledTimes(3);
    expect(f.rems.get('created_1')!.children).toEqual(['created_2', 'created_3']);
    expect(f.rems.get('created_2')).toMatchObject({
      parent: 'created_1',
      cardItem: true,
      text: ['First answer'],
    });
    const factory = vi.fn(async () => f.backend);
    expect(await resumeWorkspace(directory, factory, f.result.planHash)).toMatchObject({
      status: 'already-complete',
      complete: true,
      remoteWrites: 0,
    });
    expect(factory).not.toHaveBeenCalled();
    expect(f.backend.create).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['text', { text: ['External private text'] }],
    ['backText', { backText: [] }],
    ['parent', { parent: 'external-parent' }],
    ['children', { children: ['external-child'] }],
    ['tags', { tags: ['external-tag'] }],
    ['practice', { practice: 'backward' }],
    ['enablePractice', { enablePractice: false }],
    ['facts.isTable', { facts: { isTable: true } }],
  ] as const)(
    'rejects a changed constructor %s before writes and names only its field path',
    async (field, change) => {
      const f = await interruptedCreate(),
        before = [...f.calls];
      Object.assign(f.rems.get('created_2')!, change);
      const error = await resumeWorkspace(
        directory,
        async () => f.backend,
        f.result.planHash
      ).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`fields: ${field}`);
      expect((error as Error).message).not.toContain('External private text');
      expect((error as Error).message).not.toContain('external-');
      expect(f.calls).toEqual(before);
    }
  );

  it('recognizes an already-applied uncertain setter without replaying it', async () => {
    const f = await prepare();
    await edit(f.path, (s) => s.replace('Because', 'Edited'));
    const write = f.backend.writeField;
    f.backend.writeField = vi.fn(async (...args) => {
      await write(...args);
      throw new Error('Lost acknowledgement');
    });
    const result = (await syncWorkspace(directory, async () => f.backend, { apply: true })) as {
      planHash: string;
    };
    expect(result).toMatchObject({ status: 'unknown' });
    expect(await resumeWorkspace(directory, async () => f.backend, result.planHash)).toMatchObject({
      status: 'verified',
      complete: true,
      remoteWrites: 0,
    });
    expect(f.backend.writeField).toHaveBeenCalledTimes(1);
  });

  it('does not retry an uncertain setter that still reads before its intended effect', async () => {
    const f = await prepare();
    await edit(f.path, (s) => s.replace('Because', 'Edited'));
    f.backend.writeField = vi.fn(async () => {
      throw new Error('Unknown transport outcome');
    });
    const result = (await syncWorkspace(directory, async () => f.backend, { apply: true })) as {
      planHash: string;
    };
    await expect(
      resumeWorkspace(directory, async () => f.backend, result.planHash)
    ).rejects.toThrow(/resume|remote/i);
    expect(f.backend.writeField).toHaveBeenCalledTimes(1);
  });

  it('rejects an uncertain create without a persisted ID before opening the backend', async () => {
    const f = await prepare();
    await edit(f.path, (s) => addNodes(s, { n: 'text' }, '\n- Note ^local-n\n'));
    const create = f.backend.create;
    f.backend.create = vi.fn(async (...args) => {
      await create(...args);
      throw new Error('Lost ID');
    });
    const result = (await syncWorkspace(directory, async () => f.backend, { apply: true })) as {
      planHash: string;
    };
    const factory = vi.fn(async () => f.backend);
    await expect(resumeWorkspace(directory, factory, result.planHash)).rejects.toThrow(
      /identity|ID/
    );
    expect(factory).not.toHaveBeenCalled();
    expect(f.backend.create).toHaveBeenCalledTimes(1);
  });

  it.each(['file', 'hash', 'kb', 'content', 'parent', 'tag', 'card', 'step'] as const)(
    'refuses changed %s evidence before any resumed native mutation',
    async (change) => {
      const f = await interruptedCreate(),
        before = [...f.calls];
      let planHash = f.result.planHash;
      if (change === 'file') await edit(f.path, (s) => s.replace('First answer', 'Changed answer'));
      if (change === 'hash') planHash = 'b'.repeat(64);
      if (change === 'kb')
        f.backend.identity = vi.fn(async () => ({ kbId: 'wrong', writable: true }));
      if (change === 'content') f.rems.get('created_1')!.text = ['External edit'];
      if (change === 'parent') f.rems.get('created_2')!.parent = 'daily';
      if (change === 'tag') f.rems.get('created_2')!.tags = ['external-tag'];
      if (change === 'card')
        f.rems.get('daily')!.cards = [
          {
            id: 'replacement-card',
            remId: 'daily',
            type: 'forward',
            createdAt: 1,
            repetitionHistory: [],
            nextRepetitionTime: null,
            lastRepetitionTime: null,
            timesWrongInRow: null,
          },
        ];
      if (change === 'step') {
        const state = await loadState(directory),
          store = localStore('kb');
        const journal = await store.getLocal<{ steps: Record<string, string> }>(
          state.pending!.journalKey
        );
        journal!.steps['unrelated:text'] = 'verified';
        await store.setLocal(state.pending!.journalKey, journal);
      }
      await expect(resumeWorkspace(directory, async () => f.backend, planHash)).rejects.toThrow();
      expect(f.calls).toEqual(before);
    }
  );

  it('resumes a second lost acknowledgement with the same IDs and leaves unselected edits untouched', async () => {
    const f = await interruptedCreate();
    const untouched = f.state.entries.subdoc!.path;
    const localBefore = await readPrivate(directory, untouched);
    f.rems.get('subdoc')!.text = ['Unselected external edit'];
    const parent = f.backend.setParent;
    f.backend.setParent = vi.fn(async (...args) => {
      await parent(...args);
      throw new Error('Second lost acknowledgement');
    });
    expect(
      await resumeWorkspace(directory, async () => f.backend, f.result.planHash)
    ).toMatchObject({
      status: 'unknown',
      complete: false,
      planHash: f.result.planHash,
    });
    f.backend.setParent = parent;
    expect(
      await resumeWorkspace(directory, async () => f.backend, f.result.planHash)
    ).toMatchObject({
      status: 'verified',
      complete: true,
    });
    expect(f.backend.create).toHaveBeenCalledTimes(3);
    expect(f.rems.get('created_1')!.children).toEqual(['created_2', 'created_3']);
    expect(await readPrivate(directory, untouched)).toBe(localBefore);
    expect(f.rems.get('subdoc')!.text).toEqual(['Unselected external edit']);
  });

  it.each(['publication', 'staging'] as const)(
    'recovers resumed %s without any remote replay',
    async (point) => {
      const f = await interruptedCreate(),
        original = LocalState.prototype.setLocal,
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
          if (point === 'staging' && to === f.path) throw new Error('Injected staged link failure');
          return link(root, from, to);
        });
      expect(
        await resumeWorkspace(directory, async () => f.backend, f.result.planHash)
      ).toMatchObject({ status: 'publication-incomplete' });
      stateSpy.mockRestore();
      fileSpy.mockRestore();
      const calls = [...f.calls];
      expect(
        await resumeWorkspace(directory, async () => f.backend, f.result.planHash)
      ).toMatchObject({ status: 'recovered', complete: true, remoteWrites: 0 });
      expect(f.calls).toEqual(calls);
      expect(
        await resumeWorkspace(directory, async () => f.backend, f.result.planHash)
      ).toMatchObject({ status: 'already-complete', remoteWrites: 0 });
    }
  );

  it('does not publish inconsistent Card IDs if they change during final cardFacts reads', async () => {
    const f = await interruptedCreate(),
      cardFacts = f.backend.cardFacts;
    f.backend.cardFacts = vi.fn(async (id) => {
      if (id === 'created_1')
        f.rems.get(id)!.cards = [
          {
            id: 'changed-final-card',
            remId: id,
            type: 'forward',
            createdAt: 1,
            repetitionHistory: [],
            nextRepetitionTime: null,
            lastRepetitionTime: null,
            timesWrongInRow: null,
          },
        ];
      return cardFacts(id);
    });
    expect(
      await resumeWorkspace(directory, async () => f.backend, f.result.planHash)
    ).toMatchObject({
      status: 'conflict',
      complete: false,
      error: expect.stringContaining('card identity'),
    });
    expect((await loadState(directory)).pending!.planHash).toBe(f.result.planHash);
  });
});

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
    expect(f.backend.readProbe).toHaveBeenCalled();
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
  it('imports bounded new empty descendants and preserves their identities on the next sync', async () => {
    const f = await prepare();
    f.rems.get('chapter')!.children.unshift('incoming');
    f.rems.set('incoming', native('incoming', [], { parent: 'chapter', children: ['leaf'] }));
    f.rems.set('leaf', native('leaf', ['Native leaf'], { parent: 'incoming', tags: ['home'] }));
    expect(await pushWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
      status: 'verified',
      incoming: ['incoming', 'leaf'],
      remoteWrites: 0,
      selection: { addedIds: ['incoming', 'leaf'] },
    });
    const state = await loadState(directory);
    expect(state.entries.incoming?.path).toBe(f.path);
    expect(state.entries.leaf?.path).toBe(f.path);
    expect((await inspectLocal(directory)).diagnostics).toEqual([]);
    expect(await readPrivate(directory, state.entries.incoming!.rawPath)).toContain('"leaf"');
    const identity = await readPrivate(directory, IDENTITY);
    expect(await pushWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
      status: 'unchanged',
      remoteWrites: 0,
    });
    expect(await readPrivate(directory, IDENTITY)).toBe(identity);
    expect(f.backend.enumerate).toHaveBeenCalledTimes(1);
    expect(f.calls).toEqual([]);
  });
  it('merges incoming nested native documents with a local body edit in the selected document', async () => {
    const f = await prepare();
    await edit(f.path, (source) => source.replace('Because', 'Local answer'));
    f.rems.get('daily')!.children.push('incoming-doc');
    f.rems.set(
      'incoming-doc',
      native('incoming-doc', ['New native document'], {
        parent: 'daily',
        document: true,
        children: ['incoming-note'],
      })
    );
    f.rems.set(
      'incoming-note',
      native('incoming-note', ['A remote note'], { parent: 'incoming-doc' })
    );
    expect(
      await pushWorkspace(directory, async () => f.backend, { apply: true, paths: [f.path] })
    ).toMatchObject({
      status: 'verified',
      incoming: ['incoming-doc', 'incoming-note'],
      updated: ['answer'],
    });
    const state = await loadState(directory),
      newPath = state.entries['incoming-doc']!.path;
    expect(newPath).not.toBe(f.path);
    expect(await readPrivate(directory, newPath)).toContain('A remote note');
    expect(await readPrivate(directory, f.path)).toContain('Local answer');
    expect((await inspectLocal(directory)).diagnostics).toEqual([]);
    expect(f.calls).toEqual(['answer:text']);
  });
  it('rejects same-parent local and incoming insertions before any native write', async () => {
    const f = await prepare();
    await edit(f.path, (source) => addNodes(source, { n: 'text' }, '\n- Local note ^local-n\n'));
    f.rems.get('daily')!.children.push('incoming');
    f.rems.set('incoming', native('incoming', [], { parent: 'daily' }));
    expect(await pushWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
      status: 'conflict',
      remoteWrites: 0,
      conflicts: expect.arrayContaining([
        expect.objectContaining({ id: 'daily', reason: 'remote-structure' }),
      ]),
    });
    expect(f.calls).toEqual([]);
    expect((await loadState(directory)).entries).toEqual(f.state.entries);
  });
  it('preserves both incoming Portal identities, query facts and an unselected membership target', async () => {
    const f = await prepare();
    await edit(f.path, (source) => source.replace('Because', 'Local revised answer'));
    f.rems.get('question')!.children.push('incoming-portal');
    f.rems.set(
      'incoming-portal',
      native('incoming-portal', [], {
        parent: 'question',
        type: 6,
        children: ['incoming-wrapper'],
        portal: {
          type: 4,
          directlyIncludedRemIds: ['incoming-wrapper'],
          query: null,
          filter: null,
        },
      })
    );
    f.rems.set(
      'incoming-wrapper',
      native('incoming-wrapper', [], {
        parent: 'incoming-portal',
        type: 6,
        portal: { type: null, directlyIncludedRemIds: ['subdoc'], query: null, filter: null },
      })
    );
    const targetRaw = await readPrivate(directory, f.state.entries.subdoc!.rawPath);
    const beforeCards = await f.backend.cardFacts('question');
    expect(
      await syncWorkspace(directory, async () => f.backend, { apply: true, paths: [f.path] })
    ).toMatchObject({
      status: 'verified',
      incoming: ['incoming-portal', 'incoming-wrapper'],
      updated: ['answer'],
      selection: { verificationIds: expect.arrayContaining(['subdoc']) },
    });
    const state = await loadState(directory);
    expect(state.entries.question!.editable).toBe(true);
    for (const id of ['incoming-portal', 'incoming-wrapper']) {
      expect(state.entries[id]!.editable).toBe(false);
      expect(JSON.parse(await readPrivate(directory, state.entries[id]!.rawPath))).toMatchObject({
        id,
        cards: [],
        portal: { query: null, filter: null },
      });
    }
    expect(await f.backend.cardFacts('question')).toEqual(beforeCards);
    expect(await readPrivate(directory, state.entries.subdoc!.rawPath)).toBe(targetRaw);
    expect(state.remoteVersions!.subdoc).toEqual(f.state.remoteVersions!.subdoc);
    expect(
      await syncWorkspace(directory, async () => f.backend, { apply: true, paths: [f.path] })
    ).toMatchObject({
      status: 'unchanged',
      remoteWrites: 0,
    });
    expect(f.calls).toEqual(['answer:text']);
  });
  it.each(['query', 'missing', 'duplicate', 'parent', 'cycle', 'graft', 'tag'] as const)(
    'rejects incomplete or unsafe incoming %s before an unrelated local edit writes',
    async (kind) => {
      const f = await prepare();
      await edit(f.path, (source) => source.replace('Because', 'Local answer'));
      f.rems.get('chapter')!.children.push('incoming');
      f.rems.set('incoming', native('incoming', [], { parent: 'chapter' }));
      const added = f.rems.get('incoming')!;
      if (kind === 'query')
        Object.assign(added, { type: 6, portal: { type: 4, directlyIncludedRemIds: [] } });
      if (kind === 'missing') f.rems.delete('incoming');
      if (kind === 'duplicate') added.children = ['leaf', 'leaf'];
      if (kind === 'parent') added.parent = 'daily';
      if (kind === 'cycle') added.children = ['incoming'];
      if (kind === 'graft') added.children = ['basic'];
      if (kind === 'tag') added.tags = ['unbound-tag'];
      const bytes = await readPrivate(directory, f.path);
      await expect(
        syncWorkspace(directory, async () => f.backend, { apply: true })
      ).rejects.toThrow();
      expect(f.calls).toEqual([]);
      expect(await readPrivate(directory, f.path)).toBe(bytes);
      expect((await loadState(directory)).entries).toEqual(f.state.entries);
    }
  );
  it('keeps additions in unselected documents outside discovery', async () => {
    const f = await prepare();
    f.rems.get('subdoc')!.children.push('incoming');
    f.rems.set('incoming', native('incoming', [], { parent: 'subdoc' }));
    expect(
      await syncWorkspace(directory, async () => f.backend, { apply: true, paths: [f.path] })
    ).toMatchObject({
      status: 'unchanged',
      remoteWrites: 0,
    });
    expect((await loadState(directory)).entries).toEqual(f.state.entries);
    expect(f.backend.read).not.toHaveBeenCalledWith(
      expect.arrayContaining(['incoming']),
      expect.anything()
    );
  });
  it.each(['remove', 'move', 'reorder'] as const)(
    'retains an explicit remote %s conflict even alongside a valid incoming branch',
    async (kind) => {
      const f = await prepare();
      f.rems.get('chapter')!.children.push('incoming');
      f.rems.set('incoming', native('incoming', [], { parent: 'chapter' }));
      if (kind === 'remove') {
        f.rems.delete('answer');
        f.rems.get('question')!.children = [];
      }
      if (kind === 'move') {
        f.rems.get('basic')!.parent = 'subdoc';
        f.rems.get('daily')!.children = f.rems
          .get('daily')!
          .children.filter((id) => id !== 'basic');
        f.rems.get('subdoc')!.children = ['basic'];
      }
      if (kind === 'reorder') f.rems.get('daily')!.children.reverse();
      expect(await syncWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
        status: 'conflict',
        remoteWrites: 0,
        conflicts: expect.any(Array),
      });
      expect(f.calls).toEqual([]);
    }
  );
  it('binds incoming contents and the exact added ID set to a frozen preview', async () => {
    const f = await prepare();
    f.rems.get('chapter')!.children.push('incoming');
    f.rems.set('incoming', native('incoming', ['Before'], { parent: 'chapter' }));
    const plan = (await syncWorkspace(directory, async () => f.backend)) as { planHash: string };
    f.rems.get('incoming')!.text = ['After'];
    await expect(
      syncWorkspace(directory, async () => f.backend, { apply: true, planHash: plan.planHash })
    ).rejects.toThrow('exact frozen');
    expect((await loadState(directory)).entries).toEqual(f.state.entries);
    expect(f.calls).toEqual([]);
  });
  it('imports native card history and tags without creating or replacing native cards', async () => {
    const f = await prepare();
    f.rems.get('chapter')!.children.push('incoming-card');
    const cards: WorkspaceRem['cards'] = [
      {
        id: 'existing-native-card',
        remId: 'incoming-card',
        type: 'backward',
        createdAt: 2,
        repetitionHistory: [{ time: 17, score: 1 }],
        nextRepetitionTime: 23,
        lastRepetitionTime: 17,
        timesWrongInRow: 0,
      },
    ];
    f.rems.set(
      'incoming-card',
      native('incoming-card', ['Native front'], {
        parent: 'chapter',
        backText: ['Native back'],
        cards,
        tags: ['home'],
      })
    );
    expect(await syncWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
      status: 'verified',
      remoteWrites: 0,
      incoming: ['incoming-card'],
    });
    const state = await loadState(directory);
    expect(
      JSON.parse(await readPrivate(directory, state.entries['incoming-card']!.rawPath))
    ).toMatchObject({ cards, tags: ['home'] });
    expect(await readPrivate(directory, f.path)).toContain('Native back');
    expect(f.calls).toEqual([]);
  });
  it('rejects an unpublishable incoming document before a mixed native edit', async () => {
    const f = await prepare();
    await edit(f.path, (source) => source.replace('Because', 'Local answer'));
    f.rems.get('chapter')!.children.push('incoming');
    f.rems.set(
      'incoming',
      native('incoming', ['x'.repeat(4 * 1024 * 1024)], { parent: 'chapter' })
    );
    await expect(syncWorkspace(directory, async () => f.backend, { apply: true })).rejects.toThrow(
      /exceeds|MiB|large|size/i
    );
    expect(f.calls).toEqual([]);
    expect((await loadState(directory)).entries).toEqual(f.state.entries);
  });
  it('checks the complete incoming publication ledger before a mixed native edit', async () => {
    const f = await prepare();
    await edit(f.path, (source) => source.replace('Because', 'Local answer'));
    f.rems.get('chapter')!.children.push('incoming');
    f.rems.set('incoming', native('incoming', [], { parent: 'chapter' }));
    const bytes = Buffer.byteLength;
    vi.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) =>
      typeof value === 'string' && value.includes('"previousHash":') && value.includes('"writes":')
        ? fileOps.MAX_METADATA_BYTES + 1
        : bytes(value, encoding)
    );
    await expect(syncWorkspace(directory, async () => f.backend, { apply: true })).rejects.toThrow(
      'publication metadata exceeds 32 MiB'
    );
    expect(f.calls).toEqual([]);
    expect((await loadState(directory)).entries).toEqual(f.state.entries);
  });
  it.each(
    (['direct', 'guarded'] as const).flatMap((mode) =>
      (['add', 'replace', 'remove'] as const).map((change) => ({ mode, change }))
    )
  )(
    'rejects incoming card $change before the first guard in $mode apply',
    async ({ mode, change }) => {
      const f = await prepare();
      await edit(f.path, (source) => source.replace('Because', 'Local answer'));
      const card = {
        id: 'original-card',
        remId: 'incoming',
        type: 'forward',
        createdAt: 1,
        repetitionHistory: [],
        nextRepetitionTime: null,
        lastRepetitionTime: null,
        timesWrongInRow: null,
      };
      f.rems.get('chapter')!.children.push('incoming');
      f.rems.set(
        'incoming',
        native('incoming', [], { parent: 'chapter', cards: change === 'add' ? [] : [card] })
      );
      const guard = f.backend.guard;
      let changed = false;
      f.backend.guard = vi.fn(async (ids) => {
        if (!changed) {
          changed = true;
          f.rems.get('incoming')!.cards =
            change === 'remove' ? [] : [{ ...card, id: 'replacement-card' }];
        }
        return guard(ids);
      });
      const options =
        mode === 'guarded'
          ? {
              paths: [f.path],
              expectedFileHash: (await workspace.readWorkspace(directory, f.path)).fileHash,
            }
          : {};
      expect(
        await syncWorkspace(directory, async () => f.backend, { apply: true, ...options })
      ).toMatchObject({
        status: 'conflict',
        complete: false,
        remoteWrites: 0,
        error: expect.stringContaining('card identity'),
      });
      expect(f.calls).toEqual([]);
      expect((await loadState(directory)).entries).toEqual(f.state.entries);
    }
  );
  it.each(['direct', 'guarded'] as const)(
    'preserves incoming remote-owned review updates before first guard in %s apply',
    async (mode) => {
      const f = await prepare();
      await edit(f.path, (source) => source.replace('Because', 'Local answer'));
      const card = {
        id: 'incoming-card',
        remId: 'incoming',
        type: 'forward',
        createdAt: 1,
        repetitionHistory: [],
        nextRepetitionTime: null,
        lastRepetitionTime: null,
        timesWrongInRow: null,
      };
      f.rems.get('chapter')!.children.push('incoming');
      f.rems.set('incoming', native('incoming', [], { parent: 'chapter', cards: [card] }));
      const reviewed = {
        ...card,
        repetitionHistory: [{ time: 2, score: 1 }],
        nextRepetitionTime: 5,
        lastRepetitionTime: 2,
        timesWrongInRow: 0,
      };
      const guard = f.backend.guard;
      let changed = false;
      f.backend.guard = vi.fn(async (ids) => {
        if (!changed) {
          changed = true;
          f.rems.get('incoming')!.cards = [reviewed];
        }
        return guard(ids);
      });
      const options =
        mode === 'guarded'
          ? {
              paths: [f.path],
              expectedFileHash: (await workspace.readWorkspace(directory, f.path)).fileHash,
            }
          : {};
      expect(
        await syncWorkspace(directory, async () => f.backend, { apply: true, ...options })
      ).toMatchObject({
        status: 'verified',
        complete: true,
        remoteWrites: 1,
        cardsPreserved: true,
      });
      const state = await loadState(directory);
      expect(
        JSON.parse(await readPrivate(directory, state.entries.incoming!.rawPath))
      ).toMatchObject({ cards: [reviewed] });
      expect(f.rems.get('incoming')!.cards).toEqual([reviewed]);
      expect(f.calls).toEqual(['answer:text']);
    }
  );
  it.each(['child', 'query', 'card'] as const)(
    'rejects an incoming %s race at the first write boundary',
    async (kind) => {
      const f = await prepare();
      await edit(f.path, (source) => source.replace('Because', 'Local answer'));
      f.rems.get('chapter')!.children.push('incoming');
      f.rems.set(
        'incoming',
        native('incoming', [], {
          parent: 'chapter',
          type: 6,
          portal: { type: 4, directlyIncludedRemIds: [], query: null, filter: null },
          cards: [],
        })
      );
      const guard = f.backend.guard;
      f.backend.guard = vi.fn(async (ids) => {
        const digest = await guard(ids);
        if (kind === 'child') f.rems.get('incoming')!.children = ['late'];
        if (kind === 'query') f.rems.get('incoming')!.portal!.query = 'changed';
        if (kind === 'card')
          f.rems.get('incoming')!.cards = [
            {
              id: 'late-card',
              remId: 'incoming',
              type: 'forward',
              createdAt: 1,
              repetitionHistory: [],
              nextRepetitionTime: null,
              lastRepetitionTime: null,
              timesWrongInRow: null,
            },
          ];
        return digest;
      });
      expect(await syncWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
        status: 'conflict',
        complete: false,
        remoteWrites: 0,
      });
      expect(f.calls).toEqual([]);
    }
  );
  it.each(['publication', 'staging'] as const)(
    'recovers incoming identity and a mixed local creation after %s failure without replay',
    async (point) => {
      const f = await prepare();
      await edit(f.path, (source) =>
        addNodes(source, { n: 'text' }, '\n- New local note ^local-n\n')
      );
      f.rems.get('chapter')!.children.push('incoming');
      f.rems.set('incoming', native('incoming', [], { parent: 'chapter' }));
      const original = LocalState.prototype.setLocal,
        link = fileOps.linkPrivate;
      const stateSpy = vi
        .spyOn(LocalState.prototype, 'setLocal')
        .mockImplementation(async function (key, value) {
          if (point === 'publication' && key.startsWith('publication:') && value !== null)
            throw new Error('Injected incoming publication failure');
          return original.call(this, key, value);
        });
      const fileSpy = vi
        .spyOn(fileOps, 'linkPrivate')
        .mockImplementation(async (root, from, to) => {
          if (point === 'staging' && to === f.path)
            throw new Error('Injected incoming staging failure');
          return link(root, from, to);
        });
      expect(
        await syncWorkspace(directory, async () => f.backend, { apply: true, paths: [f.path] })
      ).toMatchObject({
        status: 'publication-incomplete',
        ids: expect.any(Object),
      });
      stateSpy.mockRestore();
      fileSpy.mockRestore();
      const calls = [...f.calls];
      expect(await recoverWorkspace(directory, async () => f.backend)).toMatchObject({
        status: 'recovered',
        remoteWrites: 0,
      });
      expect(f.calls).toEqual(calls);
      const state = await loadState(directory);
      expect(state.entries.incoming).toBeDefined();
      expect(state.entries.created_1).toBeDefined();
      expect((await inspectLocal(directory)).diagnostics).toEqual([]);
      expect(
        await syncWorkspace(directory, async () => f.backend, { apply: true, paths: [f.path] })
      ).toMatchObject({
        status: 'unchanged',
        remoteWrites: 0,
      });
    }
  );
  it.each(['identity', 'query', 'card'] as const)(
    'refuses changed incoming %s during verified-publication recovery without replay',
    async (kind) => {
      const f = await prepare();
      f.rems.get('chapter')!.children.push('incoming');
      f.rems.set(
        'incoming',
        native('incoming', [], {
          parent: 'chapter',
          type: 6,
          cards: [],
          portal: { type: 4, directlyIncludedRemIds: [], query: null, filter: null },
        })
      );
      const original = LocalState.prototype.setLocal;
      const spy = vi
        .spyOn(LocalState.prototype, 'setLocal')
        .mockImplementation(async function (key, value) {
          if (key.startsWith('publication:') && value !== null)
            throw new Error('Injected publication failure');
          return original.call(this, key, value);
        });
      expect(await syncWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
        status: 'publication-incomplete',
        remoteWrites: 0,
      });
      spy.mockRestore();
      if (kind === 'identity') {
        f.rems.get('incoming')!.children.push('late');
        f.rems.set('late', native('late', [], { parent: 'incoming' }));
      }
      if (kind === 'query') f.rems.get('incoming')!.portal!.query = 'late query';
      if (kind === 'card')
        f.rems.get('incoming')!.cards = [
          {
            id: 'late-card',
            remId: 'incoming',
            type: 'forward',
            createdAt: 1,
            repetitionHistory: [],
            nextRepetitionTime: null,
            lastRepetitionTime: null,
            timesWrongInRow: null,
          },
        ];
      await expect(recoverWorkspace(directory, async () => f.backend)).rejects.toThrow(/changed/i);
      expect(f.calls).toEqual([]);
      expect((await loadState(directory)).entries).toEqual(f.state.entries);
    }
  );
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
  it.each(['missing', 'move'] as const)(
    'reports remote %s without silently claiming global discovery or deleting content',
    async (kind) => {
      const f = await prepare();
      const before = await readPrivate(directory, f.path);
      if (kind === 'missing') f.rems.delete('answer');
      else {
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
  it('publishes local aliases, comments and filename changes without moving or rewriting a native Rem', async () => {
    const f = await prepare();
    const renamedPath = 'HOME/Renamed.md';
    await edit(f.path, (source) => {
      const parsed = parseFrontmatter(f.path, source),
        metadata = parsed.attributes!;
      metadata.title = 'Display only';
      metadata.aliases = ['Alternative'];
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
