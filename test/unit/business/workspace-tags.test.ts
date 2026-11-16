import { describe, expect, it } from 'vitest';
import {
  documentMetadata,
  parseDocument,
  renderDocument,
} from '../../../src/business/workspace/markdown.js';
import { registerTags, resolveTags, tagIdsSchema } from '../../../src/business/workspace/tags.js';
import type { WorkspaceRem } from '../../../src/business/workspace/types.js';

const rem = (
  id: string,
  text: string,
  parent: string | null,
  children: string[] = [],
  tags: string[] = []
): WorkspaceRem => ({
  id,
  text: [text],
  parent,
  children,
  tags,
  type: null,
  backText: null,
  document: parent === null,
  folder: false,
  cardItem: false,
  practice: 'forward',
  enablePractice: true,
});
function fixture() {
  const rems = new Map([
    ['home', rem('home', 'HOME', null, ['term'])],
    ['term', rem('term', '事务', 'home')],
    ['day', rem('day', 'Today', null, ['a', 'b'], ['home'])],
    ['a', rem('a', 'Literal #HOME/事务', 'day', [], ['term'])],
    ['b', rem('b', 'Other', 'day')],
  ]);
  return {
    rems,
    paths: new Map([
      ['home', 'HOME.md'],
      ['day', 'Today.md'],
    ]),
    tagIds: registerTags(rems),
  };
}

describe('standard Obsidian direct tags', () => {
  it('renders root YAML tags and per-Rem inline tags without promoting child tags', () => {
    const f = fixture(),
      options = { tagIds: f.tagIds };
    const source = renderDocument('day', 'Today.md', f.rems, f.paths, options);
    expect(source).toContain('tags:\n  - HOME');
    expect(source).toContain('Literal \\#HOME/事务 #HOME/事务');
    const parsed = parseDocument(
      'Today.md',
      source,
      documentMetadata('day', f.rems, f.paths, options),
      undefined,
      f.tagIds
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.document.nodes.map((n) => [n.key, n.tags])).toEqual([
      ['day', ['home']],
      ['a', ['term']],
      ['b', []],
    ]);
    expect(parsed.document.nodes[1]!.text).toEqual(['Literal #HOME/事务']);
  });
  it('rejects unknown, case-folded collisions and ambiguous native paths', () => {
    expect(() => resolveTags(['unknown'], {})).toThrow('Unknown tag');
    expect(() => tagIdsSchema.parse({ HOME: 'a', home: 'b' })).toThrow();
    const f = fixture();
    f.rems.set('second', rem('second', '事务', 'home'));
    f.rems.get('b')!.tags = ['second'];
    expect(() => registerTags(f.rems)).toThrow('collide');
  });
  it('binds unused tags only by their complete ancestor path, never a shared basename', () => {
    const rems = new Map([
      ['home', rem('home', 'HOME', null, ['a'])],
      ['term', rem('term', 'Term', null, ['b'])],
      ['a', rem('a', 'Same', 'home')],
      ['b', rem('b', 'Same', 'term')],
    ]);
    expect(resolveTags(['HOME/Same', 'Term/Same'], {}, rems)).toEqual(['a', 'b']);
    expect(() => resolveTags(['Same'], {}, rems)).toThrow('Unknown tag');
  });
  it('does not interpret escapes, inline code, numeric hashes or URL fragments as native tags', () => {
    const f = fixture(),
      options = { tagIds: f.tagIds };
    f.rems.get('a')!.text = [
      'Escaped #HOME/事务 code ',
      { i: 'm', text: '#unknown', q: true },
      ' issue #123 https://example.com/#unknown',
    ];
    const source = renderDocument('day', 'Today.md', f.rems, f.paths, options).replace(
      'issue \\#123',
      'issue #123'
    );
    const parsed = parseDocument(
      'Today.md',
      source,
      documentMetadata('day', f.rems, f.paths, options),
      undefined,
      f.tagIds
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.document.nodes[1]!.tags).toEqual(['term']);
    expect(parsed.document.nodes[1]!.text).toEqual(f.rems.get('a')!.text);
  });
});
