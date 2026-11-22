import { describe, expect, it } from 'vitest';
import { requiredTaskCapabilities } from '../../../src/business/operation-capabilities.js';
import { FlashcardsPlanSchema } from '../../../src/schemas/task-schemas.js';

const patch = {
  key: 'patch',
  cardRemId: 'card',
  remId: 'answer',
  expectedTextHash: 'a'.repeat(64),
  text: ['Same text'],
};

describe('task capability declarations', () => {
  it('distinguishes create, patch, reuse and mixed flashcard variants', () => {
    const create = FlashcardsPlanSchema.parse({
      schemaVersion: 1,
      dailyRemId: 'daily',
      homeRootId: 'home',
      tagRemId: 'tag',
      newCards: [{ key: 'card', question: 'Question?', answer: [['Answer']] }],
    });
    const patchOnly = FlashcardsPlanSchema.parse({ schemaVersion: 1, answerPatches: [patch] });
    const reuseOnly = FlashcardsPlanSchema.parse({
      schemaVersion: 1,
      reusedCardRemIds: ['card'],
    });
    const mixed = FlashcardsPlanSchema.parse({
      schemaVersion: 1,
      answerPatches: [patch],
      reusedCardRemIds: ['card'],
    });

    expect(create.kind).toBe('create');
    expect(patchOnly.kind).toBe('patch');
    expect(reuseOnly.kind).toBe('reuse');
    expect(mixed.kind).toBe('mixed');
    expect(requiredTaskCapabilities(create)).toContain('namespace:rem.createTreeWithMarkdown');
    expect(requiredTaskCapabilities(create)).toContain('namespace:rem.findMany');
    expect(requiredTaskCapabilities(patchOnly)).not.toContain(
      'namespace:rem.createTreeWithMarkdown'
    );
    expect(requiredTaskCapabilities(patchOnly)).not.toContain('namespace:rem.findMany');
    expect(requiredTaskCapabilities(reuseOnly)).not.toContain('rem:setText');
    expect(requiredTaskCapabilities(mixed)).toEqual(
      expect.arrayContaining(['namespace:rem.findOne', 'rem:getCards', 'rem:setText'])
    );
  });
});
