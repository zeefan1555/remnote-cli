import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fileOps from '../../../src/business/workspace/files.js';
import { formatWorkspace } from '../../../src/business/workspace/format.js';
import {
  IDENTITY,
  originalPath,
  workspaceIdentity,
} from '../../../src/business/workspace/identity.js';
import {
  inspectLocal,
  loadState,
  publicationStore,
  saveState,
  writeSnapshot,
} from '../../../src/business/workspace/local.js';
import {
  documentMetadata,
  normalizeRichText,
  parseDocument,
  renderDocument,
} from '../../../src/business/workspace/markdown.js';
import { parseFrontmatter, renderFrontmatter } from '../../../src/business/workspace/metadata.js';
import * as publication from '../../../src/business/workspace/publication.js';
import {
  hash,
  type ParsedOutline,
  type WorkspaceRem,
} from '../../../src/business/workspace/types.js';

let temporary: string, directory: string;
beforeEach(async () => {
  temporary = await realpath(await mkdtemp(join(tmpdir(), 'remnote-blank-render-test-')));
  directory = await fileOps.workspaceDirectory(join(temporary, 'vault'), true);
  vi.stubEnv('REMNOTE_CLI_CONFIG', join(temporary, 'config', 'connection.json'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(temporary, { recursive: true, force: true });
});

function rem(id: string, text: unknown, extra: Partial<WorkspaceRem> = {}): WorkspaceRem {
  return {
    id,
    text,
    parent: 'root',
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
function graph(text: unknown = ['']) {
  return new Map([
    [
      'root',
      rem('root', ['Blank notes'], {
        parent: null,
        document: true,
        children: ['blank', 'ref', 'body'],
      }),
    ],
    [
      'blank',
      rem('blank', text, { children: ['nested'], public: { id: 'blank', unknown: 'retained' } }),
    ],
    ['nested', rem('nested', [''], { parent: 'blank' })],
    ['ref', rem('ref', [{ i: 'q', _id: 'blank' }])],
    ['body', rem('body', ['Before ', { i: 'm', text: 'bold', b: true }, ' after'])],
  ]);
}
function semantics(document: ParsedOutline) {
  return document.nodes.map(({ key, blockId, parent, kind, children, text, backText }) => ({
    key,
    blockId,
    parent,
    kind,
    children,
    text: normalizeRichText(text),
    backText: normalizeRichText(backText),
  }));
}

describe('blank native Rem rendering', () => {
  it.each([null, [], [''], ['', ''], [{ i: 'm', text: '' }]].map((text) => ({ text })))(
    'renders a blank bullet without an entity for $text and round-trips every identity',
    ({ text }) => {
      const native = graph(text),
        paths = new Map([['root', 'Blank.md']]);
      const blocks = new Map([...native.keys()].map((id) => [id, `custom-${id}`]));
      const metadata = documentMetadata('root', native, paths, { blocks });
      const source = renderDocument('root', 'Blank.md', native, paths, { blocks });
      expect(source).toContain('- ^custom-blank\n  - ^custom-nested');
      expect(source).not.toContain('&#x20;');
      expect(source).toContain('[[Blank#^custom-blank|');
      expect(source).toContain('Before **bold** after ^custom-body');
      const parsed = parseDocument('Blank.md', source, metadata);
      expect(parsed.diagnostics).toEqual([]);
      expect(parsed.document.nodes.map(({ key }) => key)).toEqual([...native.keys()]);
      expect(parsed.document.nodes.find(({ key }) => key === 'blank')).toMatchObject({
        text: [],
        children: ['nested'],
        parent: 'root',
        blockId: 'custom-blank',
      });
      expect(parsed.document.nodes.find(({ key }) => key === 'nested')).toMatchObject({
        parent: 'blank',
        text: [],
      });
      expect(parsed.document.nodes.find(({ key }) => key === 'ref')!.text).toEqual([
        { i: 'q', _id: 'blank' },
      ]);
    }
  );

  it('retains meaningful whitespace rather than trimming blank-looking native text', () => {
    const native = graph([' ']),
      paths = new Map([['root', 'Blank.md']]);
    const parsed = parseDocument(
      'Blank.md',
      renderDocument('root', 'Blank.md', native, paths),
      documentMetadata('root', native, paths)
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.document.nodes.find(({ key }) => key === 'blank')!.text).toEqual([' ']);
  });
});

/** A sealed synthetic old-renderer snapshot. No real vault or backend is accessed. */
async function sealedHuman() {
  const native = graph();
  const originals = new Map([[originalPath('rems', 'blank'), '{ "original": "untouched" }\n']]);
  const state = await writeSnapshot(
    directory,
    'blank-test-kb',
    [...native.values()],
    undefined,
    undefined,
    undefined,
    originals
  );
  const path = state.entries.root!.path;
  let source = await fileOps.readPrivate(directory, path);
  for (const [id, entry] of Object.entries(state.entries)) {
    const old = entry.blockId;
    entry.blockId = `custom-${id}`;
    source = source.replaceAll(old, entry.blockId);
  }
  source = source.replace(/(^\s*- )(?:&#x20;)?\^(custom-(?:blank|nested))$/gm, '$1&#x20;^$2');
  const attributes = { title: 'My title', aliases: ['An alias'], tags: ['reading'], rems: {} };
  const frontmatter = parseFrontmatter(path, source);
  source = renderFrontmatter(attributes) + `<!-- remnote:custom-root -->\n\n` + frontmatter.body;
  state.documents[path]!.fileHash = hash(source);
  state.localVersions = {
    body: { contentHash: hash('local-evidence'), timestamp: 123, source: 'cli-save' },
  };
  state.remoteVersions!.blank = {
    contentHash: hash('remote-evidence'),
    timestamp: 456,
    source: 'rem-updated-at',
    sinceBaseline: true,
  };
  await fileOps.writePrivate(directory, path, source);
  await fileOps.writePrivate(
    directory,
    IDENTITY,
    JSON.stringify(workspaceIdentity(state), null, 2) + '\n'
  );
  await saveState(directory, state);
  const local = await inspectLocal(directory);
  expect(local.diagnostics).toEqual([]);
  expect(local.dirty).toEqual([]);
  return { native, state, path, source, attributes, local };
}

describe('offline canonical human format', () => {
  it('rerenders a clean sealed human vault, preserving attributes, anchors, records, originals and clocks', async () => {
    const f = await sealedHuman();
    const raw = new Map(
      await Promise.all(
        (await fileOps.allFiles(directory))
          .filter((path) => path.startsWith('.remnote/'))
          .map(async (path) => [path, await fileOps.readPrivate(directory, path)] as const)
      )
    );
    expect(await formatWorkspace(directory)).toMatchObject({
      status: 'formatted',
      remoteWrites: 0,
      originals: 'unchanged',
    });
    const source = await fileOps.readPrivate(directory, f.path),
      local = await inspectLocal(directory);
    expect(source).toContain('- ^custom-blank\n  - ^custom-nested');
    expect(source).not.toContain('&#x20;');
    expect(local.diagnostics).toEqual([]);
    expect(local.dirty).toEqual([]);
    expect(local.parsed.get(f.path)!.attributes).toEqual(f.attributes);
    expect(semantics(local.parsed.get(f.path)!)).toEqual(semantics(f.local.parsed.get(f.path)!));
    expect(local.state).toEqual({
      ...f.state,
      documents: {
        ...f.state.documents,
        [f.path]: { ...f.state.documents[f.path]!, fileHash: hash(source) },
      },
    });
    for (const [path, content] of raw)
      expect(await fileOps.readPrivate(directory, path)).toBe(content);
    const displaced = await Promise.all(
      (await fileOps.allFiles(directory, '.sync/staging'))
        .filter((path) => path.endsWith('.displaced'))
        .map((path) => fileOps.readPrivate(directory, path))
    );
    expect(displaced).toContain(f.source);
  });

  it('is an exact no-op once canonical and creates no additional publication', async () => {
    const f = await sealedHuman();
    await formatWorkspace(directory);
    const before = await loadState(directory),
      source = await fileOps.readPrivate(directory, f.path);
    const stage = vi.spyOn(publication, 'stageSnapshot');
    expect(await formatWorkspace(directory)).toMatchObject({
      status: 'already-formatted',
      remoteWrites: 0,
    });
    expect(stage).not.toHaveBeenCalled();
    expect(await loadState(directory)).toEqual(before);
    expect(await fileOps.readPrivate(directory, f.path)).toBe(source);
  });

  it('refuses dirty editable source without consuming its version evidence', async () => {
    const f = await sealedHuman();
    const edited = f.source.replace('Before', 'Unsaved');
    await fileOps.writePrivate(directory, f.path, edited);
    await expect(formatWorkspace(directory)).rejects.toThrow('locally edited');
    expect(await fileOps.readPrivate(directory, f.path)).toBe(edited);
    expect(await loadState(directory)).toEqual(f.state);
  });

  it('does not use a sealed file hash to discard text inconsistent with the native baseline', async () => {
    const f = await sealedHuman();
    const source = f.source.replace('Before', 'Different');
    await fileOps.writePrivate(directory, f.path, source);
    f.state.documents[f.path]!.fileHash = hash(source);
    await saveState(directory, f.state);
    const stage = vi.spyOn(publication, 'stageSnapshot');
    await expect(formatWorkspace(directory)).rejects.toThrow(
      'differs from the sealed native baseline'
    );
    expect(stage).not.toHaveBeenCalled();
    expect(await fileOps.readPrivate(directory, f.path)).toBe(source);
    expect(await loadState(directory)).toEqual(f.state);
  });

  it.each(['identity', 'record', 'missing'] as const)(
    'refuses %s inconsistency before staging',
    async (kind) => {
      const f = await sealedHuman();
      if (kind === 'identity') await fileOps.writePrivate(directory, IDENTITY, '{}');
      if (kind === 'record')
        await fileOps.writePrivate(directory, f.state.entries.blank!.rawPath, '{}');
      if (kind === 'missing') await rm(join(directory, f.path));
      const stage = vi.spyOn(publication, 'stageSnapshot');
      await expect(formatWorkspace(directory)).rejects.toThrow('Format refused');
      expect(stage).not.toHaveBeenCalled();
      expect(await loadState(directory)).toEqual(f.state);
    }
  );

  it('refuses pending remote journals and pending local publications', async () => {
    const f = await sealedHuman();
    await saveState(directory, {
      ...f.state,
      pending: { planHash: 'a'.repeat(64), journalKey: 'unknown' },
    });
    await expect(formatWorkspace(directory)).rejects.toThrow('pending remote journal');
    await saveState(directory, f.state);
    await publicationStore().setLocal(`publication:${hash(directory)}`, {
      version: 1,
      directory,
      previousHash: hash(f.state),
      next: f.state,
      baseline: {},
      writes: [],
    });
    await expect(formatWorkspace(directory)).rejects.toThrow(
      'Unfinished local snapshot publication'
    );
    expect(await fileOps.readPrivate(directory, f.path)).toBe(f.source);
  });

  it('freezes source before staging and preserves a concurrent edit', async () => {
    const f = await sealedHuman(),
      write = fileOps.writePrivate;
    let changed = false;
    vi.spyOn(fileOps, 'writePrivate').mockImplementation(async (root, path, content, maxBytes) => {
      if (!changed && path.startsWith('.sync/staging/')) {
        changed = true;
        await write(root, f.path, f.source + '\nConcurrent edit\n');
      }
      return write(root, path, content, maxBytes);
    });
    await expect(formatWorkspace(directory)).rejects.toThrow('Local file changed');
    expect(changed).toBe(true);
    expect(await fileOps.readPrivate(directory, f.path)).toContain('Concurrent edit');
    expect(await loadState(directory)).toEqual(f.state);
  });
});
