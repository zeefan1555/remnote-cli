import { describe, expect, it } from 'vitest';
import { hash } from '../../../src/business/workspace/types.js';
import {
  parseFrontmatter,
  renderFrontmatter,
  nativeDetailsSchema,
  nativeSchema,
  cardMetadataSchema,
  type WorkspaceMetadata,
  type DocumentAttributes,
} from '../../../src/business/workspace/metadata.js';

export const metadataFixture: WorkspaceMetadata = {
  schema: 'remnote-sync/1',
  root: 'root',
  title: 'Optional display title',
  aliases: ['Alias'],
  tags: ['learning'],
  rems: {
    root: {
      id: 'root',
      block: 'rn-726f6f74',
      content: 'text',
      native: {
        type: null,
        parent: null,
        children: [],
        isDocument: false,
        isFolder: false,
        isCardItem: false,
        practiceDirection: 'forward',
        enablePractice: true,
        tags: null,
        references: null,
        powerups: null,
        propertyValues: null,
        portal: null,
        cards: null,
        ...nativeDetailsSchema.parse({}),
        collected: [],
      },
      readOnly: {
        record: '.remnote/records/root.json',
        public: null,
        original: null,
      },
    },
    'new:question': { id: null, block: 'local-question', content: 'multiline' },
    'new:answer': { id: null, block: 'local-answer', content: 'text' },
  },
};
const attributes: DocumentAttributes = {
  title: 'Optional display title',
  aliases: ['Alias'],
  tags: ['learning'],
  rems: { 'local-question': { content: 'multiline' } },
};
const marker = '<!-- remnote:r-root -->\n\n';

describe('Obsidian workspace frontmatter', () => {
  it('roundtrips only optional user attributes and keeps native facts out of source', () => {
    const source = renderFrontmatter(attributes) + marker + '# Native title\n';
    const result = parseFrontmatter('Note.md', source);
    expect(result.diagnostics).toEqual([]);
    expect(result.attributes).toEqual(attributes);
    expect(result.metadata).toBeUndefined();
    expect(result.documentKey).toBe('r-root');
    expect(result.body).toBe('# Native title\n');
    expect(result.bodyLine).toBeGreaterThan(1);
  });

  it('treats quotes, comments and key ordering semantically', () => {
    const source =
      renderFrontmatter(attributes).replace(
        'title: Optional display title',
        'title: "Optional display title" # same title'
      ) + marker;
    expect(hash(parseFrontmatter('Note.md', source).attributes)).toBe(hash(attributes));
  });

  it('needs no YAML when no attributes were requested', () => {
    expect(renderFrontmatter()).toBe('');
    expect(parseFrontmatter('Note.md', marker + '# Title\n')).toMatchObject({
      attributes: {},
      diagnostics: [],
      documentKey: 'r-root',
    });
  });

  it('keeps PropertyType zero, typed cards and explicitly collected null values distinct from unknowns', () => {
    const native = metadataFixture.rems.root!;
    if (native.id === null) throw new Error('Expected existing Rem metadata');
    const value = nativeSchema.parse({
      ...native.native,
      propertyType: 0,
      isTodo: null,
      collected: ['propertyType', 'isTodo'],
      cards: [
        {
          id: 'card',
          remId: 'root',
          type: { clozeId: 'cloze' },
          createdAt: 1,
          repetitionHistory: [{ time: 2 }],
        },
      ],
      propertyValues: [{ propertyId: 'property', valueRemId: 'value', valueRichText: ['text'] }],
      powerups: [
        { code: 'powerup', slots: [{ slot: 'key', valueRemId: null, valueRichText: null }] },
      ],
    });
    expect(value.propertyType).toBe(0);
    expect(value.collected).toEqual(['propertyType', 'isTodo']);
    expect(value.cards![0]!.type).toEqual({ clozeId: 'cloze' });
    expect(value.cards![0]!.nextRepetitionTime).toBeNull();
    expect(nativeSchema.safeParse({ ...value, collected: ['inventedField'] }).success).toBe(false);
    expect(nativeSchema.safeParse({ ...value, propertyType: 1 }).success).toBe(false);
    expect(cardMetadataSchema.safeParse({ id: 'card', remId: 'root', type: 1 }).success).toBe(
      false
    );
    expect(nativeSchema.safeParse({ ...value, properties: [] }).success).toBe(false);
  });

  it.each([
    [
      'duplicate key',
      (s: string) => s.replace('title: Optional display title', 'title: first\ntitle: second'),
    ],
    [
      'unknown tag',
      (s: string) => s.replace('title: Optional display title', 'title: !unsafe title'),
    ],
    [
      'YAML alias',
      (s: string) => s.replace('aliases:', 'aliasSource: &a value\naliasCopy: *a\naliases:'),
    ],
    [
      'new native facts',
      (s: string) => s.replace('content: multiline', 'native: {}\n    content: multiline'),
    ],
    ['invalid block', (s: string) => s.replace('local-question:', 'local_question:')],
    [
      'unknown attribute',
      (s: string) => s.replace('content: multiline', 'content: multiline\n    tags: []'),
    ],
    ['unsupported content', (s: string) => s.replace('content: multiline', 'content: basic')],
    ['duplicate root', (s: string) => s + marker],
    ['missing root', (s: string) => s.replace(marker, '')],
    ['legacy metadata', (s: string) => s.replace('title:', 'schema: remnote-sync/1\ntitle:')],
  ])('rejects %s without interpreting it as write authorization', (_name, change) => {
    expect(
      parseFrontmatter('Note.md', change(renderFrontmatter(attributes) + marker)).diagnostics.length
    ).toBeGreaterThan(0);
  });
});
