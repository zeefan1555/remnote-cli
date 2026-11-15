import { describe, expect, it } from 'vitest';
import { hash } from '../../../src/business/workspace/types.js';
import {
  parseFrontmatter,
  renderFrontmatter,
  nativeDetailsSchema,
  nativeSchema,
  cardMetadataSchema,
  type WorkspaceMetadata,
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

describe('Obsidian workspace frontmatter', () => {
  it('roundtrips a source-mode YAML schema with native and local-only facts separated', () => {
    const source = renderFrontmatter(metadataFixture) + '# Native title\n';
    const result = parseFrontmatter('Note.md', source);
    expect(result.diagnostics).toEqual([]);
    expect(result.metadata).toEqual(metadataFixture);
    expect(result.body).toBe('# Native title\n');
    expect(result.bodyLine).toBeGreaterThan(1);
  });

  it('treats quotes, comments and key ordering semantically', () => {
    const source = renderFrontmatter(metadataFixture).replace(
      'schema: remnote-sync/1',
      'schema: "remnote-sync/1" # same schema'
    );
    expect(hash(parseFrontmatter('Note.md', source).metadata)).toBe(hash(metadataFixture));
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
    ['duplicate key', (s: string) => s.replace('root: root', 'root: root\nroot: other')],
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
      (s: string) => s.replace('block: local-answer', 'native: {}\n    block: local-answer'),
    ],
    ['invalid block', (s: string) => s.replace('block: local-answer', 'block: local_answer')],
    ['duplicate block', (s: string) => s.replace('block: local-answer', 'block: local-question')],
    ['unbound root', (s: string) => s.replace('root: root', 'root: absent')],
  ])('rejects %s without interpreting it as write authorization', (_name, change) => {
    expect(
      parseFrontmatter('Note.md', change(renderFrontmatter(metadataFixture))).diagnostics.length
    ).toBeGreaterThan(0);
  });
});
