import { describe, expect, it } from 'vitest';
import { requiredTaskCapabilities } from '../../../src/business/operation-capabilities.js';
import { FlashcardsPlanSchema, WikiPlanSchema } from '../../../src/schemas/task-schemas.js';

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
    expect(requiredTaskCapabilities('flashcards', create)).toContain(
      'namespace:rem.createTreeWithMarkdown'
    );
    expect(requiredTaskCapabilities('flashcards', patchOnly)).not.toContain(
      'namespace:rem.createTreeWithMarkdown'
    );
    expect(requiredTaskCapabilities('flashcards', reuseOnly)).not.toContain('rem:setText');
    expect(requiredTaskCapabilities('flashcards', mixed)).toEqual(
      expect.arrayContaining(['namespace:rem.findOne', 'rem:getCards', 'rem:setText'])
    );
  });

  it('requires Wiki creation capabilities only when pages are present', () => {
    const base = {
      schemaVersion: 1 as const,
      wikiRootId: 'wiki',
      partitionRemId: 'partition',
      indexRemId: 'index',
      logRemId: 'log',
    };
    const pages = WikiPlanSchema.parse({
      ...base,
      pages: [{ key: 'page', title: 'Page', nodes: [], summary: ['Summary'] }],
    });
    const patchOnly = WikiPlanSchema.parse({ ...base, pages: [], answerPatches: [patch] });
    expect(requiredTaskCapabilities('wiki', pages)).toContain('namespace:rem.createRem');
    expect(requiredTaskCapabilities('wiki', patchOnly)).not.toContain('namespace:rem.createRem');
    expect(requiredTaskCapabilities('wiki', patchOnly)).toContain('rem:setText');
  });
});
