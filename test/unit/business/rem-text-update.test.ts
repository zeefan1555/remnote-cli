import { beforeEach, describe, expect, it, vi } from 'vitest';
import { contentHash } from '../../../src/business/content-hash.js';
import { RemAdapter } from '../../../src/business/rem-adapter.js';
import { MockCard, MockRem, MockRemNotePlugin } from '../../helpers/business-mocks.js';

describe('safe Rem own-text updates', () => {
  let plugin: MockRemNotePlugin;
  let adapter: RemAdapter;
  let question: MockRem;
  let answer: MockRem;
  let parent: MockRem;
  let history: Array<{ score: number; time: number }>;

  beforeEach(async () => {
    plugin = new MockRemNotePlugin();
    adapter = new RemAdapter(plugin as never, { acceptWriteOperations: true });
    parent = plugin.addTestRem('parent', 'Parent');
    question = plugin.addTestRem('question', 'Question');
    answer = plugin.addTestRem('answer', 'Answer');
    await question.setParent(parent);
    await answer.setParent(question);
    answer.setIsCardItemMock(true);
    history = [{ score: 1, time: 20 }];
    question.setCardsMock([
      new MockCard('card-1', 'question', 'forward', 1, history as never, 40, 0, 20),
    ]);
  });

  async function updateAnswer() {
    return adapter.updateAnswer({
      remId: 'answer',
      cardId: 'question',
      content: 'New answer',
      expectedTextHash: await contentHash(answer.text),
    });
  }

  it('updates the question exactly once without rewriting its answers or card facts', async () => {
    const write = vi.spyOn(question, 'setText');
    const answerWrite = vi.spyOn(answer, 'setText');
    const result = await adapter.updateNote({
      remId: 'question',
      content: 'New **question**',
      expectedTextHash: await contentHash(question.text),
    });
    expect(question.text).toEqual(['New **question**']);
    expect(answer.text).toEqual(['Answer']);
    expect(write).toHaveBeenCalledOnce();
    expect(answerWrite).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'verified',
      remId: 'question',
      cardRemId: 'question',
      parentRemId: 'parent',
      childrenRemIds: ['answer'],
      cardIds: ['card-1'],
      isCardItem: false,
      rawCards: [
        {
          id: 'card-1',
          createdAt: 1,
          nextRepetitionTime: 40,
          lastRepetitionTime: 20,
          timesWrongInRow: 0,
          repetitionHistory: [{ score: 1, time: 20 }],
        },
      ],
      verification: {
        text: true,
        parent: true,
        cardItem: true,
        cardIdentity: true,
        scheduling: true,
        availableHistory: true,
      },
    });
  });

  it('updates a direct answer and preserves its card-item flag and native references', async () => {
    plugin.addTestRem('source', 'Source');
    const write = vi.spyOn(answer, 'setText');
    const flagWrite = vi.spyOn(answer, 'setIsCardItem');
    const result = await adapter.updateAnswer({
      remId: 'answer',
      cardId: 'question',
      content: 'See [[id:source]]',
      expectedTextHash: await contentHash(answer.text),
    });
    expect(answer.text).toEqual(['See ', { i: 'q', _id: 'source' }]);
    expect(result.textHash).toBe(await contentHash(answer.text));
    expect(result).toMatchObject({
      status: 'verified',
      remId: 'answer',
      cardRemId: 'question',
      parentRemId: 'question',
      isCardItem: true,
      cardIds: ['card-1'],
    });
    expect(write).toHaveBeenCalledOnce();
    expect(flagWrite).not.toHaveBeenCalled();
  });

  it('protects the card owner when rem update targets a card-item child', async () => {
    const result = await adapter.updateNote({
      remId: 'answer',
      content: 'New',
      expectedTextHash: await contentHash(answer.text),
    });
    expect(result).toMatchObject({ cardRemId: 'question', cardIds: ['card-1'], isCardItem: true });
  });

  it('updates a plain Rem and preserves children', async () => {
    const result = await adapter.updateNote({
      remId: 'parent',
      content: '',
      expectedTextHash: await contentHash(parent.text),
    });
    expect(parent.text).toEqual(['']);
    expect(result).toMatchObject({ childrenRemIds: ['question'], cardIds: [], rawCards: [] });
  });

  it('rejects a stale raw-text hash before any write', async () => {
    const write = vi.spyOn(answer, 'setText');
    await expect(
      adapter.updateAnswer({
        remId: 'answer',
        cardId: 'question',
        content: 'New',
        expectedTextHash: 'a'.repeat(64),
      })
    ).rejects.toMatchObject({ type: 'conflict', subtype: 'text_hash_mismatch' });
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects an indirect child even when the claimed ancestor generates cards', async () => {
    const nested = plugin.addTestRem('nested', 'Nested');
    await nested.setParent(question);
    await answer.setParent(nested);
    const write = vi.spyOn(answer, 'setText');
    await expect(updateAnswer()).rejects.toMatchObject({ subtype: 'answer_parent_mismatch' });
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects a generated CardID rather than an exact parent Rem ID', async () => {
    await expect(
      adapter.updateAnswer({
        remId: 'answer',
        cardId: 'card-1',
        content: 'New',
        expectedTextHash: await contentHash(answer.text),
      })
    ).rejects.toMatchObject({ subtype: 'answer_parent_mismatch' });
  });

  it('rejects a parent with no generated cards before writing', async () => {
    question.setCardsMock([]);
    const write = vi.spyOn(answer, 'setText');
    await expect(updateAnswer()).rejects.toMatchObject({ subtype: 'parent_not_card' });
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects a non-card-item child without turning it into an answer', async () => {
    answer.setIsCardItemMock(false);
    const write = vi.spyOn(answer, 'setText');
    await expect(updateAnswer()).rejects.toMatchObject({ subtype: 'answer_not_card_item' });
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    'identity',
    'createdAt',
    'scheduling',
    'history',
    'in-place history',
    'text',
    'parent',
    'card item',
    'children',
    'own cards',
  ])('fails readback after a %s change without replaying the write', async (change) => {
    const write = vi.spyOn(answer, 'setText').mockImplementation(async (text) => {
      answer.text = text;
      if (change === 'identity')
        question.setCardsMock([
          new MockCard('card-2', 'question', 'forward', 1, history as never, 40, 0, 20),
        ]);
      if (change === 'createdAt')
        question.setCardsMock([
          new MockCard('card-1', 'question', 'forward', 2, history as never, 40, 0, 20),
        ]);
      if (change === 'scheduling')
        question.setCardsMock([
          new MockCard('card-1', 'question', 'forward', 1, history as never, 41, 0, 20),
        ]);
      if (change === 'history')
        question.setCardsMock([
          new MockCard('card-1', 'question', 'forward', 1, [] as never, 40, 0, 20),
        ]);
      if (change === 'in-place history') history.push({ score: 2, time: 30 });
      if (change === 'text') answer.text = ['Unexpected'];
      if (change === 'parent') await answer.setParent(parent);
      if (change === 'card item') answer.setIsCardItemMock(false);
      if (change === 'children') await plugin.addTestRem('new-child', 'New').setParent(answer);
      if (change === 'own cards')
        answer.setCardsMock([new MockCard('unexpected-card', 'answer', 'forward', 1)]);
    });
    await expect(updateAnswer()).rejects.toMatchObject({
      type: 'unknown_outcome',
      subtype: 'text_update_unverified',
      details: { remId: 'answer', cardRemId: 'question' },
    });
    expect(write).toHaveBeenCalledOnce();
  });

  it('does not invent unavailable history and rejects history availability changes', async () => {
    question.setCardsMock([new MockCard('card-1', 'question', 'forward', 1)]);
    expect((await updateAnswer()).rawCards[0].repetitionHistory).toBeNull();
    vi.spyOn(answer, 'setText').mockImplementation(async (text) => {
      answer.text = text;
      question.setCardsMock([new MockCard('card-1', 'question', 'forward', 1, [])]);
    });
    await expect(updateAnswer()).rejects.toMatchObject({ type: 'unknown_outcome' });
  });

  it('marks a lost write response unknown and never retries', async () => {
    const write = vi.spyOn(answer, 'setText').mockRejectedValue(new Error('connection lost'));
    await expect(updateAnswer()).rejects.toMatchObject({ type: 'unknown_outcome' });
    expect(write).toHaveBeenCalledOnce();
  });

  it('keeps the write gate for answer updates', async () => {
    adapter.updateSettings({ acceptWriteOperations: false });
    const write = vi.spyOn(answer, 'setText');
    await expect(updateAnswer()).rejects.toThrow('Write operations are disabled');
    expect(write).not.toHaveBeenCalled();
  });
});
