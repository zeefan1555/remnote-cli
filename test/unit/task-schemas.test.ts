import { describe, it, expect } from 'vitest';
import { FlashcardsApplySchema, FlashcardsPlanSchema } from '../../src/schemas/task-schemas.js';
const hash = 'a'.repeat(64);
const card = { key: 'c', question: 'Question?', answer: [['Answer', { remId: 'source' }]] };
const flash = {
  schemaVersion: 1,
  dailyRemId: 'day',
  homeRootId: 'home',
  tagRemId: 'tag',
  newCards: [card],
};
const patch = {
  key: 'patch',
  cardRemId: 'card',
  remId: 'answer',
  expectedTextHash: hash,
  text: ['New'],
};
describe('task plan contract', () => {
  it('defaults to preview and permits only reviewed envelope fields', () => {
    expect(
      FlashcardsApplySchema.parse({ schemaVersion: 1, plan: flash, idempotencyKey: 'batch' }).dryRun
    ).toBe(true);
    expect(
      FlashcardsApplySchema.safeParse({
        schemaVersion: 1,
        plan: flash,
        idempotencyKey: 'batch',
        deleteAll: true,
      }).success
    ).toBe(false);
  });
  it('accepts patch-only and reuse-only cards without creation context', () => {
    const patchOnly = { schemaVersion: 1 as const, answerPatches: [patch] };
    const reuseOnly = { schemaVersion: 1 as const, reusedCardRemIds: ['card'] };
    expect(FlashcardsPlanSchema.parse(patchOnly)).toEqual({ ...patchOnly, kind: 'patch' });
    expect(FlashcardsPlanSchema.parse(reuseOnly)).toEqual({ ...reuseOnly, kind: 'reuse' });
  });
  it('rejects creation context without new cards and daily creation without a daily ID', () => {
    expect(
      FlashcardsPlanSchema.safeParse({ ...flash, newCards: [], answerPatches: [patch] }).success
    ).toBe(false);
    expect(FlashcardsPlanSchema.safeParse({ ...flash, dailyRemId: undefined }).success).toBe(false);
    expect(
      FlashcardsPlanSchema.safeParse({ ...flash, dailyRemId: undefined, tags: {} }).success
    ).toBe(false);
  });
  it.each([
    { newCards: [] },
    { newCards: [card, { ...card, key: 'c2' }] },
    { newCards: [{ ...card, question: ' ' }] },
    { newCards: [{ ...card, question: '[[能力圈]] 和长远怎么取舍？' }] },
    { newCards: [{ ...card, question: 'x ]]' }] },
    { newCards: [{ ...card, question: [] }] },
    { newCards: [{ ...card, question: [' '] }] },
    { newCards: [{ ...card, question: ['x'.repeat(1001)] }] },
    { newCards: [{ ...card, question: [{ pageKey: 'p' }] }] },
    { newCards: [{ ...card, answer: [] }] },
    { newCards: [{ ...card, answer: [[]] }] },
    { newCards: [{ ...card, answer: [[{ pageKey: 'p' }]] }] },
    { newCards: [{ ...card, answer: [[{ remId: 'r', extra: true }]] }] },
    { newCards: [{ ...card, answer: [[{ code: '' }]] }] },
    { newCards: [{ ...card, answer: [[{ code: 'x', language: 'bad language' }]] }] },
    { newCards: [{ ...card, answer: [[{ code: 'x', remId: 'r' }]] }] },
    { newCards: [{ ...card, answer: [['prefix', { code: 'body' }]] }] },
    { newCards: [{ ...card, question: [{ code: 'not a question' }] }] },
    { newCards: [{ ...card, answer: [['x'.repeat(10001)]] }] },
    { dailyRemId: ' ' },
    { tagRemId: 'x'.repeat(257) },
    { answerPatches: [{ ...patch, key: 'c' }] },
    { answerPatches: [{ ...patch, expectedTextHash: 'A'.repeat(64) }] },
    { answerPatches: Array(101).fill(patch) },
    { today: true },
    { cardCluster: 'yes' },
    { cardCluster: true },
    { title: 'Topic', cardCluster: true },
    { cardCluster: true, newCards: [card, { ...card, key: 'c2' }] },
    { parentRemId: '' },
    { parentRemId: 'topic', title: 'Topic' },
    { parentRemId: 'topic', newCards: undefined, reusedCardRemIds: ['r'] },
    { parentRemId: 'topic', cardCluster: true, newCards: [card, { ...card, key: 'c2' }] },
  ])('rejects unsafe flashcard input %#', (v) =>
    expect(FlashcardsPlanSchema.safeParse({ ...flash, ...v }).success).toBe(false)
  );
  it('accepts a TextSegment question and names the fix for literal brackets', () => {
    expect(
      FlashcardsPlanSchema.safeParse({
        ...flash,
        newCards: [{ ...card, question: ['Compare ', { remId: 'pe' }, '?'] }],
      }).success
    ).toBe(true);
    const bad = FlashcardsPlanSchema.safeParse({
      ...flash,
      newCards: [{ ...card, question: '[[能力圈]]' }],
    });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain('{\\"remId\\"');
  });
  it('accepts parentRemId for several new cards without a title', () => {
    const two = { ...flash, parentRemId: 'topic', newCards: [card, { ...card, key: 'c2' }] };
    expect(FlashcardsPlanSchema.parse(two)).toMatchObject({ kind: 'create', ...two });
    const { parentRemId: _omitted, ...untitled } = two;
    expect(FlashcardsPlanSchema.safeParse(untitled).success).toBe(false);
  });
  it('accepts an explicit Card Cluster opt-in and treats omit or false as off', () => {
    const two = {
      ...flash,
      title: 'Topic',
      newCards: [card, { ...card, key: 'c2' }],
    };
    expect(FlashcardsPlanSchema.parse(two)).toMatchObject({ kind: 'create', ...two });
    expect(FlashcardsPlanSchema.parse({ ...two, cardCluster: false }).cardCluster).toBe(false);
    expect(FlashcardsPlanSchema.parse({ ...two, cardCluster: true }).cardCluster).toBe(true);
    expect(FlashcardsPlanSchema.parse(flash)).not.toHaveProperty('cardCluster');
    const coded = {
      ...flash,
      newCards: [
        {
          key: 'code',
          question: 'Show it',
          answer: [[{ code: 'alpha\nbeta' }], [{ code: 'print(1)', language: 'python' }]],
        },
      ],
    };
    expect(FlashcardsPlanSchema.parse(coded)).toMatchObject({ kind: 'create', ...coded });
  });
  it('supports guarded patches/reuse and exact existing nodes', () => {
    expect(
      FlashcardsPlanSchema.safeParse({ schemaVersion: 1, answerPatches: [patch] }).success
    ).toBe(true);
    expect(
      FlashcardsPlanSchema.safeParse({ schemaVersion: 1, reusedCardRemIds: ['r'] }).success
    ).toBe(true);
  });
  it('accepts plans beyond the former UTF8 size bound and still bounds the idempotency key', () => {
    expect(
      FlashcardsPlanSchema.safeParse({
        ...flash,
        newCards: [{ ...card, answer: [Array(10).fill('é'.repeat(6000))] }],
      }).success
    ).toBe(true);
    for (const k of ['', 'bad key', 'x'.repeat(129)])
      expect(
        FlashcardsApplySchema.safeParse({ schemaVersion: 1, plan: flash, idempotencyKey: k })
          .success
      ).toBe(false);
  });
  it('accepts flashcard plans beyond the former card, answer, patch and receipt bounds', () => {
    const newCards = Array.from({ length: 8 }, (_, i) => ({
      ...card,
      key: `c${i}`,
      answer: Array.from({ length: 101 }, () => ['x']),
    }));
    const patches = Array.from({ length: 101 }, (_, i) => ({ ...patch, key: `patch${i}` }));
    const p = {
      ...flash,
      title: 'Cluster',
      newCards,
      reusedCardRemIds: Array(100).fill('r'),
      answerPatches: patches,
    };
    expect(FlashcardsPlanSchema.safeParse(p).success).toBe(true);
  });
  it('accepts explicit tags instead of homeRootId/tagRemId and enforces their keys', () => {
    const base = { schemaVersion: 1, dailyRemId: 'day', newCards: [card] };
    const ok = (p: unknown) => FlashcardsPlanSchema.safeParse(p).success;
    expect(ok({ ...base, tags: { root: ['t'], 'card:c': ['t'] } })).toBe(true);
    expect(ok({ ...base, tags: {} })).toBe(true);
    expect(ok({ ...base, parentRemId: 'topic', tags: { 'card:c': ['t'] } })).toBe(true);
    expect(ok(base)).toBe(false);
    expect(ok({ ...base, tagRemId: 'tag', tags: {} })).toBe(false);
    expect(ok({ ...base, homeRootId: 'home', tags: {} })).toBe(false);
    expect(ok({ ...base, tags: { 'answer:c:0': ['t'] } })).toBe(false);
    expect(ok({ ...base, tags: { 'card:x': ['t'] } })).toBe(false);
    expect(ok({ ...base, tags: { 'card:c': ['t', 't'] } })).toBe(false);
    expect(ok({ ...base, tags: { 'card:c': [''] } })).toBe(false);
    expect(ok({ ...base, parentRemId: 'topic', tags: { root: [] } })).toBe(false);
    expect(ok({ ...base, tags: { root: [], 'card:c': ['t'] } })).toBe(false);
    expect(ok(flash)).toBe(true);
  });
});
