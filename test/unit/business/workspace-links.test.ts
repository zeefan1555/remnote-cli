import { posix } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkspaceLinks,
  type LinkDocument,
  type LinkTarget,
} from '../../../src/business/workspace/links.js';
import { documentMetadata } from '../../../src/business/workspace/markdown.js';
import { referenceBranches } from '../../../src/business/workspace/reference-projection.js';
import type { WorkspaceRem } from '../../../src/business/workspace/types.js';
import { PORTAL_TYPE, RemType } from '../../../src/business/sdk-constants.generated.js';

function document(id: string, path: string, title = id): LinkDocument {
  const rem = (key: string, parent: string | null, children: string[]): WorkspaceRem => ({
    id: key,
    text: [key],
    parent,
    children,
    type: null,
    backText: null,
    document: parent === null,
    folder: false,
    cardItem: false,
    practice: 'none',
    enablePractice: false,
  });
  const rems = new Map([
    [id, rem(id, null, [`${id}-child`])],
    [`${id}-child`, rem(`${id}-child`, id, [])],
  ]);
  return { path, title, metadata: documentMetadata(id, rems, new Map([[id, path]])) };
}

// Frozen linear resolver from 86c2aba. Keep the independent scans as a semantic oracle.
function linearResolver(documents: LinkDocument[]) {
  const pathKey = (path: string) => path.normalize('NFC').toLocaleLowerCase('en-US');
  const stem = (path: string) => path.replace(/\.md$/i, '');
  const byId = new Map<string, LinkTarget>();
  for (const document of documents) {
    const hidden = new Set(
      [...referenceBranches(document.metadata).values()].flatMap((branch) => branch.ids.slice(1))
    );
    for (const [key, entry] of Object.entries(document.metadata.rems))
      byId.set(key, {
        id: key,
        path: document.path,
        block: entry.block,
        root: key === document.metadata.root,
        title: key === document.metadata.root ? document.title : key,
        hidden: hidden.has(key),
      });
  }
  return (currentPath: string, target: string): LinkTarget => {
    const separator = target.indexOf('#');
    const file = separator < 0 ? target : target.slice(0, separator);
    const fragment = separator < 0 ? '' : target.slice(separator + 1);
    if (target.includes('\\') || target.includes('\n') || file.includes(':'))
      throw new Error('Unsupported Wiki link target');
    let candidates: LinkDocument[];
    if (!file) candidates = documents.filter((doc) => pathKey(doc.path) === pathKey(currentPath));
    else {
      const exact =
        file.startsWith('./') || file.startsWith('../')
          ? posix.normalize(posix.join(posix.dirname(currentPath), file))
          : file.replace(/^\//, '');
      candidates = documents.filter((doc) => pathKey(stem(doc.path)) === pathKey(stem(exact)));
      if (!candidates.length && !file.includes('/'))
        candidates = documents.filter(
          (doc) => pathKey(stem(posix.basename(doc.path))) === pathKey(stem(file))
        );
    }
    if (candidates.length !== 1)
      throw new Error(
        candidates.length
          ? 'Ambiguous Wiki link file name; use the full vault path'
          : 'Unknown Wiki link file'
      );
    const doc = candidates[0]!;
    if (!fragment) return byId.get(doc.metadata.root)!;
    if (fragment.startsWith('^')) {
      const matches = Object.entries(doc.metadata.rems).filter(
        ([, entry]) => entry.block === fragment.slice(1)
      );
      if (matches.length !== 1) throw new Error('Unknown or ambiguous Wiki block ID');
      const target = byId.get(matches[0]![0])!;
      if (target.root || target.hidden)
        throw new Error(
          'Document roots and hidden reference wrappers have no visible block anchor'
        );
      return target;
    }
    if (pathKey(fragment) === pathKey(doc.title)) return byId.get(doc.metadata.root)!;
    throw new Error('Heading does not uniquely identify a modeled Rem');
  };
}

function outcome(
  resolve: (path: string, target: string) => LinkTarget,
  path: string,
  target: string
) {
  try {
    return { target: resolve(path, target) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

describe('operation-local Wiki path index', () => {
  it('normalizes lookup paths a bounded number of times regardless of document count', () => {
    const docs = Array.from({ length: 100 }, (_, i) => document(`doc${i}`, `Dir${i}/Note.md`));
    const links = new WorkspaceLinks(docs);
    const normalize = vi.spyOn(String.prototype, 'normalize');
    try {
      expect(links.resolve('Dir0/Note.md', 'Dir99/Note').id).toBe('doc99');
      expect(normalize.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      normalize.mockRestore();
    }
  });

  it('preserves the frozen resolver outcomes for full, relative, short, case and Unicode paths', () => {
    const docs = [
      document('top', 'Note.md', 'Main title'),
      document('one', 'One/Note.md'),
      document('two', 'Two/Note.MD'),
      document('unique', 'Else/Unique.md'),
      document('accent', 'Résumé/Café.md', 'Café'),
      document('dot', 'Names/İ.md', 'İ'),
      document('sharp', 'Names/ß.md'),
    ];
    const indexed = new WorkspaceLinks(docs),
      linear = linearResolver(docs);
    const paths = [
      ...docs.map((doc) => doc.path),
      'Missing.md',
      're\u0301sume\u0301/CAFE\u0301.MD',
    ];
    const targets = [
      '',
      '#',
      '#Main title',
      '#Not a heading',
      'Note',
      'note.MD',
      './Note',
      '../Note',
      '../Two/Note',
      'One/../Two/Note',
      '/Two/Note',
      '//Two/Note',
      'Unique',
      'Unknown',
      'Absent/Unique',
      're\u0301sume\u0301/CAFE\u0301',
      'Café#cafe\u0301',
      'İ',
      'i',
      'i\u0307',
      'ß',
      'SS',
      'https://invalid',
      'One\\Note',
      'Note\n',
      '#^missing',
      ...docs.flatMap((doc) => [
        doc.path,
        doc.path.replace(/\.md$/i, ''),
        `${doc.path}#^${doc.metadata.rems[doc.metadata.root]!.block}`,
        `${doc.path}#^${doc.metadata.rems[`${doc.metadata.root}-child`]!.block}`,
      ]),
    ];
    for (const path of paths)
      for (const target of targets)
        expect(
          outcome(indexed.resolve.bind(indexed), path, target),
          `${path} -> ${target}`
        ).toEqual(outcome(linear, path, target));
    // A full-path match must win before short-name fallback even when basenames collide.
    expect(indexed.resolve('Else/Unique.md', 'Note').id).toBe('top');
    expect(indexed.resolve('One/Note.md', 'Unique').id).toBe('unique');
    expect(() => indexed.resolve('One/Note.md', 'Absent/Unique')).toThrow('Unknown Wiki link file');
  });

  it.each([
    ['One/Note.md', 'Two/Note.md', 'Note'],
    ['One/Note.md', 'one/note.MD', 'ONE/NOTE'],
    ['Résumé/Café.md', 'Re\u0301sume\u0301/Cafe\u0301.md', 'Résumé/Café'],
    ['same.md', 'same.md', 'same'],
  ])('retains every collision instead of choosing a winner: %s / %s', (a, b, target) => {
    const docs = [document('first', a), document('second', b)];
    const indexed = new WorkspaceLinks(docs),
      linear = linearResolver(docs);
    expect(() => indexed.resolve(a, target)).toThrow('Ambiguous Wiki link file name');
    for (const [path, value] of [
      [a, target],
      [a, '#'],
      [b, '#^missing'],
    ])
      expect(outcome(indexed.resolve.bind(indexed), path!, value!)).toEqual(
        outcome(linear, path!, value!)
      );
  });

  it('keeps duplicate blocks, roots and hidden reference wrappers rejected', () => {
    const doc = document('root', 'Note.md');
    const metadata = doc.metadata;
    const child = metadata.rems['root-child']!;
    if (child.id === null) throw new Error('Fixture child must have native metadata');
    metadata.rems.duplicate = { ...structuredClone(child), id: 'duplicate' };
    metadata.rems.portal = { ...structuredClone(child), id: 'portal', block: 'portal' };
    metadata.rems.hidden = { ...structuredClone(child), id: 'hidden', block: 'hidden' };
    for (const key of ['portal', 'hidden']) {
      const entry = metadata.rems[key]!;
      if (entry.id === null) throw new Error('Fixture portal must have native metadata');
      const native = entry.native;
      native.type = RemType.PORTAL;
      native.isCardItem = false;
      native.isDocument = false;
      native.isFolder = false;
      native.children = key === 'portal' ? ['hidden'] : [];
      native.portal = { type: PORTAL_TYPE.PORTAL, directlyIncludedRemIds: [] };
    }
    const indexed = new WorkspaceLinks([doc]),
      linear = linearResolver([doc]);
    expect(indexed.render('hidden')).toBe('[hidden](remnote:hidden)');
    for (const target of [
      `#^${child.block}`,
      `#^${metadata.rems.root!.block}`,
      '#^hidden',
      '#^absent',
    ]) {
      expect(outcome(indexed.resolve.bind(indexed), doc.path, target)).toEqual(
        outcome(linear, doc.path, target)
      );
      expect(() => indexed.resolve(doc.path, target)).toThrow();
    }
  });

  it('rebuilds paths for a new operation after a rename and preserves duplicate-ID lookup semantics', () => {
    const doc = document('same', 'Before.md');
    const before = new WorkspaceLinks([doc]);
    const renamed = { ...doc, path: 'After.md' };
    const after = new WorkspaceLinks([renamed]);
    expect(before.resolve('Before.md', 'Before').path).toBe('Before.md');
    expect(after.resolve('After.md', 'After').path).toBe('After.md');
    expect(() => after.resolve('After.md', 'Before')).toThrow('Unknown');
    const docs = [doc, renamed];
    const indexed = new WorkspaceLinks(docs),
      linear = linearResolver(docs);
    expect(outcome(indexed.resolve.bind(indexed), doc.path, 'Before')).toEqual(
      outcome(linear, doc.path, 'Before')
    );
  });
});
