import { beforeEach, describe, expect, it } from 'vitest';
import {
  documentMetadata,
  normalizeRichText,
  parseDocument as parseBoundDocument,
  renderDocument as renderNativeDocument,
  renderParsedDocument,
} from '../../../src/business/workspace/markdown.js';
import {
  parseFrontmatter,
  renderFrontmatter,
  type WorkspaceMetadata,
} from '../../../src/business/workspace/metadata.js';
import { nativeBlockId } from '../../../src/business/workspace/identity.js';
import { WorkspaceLinks } from '../../../src/business/workspace/links.js';
import type { WorkspaceRem } from '../../../src/business/workspace/types.js';

// The standalone codec receives the same authoritative fixture bindings that inspectLocal hydrates.
const bindings = new Map<string, WorkspaceMetadata>();
beforeEach(() => bindings.clear());
function renderDocument(...args: Parameters<typeof renderNativeDocument>): string {
  for (const [id, path] of args[3])
    bindings.set(path, documentMetadata(id, args[2], args[3], args[4]));
  return renderNativeDocument(...args);
}
function parseDocument(path: string, source: string, links?: WorkspaceLinks) {
  return parseBoundDocument(path, source, bindings.get(path)!, links);
}

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
    { label: 'ordinary text', text: ['example'] },
    { label: 'one trailing space', text: ['example '] },
    { label: 'multiple trailing spaces', text: ['example  '] },
    { label: 'trailing tab', text: ['example\t'] },
    { label: 'mixed trailing whitespace', text: ['example \t '] },
    { label: 'segmented trailing whitespace', text: ['example', '', ' ', '\t'] },
    { label: 'whitespace-only text', text: [' \t '] },
    { label: 'terminal LF', text: ['example\n'] },
    { label: 'terminal CRLF', text: ['example\r\n'] },
    { label: 'terminal LF and empty segment', text: ['example\n', ''] },
    { label: 'space before terminal LF', text: ['example \n'] },
    { label: 'literal anchor-like text', text: ['example ^literal '] },
    { label: 'strong trailing space', text: [{ i: 'm', text: 'example ', b: true }] },
    { label: 'emphasis trailing tab', text: [{ i: 'm', text: 'example\t', l: true }] },
    { label: 'inline-code trailing space', text: [{ i: 'm', text: 'example ', q: true }] },
    { label: 'strong trailing LF', text: [{ i: 'm', text: 'example\n', b: true }] },
    {
      label: 'rich-text adjacency',
      text: [
        'Before ',
        { i: 'm', text: 'bold', b: true },
        { i: 'm', text: ' italic', l: true },
        '\t',
      ],
    },
    { label: 'strong followed by terminal LF', text: [{ i: 'm', text: 'bold', b: true }, '\n'] },
    { label: 'reference followed by terminal LF', text: [{ i: 'q', _id: 'question' }, '\n'] },
  ])('keeps block-anchor syntax and exact semantics for $label', ({ text }) => {
    const byId = new Map([
      ['root', rem('root', ['Root'], { parent: null, children: ['question', 'ordinary'] })],
      ['question', rem('question', ['Question'], { type: 1, backText: [], children: ['answer'] })],
      ['answer', rem('answer', text, { parent: 'question', type: 2, cardItem: true })],
      ['ordinary', rem('ordinary', text, { children: ['child'] })],
      ['child', rem('child', ['Child'], { parent: 'ordinary' })],
    ]);
    const before = structuredClone(byId),
      blocks = new Map([...byId.keys()].map((id) => [id, `custom-${id}`])),
      source = renderDocument('root', 'Root.md', byId, new Map([['root', 'Root.md']]), { blocks }),
      parsed = parseDocument('Root.md', source);
    expect(parsed.diagnostics).toEqual([]);
    expect(byId).toEqual(before);
    expect(parsed.document.nodes.map(({ key }) => key)).toEqual([...byId.keys()]);
    for (const node of parsed.document.nodes) {
      const native = byId.get(node.key)!;
      expect(node.blockId).toBe(blocks.get(node.key));
      expect(node.parent).toBe(native.parent);
      expect(node.children).toEqual(native.children);
      expect(normalizeRichText(node.text)).toEqual(normalizeRichText(native.text));
      expect(normalizeRichText(node.backText)).toEqual(normalizeRichText(native.backText ?? []));
      expect(node.kind).toBe(node.key === 'question' ? 'multiline' : 'text');
      const binding = parsed.document.metadata?.rems[node.key];
      if (!binding || binding.id === null) throw new Error('Missing native binding');
      expect(binding.id).toBe(native.id);
      expect(binding.native).toMatchObject({
        type: native.type,
        isCardItem: native.cardItem,
      });
    }
    // The delimiter is Markdown syntax: an entity decoding to a space is not sufficient.
    expect(source).toContain(' ^custom-answer\n');
    expect(source).toContain(' ^custom-ordinary\n');
  });

  it('retains the same native facts and opaque/rich-text outline without a YAML roundtrip', () => {
    const byId = codecFixture();
    const paths = new Map([['root', 'Note.md']]);
    const ordinary = parseDocument('Note.md', renderDocument('root', 'Note.md', byId, paths));
    const direct = renderParsedDocument('root', 'Note.md', byId, paths);
    expect(direct.diagnostics).toEqual([]);
    expect(direct.document.metadata).toEqual(ordinary.document.metadata);
    const withoutLines = (nodes: typeof direct.document.nodes) =>
      nodes.map(({ line: _line, ...node }) => node);
    expect(withoutLines(direct.document.nodes)).toEqual(withoutLines(ordinary.document.nodes));
    expect(direct.document.references.map(({ id }) => id)).toEqual(
      ordinary.document.references.map(({ id }) => id)
    );
  });

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

  it('uses hidden identity, native H1, short blocks and ordinary Markdown without default YAML or card markers', () => {
    const source = renderDocument(
      'root',
      'Folder/Note.md',
      codecFixture(),
      new Map([['root', 'Folder/Note.md']])
    );
    expect(source).toContain(`<!-- remnote:${nativeBlockId('root')} -->`);
    expect(source).not.toContain('schema:');
    expect(source).not.toContain('Question? ===');
    expect(source).not.toContain('Front >>');
    expect(source).toContain('> Back');
    expect(source).toContain(`[[Folder/Note#^${nativeBlockId('a')}|`);
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
    const header = parseFrontmatter('Note.md', source);
    const parsed = parseDocument(
      'Note.md',
      renderFrontmatter({ rems: { 'local-q': { content: 'multiline' } } }) +
        `<!-- remnote:${header.documentKey} -->\n\n` +
        '# Different native title\n\n- Question === >> ^local-q\n  - Answer ^local-a\n'
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.document.nodes[0]?.text).toEqual(['Different native title']);
    expect(parsed.document.nodes[1]).toMatchObject({
      kind: 'multiline',
      text: ['Question === >>'],
    });
  });

  it('rejects new embeds and unsupported quote shapes and recognizes explicit new anchors', () => {
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
        source.replace(
          `Answer ^${nativeBlockId('a')}`,
          `Answer ^${nativeBlockId('a')}\n\n    > ordinary quote`
        )
      ).diagnostics.length
    ).toBeGreaterThan(0);
    const changed = parseDocument('Note.md', source.replace(`^${nativeBlockId('a')}`, '^missing'));
    expect(changed.document.nodes.some((node) => node.key.startsWith('new:'))).toBe(true);
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
    const metadata = bindings.get('Root.md')!;
    for (const text of ['[[|empty]]', '**[[Root]]**', '[[unclosed', '![[Root|*embed*]]']) {
      const invalid = parseDocument(
        'Root.md',
        `<!-- remnote:${metadata.rems.root!.block} -->\n\n# Root\n\n- ${text} ^${metadata.rems.child!.block}\n`
      );
      expect(invalid.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it('resolves exact vault paths and unique headings but refuses ambiguous short names and unknown blocks', () => {
    const metadata = documentMetadata('root', codecFixture(), new Map([['root', 'One/Note.md']]));
    const other = structuredClone(metadata);
    other.root = 'other';
    other.rems = {
      other: { ...structuredClone(other.rems.root!), id: 'other', block: 'rn-other' },
    };
    const links = new WorkspaceLinks([
      { path: 'One/Note.md', title: 'Note', metadata },
      { path: 'Two/Note.md', title: 'Other', metadata: other },
    ]);
    expect(links.resolve('One/Note.md', `#^${nativeBlockId('a')}`).id).toBe('a');
    expect(links.resolve('One/Note.md', 'Two/Note#Other').id).toBe('other');
    expect(() => links.resolve('One/Note.md', 'Note')).toThrow('Ambiguous');
    expect(() => links.resolve('One/Note.md', '#^absent')).toThrow('Unknown');
    expect(() => links.resolve('One/Note.md', `#^${nativeBlockId('root')}`)).toThrow(
      'no visible block'
    );
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
    expect(source).toContain('关联引用〔只读〕');
    expect(source).not.toContain('Portal directly');
    expect(source).toContain(`[[Note#^${nativeBlockId('a')}|`);
    expect(source).not.toContain('![[Note');
    const parsed = parseDocument('Note.md', source);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.document.nodes.find((node) => node.key === 'image')!.kind).toBe('opaque');
  });
});
