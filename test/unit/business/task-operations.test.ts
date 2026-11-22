import { describe, it, expect, vi } from 'vitest';
import { BuiltInPowerupCodes, RemType } from '../../../src/business/sdk-constants.generated.js';
import type { RichTextInterface } from '@remnote/plugin-sdk';
import { RemAdapter } from '../../../src/business/rem-adapter';
import { contentHash } from '../../../src/business/content-hash';
import type { TaskReceipt } from '../../../src/business/task-operations';
import {
  FlashcardsApplySchema,
  FlashcardsPlanSchema,
  type FlashcardsPlanInput,
} from '../../../src/schemas/task-schemas';
import { summarizeReceipt } from '../../../src/remnote-cli/output/receipt-summary';
import { MockRem, MockCard, MockRemNotePlugin } from '../../helpers/business-mocks';

function adapter(plugin: MockRemNotePlugin, capabilities?: ReadonlySet<string>): RemAdapter {
  return new RemAdapter(
    plugin as never,
    { acceptWriteOperations: true, autoTagEnabled: false },
    plugin.storage as never,
    capabilities
  );
}
async function fixture() {
  const plugin = new MockRemNotePlugin();
  plugin.enableTaskSemantics();
  const daily = plugin.addTestRem('daily', 'Recorded diary');
  daily.setIsDocumentMock(true);
  daily.addPowerupMock(BuiltInPowerupCodes.DailyDocument);
  const home = plugin.addTestRem('home', 'HOME');
  home.setIsFolderMock(true);
  const tag = plugin.addTestRem('tag', 'Topic tag');
  tag.type = RemType.CONCEPT;
  await tag.setParent(home);
  const source = plugin.addTestRem('source', 'Source');
  return {
    plugin,
    adapter: adapter(plugin),
    daily,
    home,
    tag,
    source,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function flashPlan(): FlashcardsPlanInput {
  return {
    schemaVersion: 1,
    dailyRemId: 'daily',
    homeRootId: 'home',
    tagRemId: 'tag',
    title: 'Cluster',
    newCards: [
      { key: 'a', question: 'Question A?', answer: [['Answer A']] },
      { key: 'b', question: 'Question B?', answer: [['See ', { remId: 'source' }]] },
    ],
  };
}
const ref = (id: string) => ({ i: 'q', _id: id }) as RichTextInterface[number];
function request(plan: FlashcardsPlanInput, idempotencyKey = 'batch', dryRun = false) {
  return FlashcardsApplySchema.parse({
    schemaVersion: 1 as const,
    plan,
    idempotencyKey,
    dryRun,
  });
}
function expectBadRequest(
  plan: FlashcardsPlanInput,
  message?: string | RegExp,
  idempotencyKey = 'bad'
): void {
  expect(() => request(plan, idempotencyKey)).toThrow(message);
}
async function rem(f: Fixture, id: string): Promise<MockRem> {
  const result = await f.plugin.rem.findOne(id);
  expect(result).not.toBeNull();
  return result!;
}
function success(r: TaskReceipt): void {
  expect(r.errors).toEqual([]);
  expect(r.status).toBe('verified');
  expect(r.complete).toBe(true);
}
const journalKey = (kind: string, key = 'batch') => `task-v1:test-kb:${kind}:${key}`;
async function loadJournal<T>(f: Fixture, kind: string, key = 'batch'): Promise<T> {
  return (await f.plugin.storage.getLocal(journalKey(kind, key))) as T;
}

describe('public task operation controls', () => {
  it('fails before preview or mutation when a declared SDK capability is missing', async () => {
    const f = await fixture();
    const limited = adapter(f.plugin, new Set(['namespace:rem.findOne']));
    const out = await limited.applyFlashcards(request(flashPlan()));
    expect(out.status).toBe('incomplete');
    expect(out.errors[0]).toMatchObject({ code: 'missing_capability' });
    expect(out.errors[0]?.message).toContain('namespace:rem.createTreeWithMarkdown');
    expect(f.plugin.rem.createTreeWithMarkdown).not.toHaveBeenCalled();
    expect(f.plugin.storage.setLocal).not.toHaveBeenCalled();
  });

  it('previews without mutation/storage/date APIs, even when writes are disabled', async () => {
    const f = await fixture();
    f.adapter.updateSettings({ acceptWriteOperations: false });
    const create = vi.spyOn(MockRem.prototype, 'setText');
    const result = await f.adapter.applyFlashcards(request(flashPlan(), 'cards', true));
    expect(result.status).toBe('preview');
    expect(result.complete).toBe(true);
    expect(result.created).toEqual([]);
    expect(f.plugin.storage.setLocal).not.toHaveBeenCalled();
    expect(f.plugin.storage.getLocal).not.toHaveBeenCalled();
    expect(f.plugin.rem.createRem).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(f.plugin.date.getDailyDoc).not.toHaveBeenCalled();
    expect(f.plugin.date.getTodaysDoc).not.toHaveBeenCalled();
  });
  it('applies two cards and preserves semantic IDs/history on replay with no date calls', async () => {
    expect(RemType.DEFAULT_TYPE).toBeUndefined();
    const f = await fixture();
    f.plugin.app.transaction.mockRejectedValue(new Error('Native transactions unavailable'));
    const plan = flashPlan();
    const first = await f.adapter.applyFlashcards(request(plan));
    success(first);
    expect(first.ids.daily).toBe('daily');
    expect(first.facts.find((v) => v.remId === first.ids['card:a'])?.cardIds).toHaveLength(1);
    expect(await (await rem(f, first.ids.root)).hasPowerup('cc')).toBe(false);
    expect(first.checks.some((check) => check.kind === 'powerup')).toBe(false);
    const creations = f.plugin.rem.createTreeWithMarkdown.mock.calls.length;
    const replay = await adapter(f.plugin).applyFlashcards(request(plan));
    success(replay);
    expect(replay.ids).toEqual(first.ids);
    expect(replay.facts).toEqual(first.facts);
    expect(await (await rem(f, replay.ids.root)).hasPowerup('cc')).toBe(false);
    expect(replay.checks.some((check) => check.kind === 'powerup')).toBe(false);
    expect(f.plugin.rem.createTreeWithMarkdown).toHaveBeenCalledTimes(creations);
    expect(f.plugin.date.getDailyDoc).not.toHaveBeenCalled();
    expect(f.plugin.date.getTodaysDoc).not.toHaveBeenCalled();
    expect(f.plugin.app.transaction).not.toHaveBeenCalled();
  });
  it('applies 46 scaffold nodes through one bounded findMany read', async () => {
    const f = await fixture();
    const plan: FlashcardsPlanInput = {
      schemaVersion: 1,
      dailyRemId: 'daily',
      homeRootId: 'home',
      tagRemId: 'tag',
      title: 'Large cluster',
      newCards: Array.from({ length: 3 }, (_, cardIndex) => ({
        key: `large-${cardIndex}`,
        question: `Question ${cardIndex}?`,
        answer: Array.from({ length: 14 }, (_, answerIndex) => [
          `Answer ${cardIndex}:${answerIndex}`,
        ]),
      })),
    };
    const result = await f.adapter.applyFlashcards(request(plan, 'large-46'));
    success(result);
    expect(result.created).toHaveLength(46);
    expect(result.answerLines).toHaveLength(42);
    expect(f.plugin.rem.findMany.mock.calls.some(([ids]) => ids.length === 46)).toBe(true);
    expect(f.plugin.rem.findMany.mock.calls.every(([ids]) => ids.length <= 100)).toBe(true);
  });
  it('chunks scaffolds beyond one internal call without exposing a plan limit', async () => {
    const f = await fixture();
    const plan: FlashcardsPlanInput = {
      schemaVersion: 1,
      dailyRemId: 'daily',
      homeRootId: 'home',
      tagRemId: 'tag',
      newCards: [
        {
          key: 'many-answers',
          question: 'What are all the answers?',
          answer: Array.from({ length: 120 }, (_, index) => [`Answer ${index}`]),
        },
      ],
    };
    const result = await f.adapter.applyFlashcards(request(plan, 'chunked-122'));
    success(result);
    expect(result.created).toHaveLength(121);
    expect(result.answerLines).toHaveLength(120);
    expect(f.plugin.rem.createTreeWithMarkdown.mock.calls.length).toBeGreaterThan(1);
  });
  it('recovers unknown creation when every exact scaffold ID is present', async () => {
    const f = await fixture();
    const plan = flashPlan();
    vi.spyOn(MockRem.prototype, 'setIsCollapsed').mockRejectedValueOnce(
      new Error('Collapse interrupted')
    );
    const first = await f.adapter.applyFlashcards(request(plan, 'recover-exact'));
    expect(first.status).toBe('partial');
    const stored = await loadJournal<{
      ids: Record<string, string>;
      steps: Record<string, { state: string }>;
    }>(f, 'flashcards', 'recover-exact');
    stored.ids = {};
    stored.steps['create:cards'].state = 'unknown';
    await f.plugin.storage.setLocal(journalKey('flashcards', 'recover-exact'), stored);
    const creations = f.plugin.rem.createTreeWithMarkdown.mock.calls.length;
    const recovered = await adapter(f.plugin).applyFlashcards(request(plan, 'recover-exact'));
    success(recovered);
    expect(recovered.ids).toEqual(first.ids);
    expect(f.plugin.rem.createTreeWithMarkdown).toHaveBeenCalledTimes(creations);
  });
  it('does not recover unknown creation after a placeholder changed', async () => {
    const f = await fixture();
    const plan = flashPlan();
    vi.spyOn(MockRem.prototype, 'setIsCollapsed').mockRejectedValueOnce(
      new Error('Collapse interrupted')
    );
    const first = await f.adapter.applyFlashcards(request(plan, 'recover-changed'));
    expect(first.status).toBe('partial');
    const answer = await rem(f, first.ids['answer:a:0']);
    answer.text = ['Changed externally'];
    const stored = await loadJournal<{
      ids: Record<string, string>;
      steps: Record<string, { state: string }>;
    }>(f, 'flashcards', 'recover-changed');
    stored.ids = {};
    stored.steps['create:cards'].state = 'unknown';
    await f.plugin.storage.setLocal(journalKey('flashcards', 'recover-changed'), stored);
    const creations = f.plugin.rem.createTreeWithMarkdown.mock.calls.length;
    const result = await adapter(f.plugin).applyFlashcards(request(plan, 'recover-changed'));
    expect(result.status).toBe('unknown');
    expect(f.plugin.rem.createTreeWithMarkdown).toHaveBeenCalledTimes(creations);
  });
  it.each([undefined, false] as const)(
    'does not add Card Cluster when cardCluster is %s',
    async (cardCluster) => {
      const f = await fixture();
      const plan = flashPlan();
      if (cardCluster === false) plan.cardCluster = false;
      const addPowerup = vi.spyOn(MockRem.prototype, 'addPowerup');
      const result = await f.adapter.applyFlashcards(request(plan));
      success(result);
      expect(await (await rem(f, result.ids.root)).hasPowerup('cc')).toBe(false);
      expect(addPowerup.mock.calls.some((call) => call[0] === 'cc')).toBe(false);
      expect(
        result.checks.some((check) => check.kind === 'powerup' && check.expected === true)
      ).toBe(false);
    }
  );
  it('adds Card Cluster when cardCluster is true for a titled multi-card plan', async () => {
    const f = await fixture();
    const addPowerup = vi.spyOn(MockRem.prototype, 'addPowerup');
    const result = await f.adapter.applyFlashcards(request({ ...flashPlan(), cardCluster: true }));
    success(result);
    expect(await (await rem(f, result.ids.root)).hasPowerup('cc')).toBe(true);
    expect(addPowerup.mock.calls.some((call) => call[0] === 'cc')).toBe(true);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        kind: 'powerup',
        status: 'passed',
        expected: true,
        actual: true,
      })
    );
  });
  it('writes a rich-text question as a native reference on the front', async () => {
    const f = await fixture();
    const plan = flashPlan();
    plan.newCards![1].question = ['Compare ', { remId: 'source' }, ' and PB?'];
    const result = await f.adapter.applyFlashcards(request(plan));
    success(result);
    expect((await rem(f, result.ids['card:b'])).text).toEqual([
      'Compare ',
      ref('source'),
      ' and PB?',
    ]);
    expect((await rem(f, result.ids['card:a'])).text).toEqual(['Question A?']);
  });
  it('rejects a missing rich-text question reference before any write', async () => {
    const f = await fixture();
    const plan = flashPlan();
    plan.newCards![0].question = ['See ', { remId: 'missing' }, '?'];
    const result = await f.adapter.applyFlashcards(request(plan));
    expect(result.status).toBe('incomplete');
    expect(result.errors).toContainEqual({
      remId: 'missing',
      code: 'missing_rem',
      message: 'Rem missing or inaccessible',
    });
    expect(f.plugin.rem.createTreeWithMarkdown).not.toHaveBeenCalled();
    expect(f.plugin.storage.setLocal).not.toHaveBeenCalled();
  });
  it.each(['[[能力圈]] 和长远怎么取舍？', '能力圈]] 是什么？'])(
    'rejects literal bracket plain-string question %s before any write',
    async (q) => {
      const f = await fixture();
      const plan = flashPlan();
      plan.newCards![0].question = q;
      expectBadRequest(plan, /Plain-string question contains literal/);
      expect(f.plugin.rem.createTreeWithMarkdown).not.toHaveBeenCalled();
      expect(f.plugin.storage.setLocal).not.toHaveBeenCalled();
    }
  );
  it('rejects cardCluster without two new cards before any Card Cluster write', async () => {
    const f = await fixture();
    const plan = flashPlan();
    plan.cardCluster = true;
    plan.newCards = plan.newCards!.slice(0, 1);
    const addPowerup = vi.spyOn(MockRem.prototype, 'addPowerup');
    expectBadRequest(plan, 'cardCluster requires a title and two or more new cards');
    expect(addPowerup).not.toHaveBeenCalled();
    expect(f.plugin.rem.createTreeWithMarkdown).not.toHaveBeenCalled();
  });
  it('persists scaffold IDs before a failed follow-up and never recreates them', async () => {
    const f = await fixture();
    vi.spyOn(MockRem.prototype, 'setIsCollapsed').mockRejectedValueOnce(
      new Error('Collapse failed')
    );
    const first = await f.adapter.applyFlashcards(request(flashPlan()));
    expect(first.status).toBe('partial');
    const stored = await loadJournal<{
      steps: Record<string, { state: string; remIds: string[] }>;
    }>(f, 'flashcards');
    expect(stored.steps['create:cards'].state).toBe('applied');
    expect(stored.steps['create:cards'].remIds).toHaveLength(5);
    expect(first.steps.find((step) => step.key === 'create:cards')?.remIds).toEqual(
      stored.steps['create:cards'].remIds
    );
    success(await adapter(f.plugin).applyFlashcards(request(flashPlan())));
    expect(f.plugin.rem.createTreeWithMarkdown).toHaveBeenCalledOnce();
    expect(f.plugin.app.transaction).not.toHaveBeenCalled();
  });
  it.each([RemType.CONCEPT, RemType.DESCRIPTOR, RemType.PORTAL])(
    'rejects a created card retyped to %s without changing its content',
    async (type) => {
      const f = await fixture();
      const plan = flashPlan();
      const first = await f.adapter.applyFlashcards(request(plan));
      success(first);
      const card = await rem(f, first.ids['card:a']);
      card.type = type;
      const setText = vi.spyOn(MockRem.prototype, 'setText');
      const replay = await adapter(f.plugin).applyFlashcards(request(plan));
      expect(replay.status).toBe('conflict');
      expect(setText).not.toHaveBeenCalled();
      expect(f.plugin.rem.createTreeWithMarkdown).toHaveBeenCalledTimes(1);
    }
  );
  it('continues after wall-clock time that exceeded the old task deadline', async () => {
    const f = await fixture();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    const tag = vi.spyOn(MockRem.prototype, 'addTag');
    const createTree = f.plugin.rem.createTreeWithMarkdown.getMockImplementation()!;
    f.plugin.rem.createTreeWithMarkdown.mockImplementation(async (...args) => {
      const tree = await createTree(...args);
      clock.mockReturnValue(60001);
      return tree;
    });
    success(await f.adapter.applyFlashcards(request(flashPlan())));
    expect(tag).toHaveBeenCalled();
    expect(f.plugin.rem.createTreeWithMarkdown).toHaveBeenCalledTimes(1);
  });
  it('continues tagging after an in-flight collapse crosses the old deadline', async () => {
    const f = await fixture();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    const tag = vi.spyOn(MockRem.prototype, 'addTag');
    const original = MockRem.prototype.setIsCollapsed;
    const collapse = vi
      .spyOn(MockRem.prototype, 'setIsCollapsed')
      .mockImplementation(async function (this: MockRem, collapsed: boolean, portalId: string) {
        const result = await original.call(this, collapsed, portalId);
        clock.mockReturnValue(45001);
        return result;
      });
    const plan = flashPlan();
    plan.newCards = plan.newCards!.slice(0, 1);
    success(await f.adapter.applyFlashcards(request(plan)));
    expect(collapse).toHaveBeenCalledTimes(1);
    expect(tag).toHaveBeenCalled();
  });
});

