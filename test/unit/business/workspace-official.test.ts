import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { readOfficialExport } from '../../../src/business/workspace/official-export.js';
import {
  diffWorkspace,
  importWorkspace,
  lintWorkspace,
  recoverWorkspace,
} from '../../../src/business/workspace/workspace.js';
import { inspectLocal, loadState } from '../../../src/business/workspace/local.js';
import { allFiles, readPrivate, writePrivate } from '../../../src/business/workspace/files.js';
import { FrozenFiles } from '../../../src/business/workspace/frozen-files.js';
import { normalizeRichText } from '../../../src/business/workspace/markdown.js';
import type {
  NativeFlags,
  WorkspaceBackend,
  WorkspaceRem,
} from '../../../src/business/workspace/types.js';

let temporary: string;
beforeEach(async () => {
  temporary = await realpath(await mkdtemp(join(tmpdir(), 'remnote-official-test-')));
  vi.stubEnv('REMNOTE_CLI_CONFIG', join(temporary, 'config', 'connection.json'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(temporary, { recursive: true, force: true });
});

async function bootstrap(
  extra: Record<string, unknown> = {},
  complete = true,
  headerFields: Record<string, unknown> = {},
  originalFields: Record<string, unknown> = {}
) {
  const flags = {
    document: false,
    folder: false,
    cardItem: false,
    practice: 'forward' as const,
    enablePractice: true,
    ...(complete ? { unsupported: '' } : {}),
  };
  const rems: WorkspaceRem[] = [
    {
      id: 'root',
      parent: null,
      children: ['child'],
      type: null,
      text: ['Root'],
      backText: null,
      ...flags,
    },
    {
      id: 'child',
      parent: 'root',
      children: [],
      type: null,
      text: ['First\nQuestion'],
      backText: ['First\nAnswer'],
      ...flags,
    },
  ];
  const header = { knowledgebaseId: 'kb', exportVersion: 1, exportDate: '2026-11-15T00:00:00Z' };
  const bytes = zipSync({
    'rem.json': Buffer.from(
      JSON.stringify({
        ...header,
        ...headerFields,
        docs: rems.map(({ id, parent, text }) => ({
          _id: id,
          parent,
          key: text,
          future: { retained: true },
          ...originalFields,
        })),
      })
    ),
    'cards.json': Buffer.from(
      JSON.stringify({ ...header, docs: [{ rId: 'orphan', history: [1] }] })
    ),
  });
  const archive = join(temporary, 'export.rem'),
    snapshot = join(temporary, 'snapshot.json');
  await writeFile(archive, bytes, { mode: 0o600 });
  await writeFile(
    snapshot,
    JSON.stringify({
      schemaVersion: 1,
      knowledgeBaseId: 'kb',
      exportDate: header.exportDate,
      sourceSha256: createHash('sha256').update(bytes).digest('hex'),
      snapshots: rems.map(({ id, parent, children, type, text, backText }) => ({
        $type: 'rem',
        id,
        parent,
        children,
        type,
        text,
        backText,
        updatedAt: 123,
      })),
      flags: { root: flags, child: { ...flags, ...extra } },
    }),
    { mode: 0o600 }
  );
  return { archive, snapshot, rems };
}

const cards = [
  {
    id: 'card',
    remId: 'child',
    type: 'forward' as const,
    createdAt: 1,
    repetitionHistory: [{ time: 10, score: 2 }],
    nextRepetitionTime: 20,
    lastRepetitionTime: 10,
    timesWrongInRow: 0,
  },
];
const facts = {
  isTable: false,
  isProperty: false,
  isPowerup: false,
  isPowerupSlot: false,
  isPowerupProperty: false,
  isPowerupEnum: false,
  isPowerupPropertyListItem: false,
  isTodo: null,
};

describe('official snapshot native fact consumption', () => {
  it('publishes and revalidates an aggregate original manifest larger than ordinary content', async () => {
    const input = await bootstrap({}, true, { syntheticNotes: 'metadata'.repeat(655360) }),
      directory = join(temporary, 'workspace');
    const factory = vi.fn(async (): Promise<WorkspaceBackend> => {
      throw new Error('Must remain offline');
    });
    const official = await readOfficialExport(input.archive, input.snapshot, 'kb');
    expect(
      Buffer.byteLength(official.originals.get(official.source.manifestPath)!)
    ).toBeGreaterThan(4 * 1024 * 1024);
    expect(
      await importWorkspace(directory, 'kb', factory, {
        export: input.archive,
        snapshot: input.snapshot,
      })
    ).toMatchObject({ complete: true, rems: 2 });
    expect(await readPrivate(directory, official.source.manifestPath)).toBe(
      official.originals.get(official.source.manifestPath)
    );
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    expect(await diffWorkspace(directory)).toMatchObject({ changes: [] });
    const frozen = await FrozenFiles.capture(directory);
    await frozen.check();
    expect(await recoverWorkspace(directory, factory)).toMatchObject({
      complete: true,
      remoteWrites: 0,
    });
    await writePrivate(
      directory,
      official.source.manifestPath,
      official.originals.get(official.source.manifestPath)!.replace('metadata', 'modified')
    );
    await expect(frozen.check()).rejects.toThrow('Local file changed');
    expect(await lintWorkspace(directory)).toMatchObject({ ok: false });
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(['manifest', 'original'])(
    'rejects an oversized official %s before staging or publishing original content',
    async (kind) => {
      const input = await bootstrap(
        {},
        true,
        kind === 'manifest' ? { syntheticNotes: 'x'.repeat(32 * 1024 * 1024) } : {},
        kind === 'original' ? { syntheticPayload: 'x'.repeat(4 * 1024 * 1024) } : {}
      );
      await expect(readOfficialExport(input.archive, input.snapshot, 'kb')).rejects.toThrow(
        'safe byte bound'
      );
      const directory = join(temporary, 'workspace');
      const factory = vi.fn(async (): Promise<WorkspaceBackend> => {
        throw new Error('Must remain offline');
      });
      expect(
        await importWorkspace(directory, 'kb', factory, {
          export: input.archive,
          snapshot: input.snapshot,
        })
      ).toMatchObject({ status: 'incomplete', complete: false });
      expect(await allFiles(directory)).toEqual(['.gitignore']);
      expect((await loadState(directory)).entries).toEqual({});
      expect(factory).not.toHaveBeenCalled();
    }
  );

  it('imports complete facts and cards into YAML without materializing absent facts or losing source semantics', async () => {
    const extra: NativeFlags = {
      cards,
      facts,
      portal: null,
      collected: ['cards', 'isTodo', 'portal'],
    };
    const input = await bootstrap(extra),
      directory = join(temporary, 'workspace');
    await mkdir(join(directory, '.obsidian'), { mode: 0o700, recursive: true });
    const obsidianConfig = '{"existing-user-setting":true}\n';
    await writeFile(join(directory, '.obsidian', 'app.json'), obsidianConfig, { mode: 0o644 });
    const factory = vi.fn(async (): Promise<WorkspaceBackend> => {
      throw new Error('Must remain offline');
    });
    expect(
      await importWorkspace(directory, 'kb', factory, {
        export: input.archive,
        snapshot: input.snapshot,
      })
    ).toMatchObject({ complete: true, rems: 2 });
    expect(factory).not.toHaveBeenCalled();
    expect(await readFile(join(directory, '.obsidian', 'app.json'), 'utf8')).toBe(obsidianConfig);
    expect(await lintWorkspace(directory)).toMatchObject({ ok: true });
    expect(await diffWorkspace(directory)).toMatchObject({ changes: [] });
    const state = await loadState(directory),
      path = state.entries.child!.path;
    const parsed = (await inspectLocal(directory)).parsed.get(path)!;
    const metadata = parsed.metadata!;
    const entry = metadata.rems.child!;
    if (entry.id === null) throw new Error('Expected native entry');
    expect(entry.content).toBe('basic');
    expect(entry.native.cards).toEqual(cards);
    expect(entry.native.collected).toEqual(
      expect.arrayContaining(['cards', 'isTodo', 'portal', 'isTable'])
    );
    expect(entry.native.collected).not.toContain('isQuote');
    const raw = JSON.parse(await readPrivate(directory, state.entries.child!.rawPath));
    expect(raw.facts).toEqual(facts);
    expect(raw.cards).toEqual(cards);
    expect(raw.portal).toBeNull();
    for (const rem of input.rems) {
      const node = parsed.nodes.find((node) => node.key === rem.id)!;
      expect(normalizeRichText(node.text)).toEqual(normalizeRichText(rem.text));
      if (Array.isArray(rem.backText))
        expect(normalizeRichText(node.backText)).toEqual(normalizeRichText(rem.backText));
    }
    expect(
      JSON.parse(await readPrivate(directory, '.remnote/originals/cards/000000.json'))
    ).toEqual({ rId: 'orphan', history: [1] });
  });

  it('preserves partial/known-null facts but leaves unaudited nodes read only', async () => {
    const input = await bootstrap(
      { facts: { isTodo: null }, cards: [], collected: ['isTodo', 'cards'] },
      false
    );
    const result = await readOfficialExport(input.archive, input.snapshot, 'kb');
    expect(result.rems[1]).toMatchObject({
      unsupported: 'unverified-native-flags',
      facts: { isTodo: null },
      cards: [],
    });
    expect(result.rems[1]!.facts).not.toHaveProperty('isTable');
  });

  it.each([
    { facts: { isTable: 'false' } },
    { cards: [{ ...cards[0], remId: 'other' }] },
    { cards: [{ ...cards[0], type: 'unknown' }] },
    { collected: ['inventedField'] },
  ])('rejects malformed or misbound native metadata before import: %j', async (extra) => {
    const input = await bootstrap(extra);
    await expect(readOfficialExport(input.archive, input.snapshot, 'kb')).rejects.toThrow();
  });

  it('retains full subtree facts/cards and already collected supplemental fields during explicit verification', async () => {
    const input = await bootstrap(
      { facts: { isTodo: null }, collected: ['isTodo'], portal: null },
      false
    );
    const backend = {
      identity: async () => ({ kbId: 'kb', writable: false }),
      subtree: async () =>
        input.rems.map((rem) => ({
          ...rem,
          ...(rem.id === 'child' ? { facts: { isTable: false }, cards } : {}),
        })),
    } as unknown as WorkspaceBackend;
    const result = await readOfficialExport(
      input.archive,
      input.snapshot,
      'kb',
      async () => backend,
      'root'
    );
    expect(result.rems[1]).toMatchObject({
      facts: { isTodo: null, isTable: false },
      cards,
      portal: null,
    });
    expect(result.rems[1]!.unsupported).toBeUndefined();
  });
});
