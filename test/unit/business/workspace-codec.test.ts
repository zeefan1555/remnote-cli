import { describe, expect, it } from 'vitest';
import {
  documentMetadata,
  normalizeRichText,
  parseDocument,
  renderDocument,
} from '../../../src/business/workspace/markdown.js';
import { parseFrontmatter, renderFrontmatter } from '../../../src/business/workspace/metadata.js';
import { WorkspaceLinks } from '../../../src/business/workspace/links.js';
import type { WorkspaceRem } from '../../../src/business/workspace/types.js';

function rem(id: string, text: unknown, extra: Partial<WorkspaceRem> = {}): WorkspaceRem {
  return {
    id,
    text,
    type: null,
    parent: 'root',
    children: [],
    backText: null,
    document: false,
    folder: false,
    cardItem: false,
    practice: 'forward',
    enablePractice: true,
    ...extra,
  };
}

export function codecFixture() {
  return new Map<string, WorkspaceRem>([
    [
      'root',
      rem('root', ['Note'], {
        parent: null,
        children: ['q', 'basic', 'literal', 'code', 'ref', 'portal'],
      }),
    ],
    ['q', rem('q', ['Question?'], { backText: [], children: ['a'] })],
    ['a', rem('a', ['Answer'], { parent: 'q', cardItem: true })],
    ['basic', rem('basic', ['Front'], { backText: ['Back'] })],
    [
      'literal',
      rem('literal', [
        'literal === and >> plus [[not a link]] ',
        { i: 'm', text: '[[code]]', q: true },
        ' ',
        { i: 'm', text: 'bold', b: true },
        ' ',
        { i: 'm', text: 'italic', l: true },
      ]),
    ],
    [
      'code',
      rem('code', [
        { i: 'm', code: true, language: 'js', text: 'const x = "[[literal]]";\n// === >>' },
      ]),
    ],
    ['ref', rem('ref', [{ i: 'q', _id: 'a' }])],
    [
      'portal',
      rem('portal', [], { type: 6, portal: { type: 'portal', directlyIncludedRemIds: ['a'] } }),
    ],
  ]);
}