describe('durable journal and bounded recovery', () => {
  it('failed durable scaffold mapping save leaves started/unknown and never blindly recreates', async () => {
    const f = await fixture();
    const save = f.plugin.storage.setLocal.getMockImplementation()!;
    let lost = false;
    f.plugin.storage.setLocal.mockImplementation(async (key, value) => {
      const j = value as { steps: Record<string, { state: string }> };
      if (lost || j.steps['create:cards']?.state === 'applied') {
        lost = true;
        throw new Error('Storage outage after creation');
      }
      await save(key, value);
    });
    const first = await f.adapter.applyFlashcards(request(flashPlan()));
    expect(first.status).toBe('unknown');
    const count = f.plugin.rem.createTreeWithMarkdown.mock.calls.length;
    f.plugin.storage.setLocal.mockImplementation(save);
    const stored = await loadJournal<{
      steps: Record<string, { state: string }>;
      ids: Record<string, string>;
    }>(f, 'flashcards');
    expect(stored!.steps['create:cards'].state).toBe('started');
    expect(stored!.ids['card:a']).toBeUndefined();
    expect(first.steps.find((step) => step.key === 'create:cards')?.remIds).toHaveLength(5);
    const again = await adapter(f.plugin).applyFlashcards(request(flashPlan()));
    success(again);
    expect(again.ids['card:a']).toBeTruthy();
    expect(f.plugin.rem.createTreeWithMarkdown).toHaveBeenCalledTimes(count);
  });
  it.each(['order', 'mapping', 'text', 'cc'] as const)(
    'rejects completed scaffold %s drift with stable IDs',
    async (drift) => {
      const f = await fixture();
      const p = flashPlan();
      if (drift === 'cc') p.cardCluster = true;
      const first = await f.adapter.applyFlashcards(request(p));
      success(first);
      const root = await rem(f, first.ids.root);
      const a = await rem(f, first.ids['card:a']);
      if (drift === 'order') await a.setParent(root, 1);
      if (drift === 'text') a.text = ['Task card 1'];
      if (drift === 'cc') await root.removePowerup('cc');
      if (drift === 'mapping') {
        const j = await loadJournal<{ ids: Record<string, string> }>(f, 'flashcards');
        [j!.ids['card:a'], j!.ids['card:b']] = [j!.ids['card:b'], j!.ids['card:a']];
        await f.plugin.storage.setLocal(journalKey('flashcards'), j);
      }
      const text = vi.spyOn(MockRem.prototype, 'setText');
      const power = vi.spyOn(MockRem.prototype, 'addPowerup');
      const result = await adapter(f.plugin).applyFlashcards(request(p));
      if (drift === 'mapping') {
        success(result);
        expect(result.ids['card:a']).toBe(first.ids['card:a']);
        expect(result.ids['card:b']).toBe(first.ids['card:b']);
      } else expect(result.status).toBe('conflict');
      expect(text).not.toHaveBeenCalled();
      expect(power).not.toHaveBeenCalled();
    }
  );
});

describe('live write gates after awaited reads', () => {
  it('rechecks after native reference resolution before patch setText', async () => {
    const f = await fixture();
    const card = f.plugin.addTestRem('old-card', 'Question');
    card.setCardsMock([new MockCard('native', 'old-card', 'forward', 1, [])]);
    const answer = f.plugin.addTestRem('answer', 'Old');
    await answer.setParent(card);
    const p: FlashcardsPlanInput = {
      schemaVersion: 1,
      answerPatches: [
        {
          key: 'patch',
          cardRemId: card._id,
          remId: answer._id,
          expectedTextHash: await contentHash(answer.text),
          text: [{ remId: 'source' }],
        },
      ],
    };
    const original = f.plugin.richText.rem.getMockImplementation()!;
    f.plugin.richText.rem.mockImplementation((r) => {
      const builder = original(r);
      const value = builder.value.getMockImplementation()!;
      builder.value.mockImplementation(async () => {
        const result = await value();
        f.adapter.updateSettings({ acceptWriteOperations: false });
        return result;
      });
      return builder;
    });
    const setter = vi.spyOn(answer, 'setText');
    expect((await f.adapter.applyFlashcards(request(p))).status).not.toBe('verified');
    expect(setter).not.toHaveBeenCalled();
    expect(answer.text).toEqual(['Old']);
  });
  it('rechecks after cluster powerup reads before addPowerup', async () => {
    const f = await fixture();
    const original = MockRem.prototype.hasPowerup;
    vi.spyOn(MockRem.prototype, 'hasPowerup').mockImplementation(async function (
      this: MockRem,
      code
    ) {
      const result = await original.call(this, code);
      if (code === 'cc' && JSON.stringify(this.text) === '["Cluster"]')
        f.adapter.updateSettings({ acceptWriteOperations: false });
      return result;
    });
    const setter = vi.spyOn(MockRem.prototype, 'addPowerup');
    const result = await f.adapter.applyFlashcards(request({ ...flashPlan(), cardCluster: true }));
    expect(result.status).not.toBe('verified');
    expect(setter).not.toHaveBeenCalled();
  });
});