describe('Obsidian Rem codec', () => {
  it.each([
    ['plain LF', ['a\nb']],
    ['plain CRLF', ['a\r\nb']],
    ['bold LF', [{ i: 'm', text: 'a\nb', b: true }]],
    ['bold CRLF', [{ i: 'm', text: 'a\r\nb', b: true }]],
  ])('round-trips %s softbreaks without adding outline indentation', (_label, text) => {
    const byId = new Map([
      ['root', rem('root', ['Root'], { parent: null, children: ['child'] })],
      ['child', rem('child', text)],
    ]);
    const parsed = parseDocument(
      'Root.md',
      renderDocument('root', 'Root.md', byId, new Map([['root', 'Root.md']]))
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(
      normalizeRichText(parsed.document.nodes.find((node) => node.key === 'child')!.text)
    ).toEqual(normalizeRichText(text));
  });

  it.each(['a\nb', 'a\r\nb'])(
    'round-trips basic answer softbreaks %j without quote markers',
    (answer) => {
      const byId = new Map([
        ['root', rem('root', ['Root'], { parent: null, children: ['child'] })],
        ['child', rem('child', ['Question'], { backText: [answer] })],
      ]);
      const parsed = parseDocument(
        'Root.md',
        renderDocument('root', 'Root.md', byId, new Map([['root', 'Root.md']]))
      );
      expect(parsed.diagnostics).toEqual([]);
      expect(
        normalizeRichText(parsed.document.nodes.find((node) => node.key === 'child')!.backText)
      ).toEqual(normalizeRichText([answer]));
    }
  );

  it('round-trips an editable basic card used as a document root', () => {
    const byId = new Map([
      ['root', rem('root', ['Question'], { parent: null, backText: ['Answer'] })],
    ]);
    const parsed = parseDocument(
      'Question.md',
      renderDocument('root', 'Question.md', byId, new Map([['root', 'Question.md']]))
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.document.nodes).toMatchObject([
      { key: 'root', kind: 'basic', text: ['Question'], backText: ['Answer'] },
    ]);
  });

  it.each(['title *italic*', 'title `code`', 'title **bold**', 'title <tag>'])(
    'parses a wiki label containing Markdown as one reference: %s',
    (label) => {
      const byId = new Map([
        ['a', rem('a', ['A'], { parent: null, children: ['child', 'b'] })],
        ['b', rem('b', [label], { parent: 'a', document: true })],
        ['child', rem('child', [{ i: 'q', _id: 'b' }], { parent: 'a' })],
      ]);
      const paths = new Map([
        ['a', 'A.md'],
        ['b', 'B.md'],
      ]);
      const links = new WorkspaceLinks(
        [...paths].map(([id, path]) => ({
          path,
          title: id === 'a' ? 'A' : label,
          metadata: documentMetadata(id, byId, paths),
        }))
      );
      const parsed = parseDocument(
        'A.md',
        renderDocument('a', 'A.md', byId, paths, { links }),
        links
      );
      expect(parsed.diagnostics).toEqual([]);
      expect(parsed.document.nodes.find((node) => node.key === 'child')!.text).toEqual([
        { i: 'q', _id: 'b' },
      ]);
      expect(parsed.document.nodes.find((node) => node.key === 'b')!.kind).toBe('mount');
    }
  );

  it('uses YAML kinds, native H1, stable blocks and ordinary Markdown without HTML or card markers', () => {
    const source = renderDocument(
      'root',
      'Folder/Note.md',
      codecFixture(),
      new Map([['root', 'Folder/Note.md']])
    );
    expect(source).not.toContain('<!--');
    expect(source).not.toContain('Question? ===');
    expect(source).not.toContain('Front >>');
    expect(source).toContain('> Back');
    expect(source).toContain('[[Folder/Note#^rn-61|');
    const parsed = parseDocument('Folder/Note.md', source);
    expect(parsed.diagnostics).toEqual([]);
    const nodes = new Map(parsed.document.nodes.map((node) => [node.key, node]));
    expect(nodes.get('q')).toMatchObject({ kind: 'multiline', children: ['a'] });
    expect(nodes.get('basic')).toMatchObject({
      kind: 'basic',
      text: ['Front'],
      backText: ['Back'],
    });
    expect(nodes.get('ref')?.text).toEqual([{ i: 'q', _id: 'a' }]);
    expect(nodes.get('literal')?.text).toEqual(codecFixture().get('literal')?.text);
    expect(nodes.get('code')?.text).toEqual(codecFixture().get('code')?.text);
    expect(nodes.get('portal')?.kind).toBe('opaque');
  });

  it('supports new local keys and does not infer card types from === or >>', () => {
    const source = renderDocument(
      'root',
      'Note.md',
      new Map([['root', rem('root', ['Note'], { parent: null })]]),
      new Map([['root', 'Note.md']])
    );
    const meta = parseFrontmatter('Note.md', source).metadata!;
    meta.rems['new:q'] = { id: null, block: 'local-q', content: 'multiline' };
    meta.rems['new:a'] = { id: null, block: 'local-a', content: 'text' };
    const parsed = parseDocument(
      'Note.md',
      renderFrontmatter(meta) +
        '# Different native title\n\n- Question === >> ^local-q\n  - Answer ^local-a\n'
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.document.nodes[0]?.text).toEqual(['Different native title']);
    expect(parsed.document.nodes[1]).toMatchObject({
      kind: 'multiline',
      text: ['Question === >>'],
    });
  });

  it('rejects new embeds, unsupported quote shapes and missing YAML/block counterparts', () => {
    const source = renderDocument(
      'root',
      'Note.md',
      codecFixture(),
      new Map([['root', 'Note.md']])
    );
    expect(
      parseDocument('Note.md', source.replace('Question? ^', '![[Note]] ^')).diagnostics.some(
        (d) => d.code === 'UNSUPPORTED_EMBED'
      )
    ).toBe(true);
    expect(
      parseDocument(
        'Note.md',
        source.replace('Answer ^rn-61', 'Answer ^rn-61\n\n    > ordinary quote')
      ).diagnostics.length
    ).toBeGreaterThan(0);
    expect(
      parseDocument('Note.md', source.replace('^rn-61', '^missing')).diagnostics.length
    ).toBeGreaterThan(0);
  });

  it('keeps escaped Wiki-looking literals and code literal while rejecting malformed or formatted links', () => {
    const byId = new Map([
      ['root', rem('root', ['Root'], { parent: null, children: ['child'] })],
      [
        'child',
        rem('child', [
          '[[Root|literal *label*]] ![[Root]] ',
          { i: 'm', text: '[[Root|`code`]]', q: true },
        ]),
      ],
    ]);
    const source = renderDocument('root', 'Root.md', byId, new Map([['root', 'Root.md']]));
    const parsed = parseDocument('Root.md', source);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.document.nodes.find((node) => node.key === 'child')!.text).toEqual(
      byId.get('child')!.text
    );
    const metadata = parseFrontmatter('Root.md', source).metadata!;
    for (const text of ['[[|empty]]', '**[[Root]]**', '[[unclosed', '![[Root|*embed*]]']) {
      const invalid = parseDocument(
        'Root.md',
        renderFrontmatter(metadata) + `# Root\n\n- ${text} ^${metadata.rems.child!.block}\n`
      );
      expect(invalid.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it('resolves exact vault paths and unique headings but refuses ambiguous short names and unknown blocks', () => {
    const source = renderDocument(
      'root',
      'One/Note.md',
      codecFixture(),
      new Map([['root', 'One/Note.md']])
    );
    const metadata = parseFrontmatter('One/Note.md', source).metadata!;
    const other = structuredClone(metadata);
    other.root = 'other';
    other.rems = {
      other: { ...structuredClone(other.rems.root!), id: 'other', block: 'rn-other' },
    };
    const links = new WorkspaceLinks([
      { path: 'One/Note.md', title: 'Note', metadata },
      { path: 'Two/Note.md', title: 'Other', metadata: other },
    ]);
    expect(links.resolve('One/Note.md', '#^rn-61').id).toBe('a');
    expect(links.resolve('One/Note.md', 'Two/Note#Other').id).toBe('other');
    expect(() => links.resolve('One/Note.md', 'Note')).toThrow('Ambiguous');
    expect(() => links.resolve('One/Note.md', '#^absent')).toThrow('Unknown');
  });
  it('projects unsupported media and portals readably without inventing Obsidian embeds or writable media', () => {
    const rems = codecFixture();
    rems.get('root')!.children.push('image');
    rems.set(
      'image',
      rem('image', [{ i: 'i', url: 'https://example.com/image.png', title: 'Native image' }])
    );
    const source = renderDocument('root', 'Note.md', rems, new Map([['root', 'Note.md']]));
    expect(source).toContain('![Native image](https://example.com/image.png)');
    expect(source).toContain('Portal directly included targets');
    expect(source).toContain('[[Note#^rn-61|');
    expect(source).not.toContain('![[Note');
    const parsed = parseDocument('Note.md', source);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.document.nodes.find((node) => node.key === 'image')!.kind).toBe('opaque');
  });
});