describe('flashcard scope boundaries', () => {
  it('reports deep unobserved HOME ancestry incomplete instead of a false classification conflict', async () => {
    const f = await fixture();
    let parent = f.home;
    for (let i = 0; i < 21; i++) {
      const r = f.plugin.addTestRem(`level-${i}`, 'Level');
      await r.setParent(parent);
      parent = r;
    }
    await f.tag.setParent(parent);
    const out = await f.adapter.applyFlashcards(request(flashPlan()));
    expect(out.status).toBe('incomplete');
    expect(out.errors[0].code).toBe('incomplete');
    expect(f.plugin.rem.createTreeWithMarkdown).not.toHaveBeenCalled();
    expect(f.plugin.storage.setLocal).not.toHaveBeenCalled();
  });
});

describe('code-block flashcard answers', () => {
  it('stores a multiline code answer as one card item and reports it', async () => {
    const f = await fixture();
    const code = 'alpha\nbeta';
    const plan: FlashcardsPlanInput = {
      schemaVersion: 1,
      dailyRemId: 'daily',
      homeRootId: 'home',
      tagRemId: 'tag',
      newCards: [
        {
          key: 'code',
          question: 'Show the snippet',
          answer: [[{ code }], ['plain line']],
        },
      ],
    };
    expect(FlashcardsPlanSchema.parse(plan)).toMatchObject({
      newCards: [{ answer: [[{ code }], ['plain line']] }],
    });
    const setter = vi.spyOn(MockRem.prototype, 'setIsCardItem');
    const result = await f.adapter.applyFlashcards(request(plan, 'code-batch'));
    success(result);
    const codeId = result.ids['answer:code:0'];
    const plainId = result.ids['answer:code:1'];
    const codeRem = await rem(f, codeId);
    const plainRem = await rem(f, plainId);
    expect(codeRem.text).toEqual([{ i: 'm', text: code, code: true, language: 'plaintext' }]);
    expect(await codeRem.isCardItem()).toBe(true);
    expect(plainRem.text).toEqual(['plain line']);
    expect(await plainRem.isCardItem()).toBe(false);
    expect(setter).toHaveBeenCalledTimes(1);
    expect(result.answerLines).toEqual([
      {
        key: 'answer:code:0',
        remId: codeId,
        isCardItem: true,
        hasCardStructure: true,
        verified: true,
      },
      {
        key: 'answer:code:1',
        remId: plainId,
        isCardItem: false,
        hasCardStructure: false,
        verified: true,
      },
    ]);
    expect(summarizeReceipt(result as unknown as Record<string, unknown>).answerLines).toEqual(
      result.answerLines
    );
    expect(result).not.toHaveProperty('answerLines', undefined);
  });

  it('patches an answer into a card-item code block with an explicit language', async () => {
    const f = await fixture();
    const cards = await f.adapter.applyFlashcards(request(flashPlan(), 'cards'));
    success(cards);
    const answer = await rem(f, cards.ids['answer:a:0']);
    expect(await answer.isCardItem()).toBe(false);
    const plan: FlashcardsPlanInput = {
      schemaVersion: 1,
      answerPatches: [
        {
          key: 'snippet',
          cardRemId: cards.ids['card:a'],
          remId: answer._id,
          expectedTextHash: await contentHash(answer.text),
          text: [{ code: 'print(1)\nprint(2)', language: 'python' }],
        },
      ],
    };
    const result = await f.adapter.applyFlashcards(request(plan, 'patch-code'));
    success(result);
    expect(answer.text).toEqual([
      { i: 'm', text: 'print(1)\nprint(2)', code: true, language: 'python' },
    ]);
    expect(await answer.isCardItem()).toBe(true);
    expect(result.answerLines).toEqual([
      {
        key: 'patch:snippet',
        remId: answer._id,
        isCardItem: true,
        hasCardStructure: true,
        verified: true,
      },
    ]);
  });

  it('does not verify a patch when setIsCardItem changes card identity', async () => {
    const f = await fixture();
    const cards = await f.adapter.applyFlashcards(request(flashPlan(), 'cards'));
    success(cards);
    const answer = await rem(f, cards.ids['answer:a:0']);
    vi.spyOn(MockRem.prototype, 'setIsCardItem').mockImplementation(async function (
      this: MockRem,
      isCardItem: boolean
    ) {
      this.setIsCardItemMock(isCardItem);
      const parent = await this.getParentRem();
      parent?.setCardsMock([new MockCard('replaced-card', parent._id, 'forward', 2, [])]);
    });
    const result = await f.adapter.applyFlashcards(
      request(
        {
          schemaVersion: 1,
          answerPatches: [
            {
              key: 'snippet',
              cardRemId: cards.ids['card:a'],
              remId: answer._id,
              expectedTextHash: await contentHash(answer.text),
              text: [{ code: 'print(1)', language: 'python' }],
            },
          ],
        },
        'identity-shift'
      )
    );
    expect(result.status).toBe('partial');
    expect(result.complete).toBe(false);
    expect(result.errors[0]?.message).toBe(
      'Card identity or history changed while writing an answer line'
    );
    expect(result.facts.some((fact) => fact.cardIds.includes('replaced-card'))).toBe(false);
    expect(result.answerLines).toEqual([
      {
        key: 'patch:snippet',
        remId: answer._id,
        isCardItem: true,
        hasCardStructure: true,
        verified: false,
        error: 'Card identity or history changed while writing an answer line',
      },
    ]);
  });

  it('does not verify a new card when setIsCardItem changes card identity', async () => {
    const f = await fixture();
    vi.spyOn(MockRem.prototype, 'setIsCardItem').mockImplementation(async function (
      this: MockRem,
      isCardItem: boolean
    ) {
      this.setIsCardItemMock(isCardItem);
      const parent = await this.getParentRem();
      parent?.setCardsMock([new MockCard('replaced-card', parent._id, 'forward', 2, [])]);
    });
    const result = await f.adapter.applyFlashcards(
      request(
        {
          schemaVersion: 1,
          dailyRemId: 'daily',
          homeRootId: 'home',
          tagRemId: 'tag',
          newCards: [
            {
              key: 'code',
              question: 'Show the snippet',
              answer: [['plain first'], [{ code: 'body' }]],
            },
          ],
        },
        'create-identity'
      )
    );
    expect(result.status).toBe('partial');
    expect(result.complete).toBe(false);
    expect(result.errors[0]).toMatchObject({
      remId: result.ids['card:code'],
      code: 'incomplete',
      message: 'Card identity or history changed while writing an answer line',
    });
    expect(result.facts.some((fact) => fact.cardIds.includes('replaced-card'))).toBe(false);
    expect(result.answerLines).toEqual([
      {
        key: 'answer:code:0',
        remId: result.ids['answer:code:0'],
        isCardItem: false,
        hasCardStructure: false,
        verified: true,
      },
      {
        key: 'answer:code:1',
        remId: result.ids['answer:code:1'],
        isCardItem: true,
        hasCardStructure: true,
        verified: false,
        error: 'Card identity or history changed while writing an answer line',
      },
    ]);
  });

  it('keeps isCardItem when a code answer is patched back to plain text', async () => {
    const f = await fixture();
    const created = await f.adapter.applyFlashcards(
      request(
        {
          schemaVersion: 1,
          dailyRemId: 'daily',
          homeRootId: 'home',
          tagRemId: 'tag',
          newCards: [
            {
              key: 'code',
              question: 'Show the snippet',
              answer: [[{ code: 'print(1)', language: 'python' }]],
            },
          ],
        },
        'code-card'
      )
    );
    success(created);
    const answer = await rem(f, created.ids['answer:code:0']);
    expect(await answer.isCardItem()).toBe(true);
    const result = await f.adapter.applyFlashcards(
      request(
        {
          schemaVersion: 1,
          answerPatches: [
            {
              key: 'plain',
              cardRemId: created.ids['card:code'],
              remId: answer._id,
              expectedTextHash: await contentHash(answer.text),
              text: ['See the note'],
            },
          ],
        },
        'back-to-plain'
      )
    );
    success(result);
    expect(answer.text).toEqual(['See the note']);
    expect(await answer.isCardItem()).toBe(true);
    expect(result.answerLines).toEqual([
      {
        key: 'patch:plain',
        remId: answer._id,
        isCardItem: true,
        hasCardStructure: true,
        verified: true,
      },
    ]);
  });

  it('rejects a mixed code-block answer line before writing', async () => {
    const f = await fixture();
    const plan: FlashcardsPlanInput = {
      ...flashPlan(),
      newCards: [
        {
          key: 'bad',
          question: 'Question?',
          answer: [['prefix', { code: 'body', language: 'plaintext' }]],
        },
      ],
      title: undefined,
    };
    expectBadRequest(plan, /single segment/, 'bad-code');
    expect(f.plugin.rem.createTreeWithMarkdown).not.toHaveBeenCalled();
  });

  it('fails closed when setIsCardItem does not make the code answer a card item', async () => {
    const f = await fixture();
    vi.spyOn(MockRem.prototype, 'setIsCardItem').mockImplementation(async () => {});
    const plan: FlashcardsPlanInput = {
      schemaVersion: 1,
      dailyRemId: 'daily',
      homeRootId: 'home',
      tagRemId: 'tag',
      newCards: [{ key: 'code', question: 'Show the snippet', answer: [[{ code: 'body' }]] }],
    };
    const result = await f.adapter.applyFlashcards(request(plan, 'stuck-card-item'));
    expect(result.status).toBe('partial');
    expect(result.errors[0].message).toMatch(/not a card item/);
    const answer = await rem(f, result.ids['answer:code:0']);
    expect(answer.text).toEqual([{ i: 'm', text: 'body', code: true, language: 'plaintext' }]);
    expect(await answer.isCardItem()).toBe(false);
  });
});

describe('flashcards under an existing topic (parentRemId)', () => {
  async function topicFixture() {
    const f = await fixture();
    const first = await f.adapter.applyFlashcards(request(flashPlan(), 'first'));
    success(first);
    return { f, topicId: first.ids.root, first };
  }
  const overflow = (topicId: string): FlashcardsPlanInput => ({
    schemaVersion: 1,
    dailyRemId: 'daily',
    homeRootId: 'home',
    tagRemId: 'tag',
    parentRemId: topicId,
    newCards: [
      { key: 'c', question: 'Question C?', answer: [['Answer C']] },
      { key: 'd', question: ['Compare ', { remId: 'source' }, '?'], answer: [['D1'], ['D2']] },
    ],
  });
  it('appends untitled cards to the topic without a second topic or a HOME tag', async () => {
    const { f, topicId, first } = await topicFixture();
    const tagSpy = vi.spyOn(MockRem.prototype, 'addTag');
    const plan = overflow(topicId);
    const result = await f.adapter.applyFlashcards(request(plan, 'overflow'));
    success(result);
    expect(result.ids).not.toHaveProperty('root');
    expect(result.ids.parent).toBe(topicId);
    const topic = await rem(f, topicId);
    expect((await topic.getChildrenRem()).map((r) => r._id)).toEqual([
      first.ids['card:a'],
      first.ids['card:b'],
      result.ids['card:c'],
      result.ids['card:d'],
    ]);
    expect((await topic.getTagRems()).map((r) => r._id)).toEqual(['tag']);
    for (const key of ['card:c', 'card:d']) {
      const card = await rem(f, result.ids[key]);
      expect((await card.getParentRem())?._id).toBe(topicId);
      expect(await card.getTagRems()).toEqual([]);
    }
    expect((await rem(f, result.ids['card:d'])).text).toEqual(['Compare ', ref('source'), '?']);
    expect((await rem(f, result.ids['answer:d:1'])).text).toEqual(['D2']);
    expect(tagSpy).not.toHaveBeenCalled();
    expect(result.checks).toContainEqual(
      expect.objectContaining({ kind: 'children', remId: topicId, status: 'passed' })
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({ kind: 'tag', remId: result.ids['card:c'], status: 'passed' })
    );
    const creations = f.plugin.rem.createTreeWithMarkdown.mock.calls.length;
    const replay = await adapter(f.plugin).applyFlashcards(request(plan, 'overflow'));
    success(replay);
    expect(replay.ids).toEqual(result.ids);
    expect(f.plugin.rem.createTreeWithMarkdown).toHaveBeenCalledTimes(creations);
  });
  it('places a single card under the topic', async () => {
    const { f, topicId } = await topicFixture();
    const plan = { ...overflow(topicId), newCards: overflow(topicId).newCards!.slice(0, 1) };
    const result = await f.adapter.applyFlashcards(request(plan, 'single'));
    success(result);
    expect((await (await rem(f, result.ids['card:c'])).getParentRem())?._id).toBe(topicId);
    expect(await (await rem(f, result.ids['card:c'])).getTagRems()).toEqual([]);
  });
  it.each(['untagged', 'nested', 'card'] as const)(
    'rejects a %s parentRemId before any write',
    async (mode) => {
      const { f, topicId, first } = await topicFixture();
      let target = topicId;
      if (mode === 'untagged') {
        const bare = f.plugin.addTestRem('bare', 'Bare topic');
        await bare.setParent(f.daily);
        target = bare._id;
      }
      if (mode === 'nested') {
        const nested = f.plugin.addTestRem('nested', 'Nested topic');
        await nested.setParent(await rem(f, topicId));
        await nested.addTag('tag');
        target = nested._id;
      }
      if (mode === 'card') target = first.ids['card:a'];
      const creations = f.plugin.rem.createTreeWithMarkdown.mock.calls.length;
      const result = await f.adapter.applyFlashcards(request(overflow(target), `bad-${mode}`));
      expect(result.status).toBe('conflict');
      expect(result.errors[0]?.message).toContain('parentRemId must be an existing');
      expect(f.plugin.rem.createTreeWithMarkdown).toHaveBeenCalledTimes(creations);
    }
  );
  it('rejects parentRemId with a title before any write', async () => {
    const { topicId } = await topicFixture();
    expectBadRequest({ ...overflow(topicId), title: 'Topic' }, 'omit title', 'titled');
  });
});

describe('flashcards with explicit tags', () => {
  async function tagged() {
    const f = await fixture();
    const term = f.plugin.addTestRem('term-topic', 'Term topic');
    term.type = RemType.CONCEPT;
    return { f, term };
  }
  const explicitPlan = (): FlashcardsPlanInput => ({
    schemaVersion: 1,
    dailyRemId: 'daily',
    title: 'Cluster',
    newCards: [
      { key: 'a', question: 'Question A?', answer: [['Answer A']] },
      { key: 'b', question: 'Question B?', answer: [['Answer B']] },
    ],
    tags: { root: [], 'card:a': ['term-topic'], 'card:b': ['term-topic'] },
  });
  const underTopic = (topicId: string): FlashcardsPlanInput => ({
    schemaVersion: 1,
    dailyRemId: 'daily',
    parentRemId: topicId,
    newCards: [
      { key: 'c', question: 'Question C?', answer: [['Answer C']] },
      { key: 'd', question: ['Compare ', { remId: 'source' }, '?'], answer: [['D1']] },
    ],
    tags: { 'card:c': ['term-topic'], 'card:d': ['tag'] },
  });
  const tagIds = async (f: Fixture, id: string) =>
    (await (await rem(f, id)).getTagRems()).map((r) => r._id).sort();

  it('writes exactly the declared tags, leaves the root untagged and replays without new writes', async () => {
    const { f } = await tagged();
    const tagSpy = vi.spyOn(MockRem.prototype, 'addTag');
    const plan = explicitPlan();
    const result = await f.adapter.applyFlashcards(request(plan, 'explicit'));
    success(result);
    expect(result.ids).not.toHaveProperty('tag');
    expect(await tagIds(f, result.ids.root)).toEqual([]);
    expect(await tagIds(f, result.ids['card:a'])).toEqual(['term-topic']);
    expect(await tagIds(f, result.ids['card:b'])).toEqual(['term-topic']);
    expect(await tagIds(f, result.ids['answer:a:0'])).toEqual([]);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ kind: 'tags', remId: result.ids.root, status: 'passed' })
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        kind: 'tags',
        remId: result.ids['card:a'],
        status: 'passed',
        actual: ['term-topic'],
      })
    );
    const writes = tagSpy.mock.calls.length;
    expect(writes).toBe(2);
    const creations = f.plugin.rem.createTreeWithMarkdown.mock.calls.length;
    const replay = await adapter(f.plugin).applyFlashcards(request(plan, 'explicit'));
    success(replay);
    expect(replay.ids).toEqual(result.ids);
    expect(f.plugin.rem.createTreeWithMarkdown).toHaveBeenCalledTimes(creations);
    expect(tagSpy).toHaveBeenCalledTimes(writes);
    tagSpy.mockRestore();
  });

  it('keeps the implicit HOME tag on the root when tags is omitted', async () => {
    const f = await fixture();
    const result = await f.adapter.applyFlashcards(request(flashPlan(), 'legacy'));
    success(result);
    expect(result.ids.tag).toBe('tag');
    expect(await tagIds(f, result.ids.root)).toEqual(['tag']);
    expect(await tagIds(f, result.ids['card:a'])).toEqual([]);
    expect(result.checks.some((c) => c.kind === 'tags')).toBe(false);
  });

  it('accepts an untagged topic as parentRemId and tags each new card as declared', async () => {
    const { f } = await tagged();
    const first = await f.adapter.applyFlashcards(request(explicitPlan(), 'first'));
    success(first);
    const topicId = first.ids.root;
    const result = await f.adapter.applyFlashcards(request(underTopic(topicId), 'second'));
    success(result);
    expect(await tagIds(f, topicId)).toEqual([]);
    expect(await tagIds(f, result.ids['card:c'])).toEqual(['term-topic']);
    expect(await tagIds(f, result.ids['card:d'])).toEqual(['tag']);
    expect((await (await rem(f, result.ids['card:d'])).getParentRem())?._id).toBe(topicId);
  });

  it('accepts a legacy HOME-tagged topic and leaves its tag in place', async () => {
    const { f } = await tagged();
    const legacy = await f.adapter.applyFlashcards(request(flashPlan(), 'legacy'));
    success(legacy);
    const result = await f.adapter.applyFlashcards(request(underTopic(legacy.ids.root), 'next'));
    success(result);
    expect(await tagIds(f, legacy.ids.root)).toEqual(['tag']);
    expect(await tagIds(f, result.ids['card:d'])).toEqual(['tag']);
  });

  it('still rejects a nested parentRemId before any write', async () => {
    const { f } = await tagged();
    const first = await f.adapter.applyFlashcards(request(explicitPlan(), 'first'));
    const creations = f.plugin.rem.createTreeWithMarkdown.mock.calls.length;
    const result = await f.adapter.applyFlashcards(
      request(underTopic(first.ids['card:a']), 'nested')
    );
    expect(result.status).toBe('conflict');
    expect(result.errors[0]?.message).toContain('parentRemId must be an existing');
    expect(f.plugin.rem.createTreeWithMarkdown).toHaveBeenCalledTimes(creations);
  });

  it('fails when a created Rem ends with an undeclared tag', async () => {
    const { f } = await tagged();
    f.plugin.addTestRem('extra', 'Extra');
    const original = MockRem.prototype.addTag;
    const spy = vi.spyOn(MockRem.prototype, 'addTag').mockImplementation(async function (
      this: MockRem,
      id: string
    ) {
      await original.call(this, id);
      await original.call(this, 'extra');
    });
    const result = await f.adapter.applyFlashcards(request(explicitPlan(), 'extra'));
    spy.mockRestore();
    expect(result.status).toBe('conflict');
    expect(result.errors[0]?.message).toContain('Created tags differ from plan tags');
    expect(result.checks).toContainEqual(
      expect.objectContaining({ kind: 'tags', status: 'failed' })
    );
  });

  it('treats a single-card root and its card key as one Rem', async () => {
    const { f } = await tagged();
    const single: FlashcardsPlanInput = {
      schemaVersion: 1,
      dailyRemId: 'daily',
      newCards: [{ key: 's', question: 'Single?', answer: [['Yes']] }],
      tags: { root: ['term-topic'], 'card:s': ['term-topic'] },
    };
    const result = await f.adapter.applyFlashcards(request(single, 'single'));
    success(result);
    expect(result.ids.root).toBe(result.ids['card:s']);
    expect(await tagIds(f, result.ids['card:s'])).toEqual(['term-topic']);
    expectBadRequest(
      { ...single, tags: { root: [], 'card:s': ['term-topic'] } },
      'tags.root and its card key must match',
      'mismatch'
    );
  });

  it.each([
    ['an answer key', { tags: { 'answer:a:0': ['tag'] } }, 'Unknown tags key'],
    ['an unknown card key', { tags: { 'card:zz': ['tag'] } }, 'Unknown tags key'],
    ['a duplicate tag ID', { tags: { 'card:a': ['tag', 'tag'] } }, 'Duplicate tag ID'],
    ['tagRemId alongside tags', { tagRemId: 'tag' }, 'omit both'],
    ['homeRootId alongside tags', { homeRootId: 'home' }, 'omit both'],
  ])('rejects %s before any write', async (_name, patch, message) => {
    const { f } = await tagged();
    expectBadRequest({ ...explicitPlan(), ...patch }, message);
    expect(f.plugin.rem.createTreeWithMarkdown).not.toHaveBeenCalled();
  });

  it('rejects tags.root on a parentRemId plan and a missing tag Rem', async () => {
    const { f } = await tagged();
    const first = await f.adapter.applyFlashcards(request(explicitPlan(), 'first'));
    expectBadRequest(
      { ...underTopic(first.ids.root), tags: { root: [] } },
      'tags.root needs a created root',
      'root'
    );
    const creations = f.plugin.rem.createTreeWithMarkdown.mock.calls.length;
    const missing = await f.adapter.applyFlashcards(
      request({ ...explicitPlan(), tags: { 'card:a': ['nope'] } }, 'missing')
    );
    expect(missing.status).not.toBe('verified');
    expect(missing.errors[0]?.message).toContain('Rem missing');
    expect(f.plugin.rem.createTreeWithMarkdown).toHaveBeenCalledTimes(creations);
  });
});
