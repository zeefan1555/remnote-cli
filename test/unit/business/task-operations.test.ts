import { describe, it, expect, vi } from 'vitest';
import { BuiltInPowerupCodes, RemType } from '../../../src/business/sdk-constants.generated.js';
import type { RichTextInterface } from '@remnote/plugin-sdk';
import { RemAdapter } from '../../../src/business/rem-adapter';
import { contentHash } from '../../../src/business/content-hash';
import { verifyScope } from '../../../src/business/inspection';
import type { FlashcardsPlan, WikiPlan, TaskReceipt } from '../../../src/business/task-operations';
import { MockRem, MockCard, MockRemNotePlugin } from '../../helpers/business-mocks';

function adapter(plugin: MockRemNotePlugin): RemAdapter {
  return new RemAdapter(plugin as never, { acceptWriteOperations: true, autoTagEnabled: false });
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
  const wiki = plugin.addTestRem('wiki', 'WIKI');
  wiki.setIsFolderMock(true);
  wiki.addPowerupMock('u');
  const partition = plugin.addTestRem('partition', 'Partition');
  partition.setIsFolderMock(true);
  await partition.setParent(wiki);
  const index = plugin.addTestRem('index', 'Index');
  index.setIsDocumentMock(true);
  await index.setParent(wiki);
  const log = plugin.addTestRem('log', 'Log');
  log.setIsDocumentMock(true);
  await log.setParent(wiki);
  const source = plugin.addTestRem('source', 'Source');
  return {
    plugin,
    adapter: adapter(plugin),
    daily,
    home,
    tag,
    wiki,
    partition,
    index,
    log,
    source,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function wikiPlan(): WikiPlan {
  return {
    schemaVersion: 1,
    wikiRootId: 'wiki',
    partitionRemId: 'partition',
    indexRemId: 'index',
    logRemId: 'log',
    pages: [
      {
        key: 'p',
        title: 'Page',
        aliases: ['Alias'],
        nodes: [{ key: 'n', text: ['Body'] }],
        summary: ['Summary'],
      },
    ],
  };
}
function flashPlan(): FlashcardsPlan {
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
const request = <T>(plan: T, idempotencyKey = 'batch', dryRun = false) => ({
  schemaVersion: 1 as const,
  plan,
  idempotencyKey,
  dryRun,
});
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
async function loadJournal<T>(f: Fixture, kind: string): Promise<T> {
  return (await f.plugin.storage.getLocal(journalKey(kind))) as T;
}
async function existingPage(f: Fixture) {
  const page = f.plugin.addTestRem('existing-page', 'Existing page');
  await page.setParent(f.partition);
  await page.setIsCollapsed(true, f.partition._id);
  const entry = f.plugin.addTestRem('existing-entry', '');
  entry.text = [ref(page._id), ' — ', 'Summary'];
  await entry.setParent(f.index);
  return {
    page,
    entry,
    plan: {
      ...wikiPlan(),
      pages: [
        { key: 'p', remId: page._id, title: 'Existing page', nodes: [], summary: ['Summary'] },
      ],
    },
  } as { page: MockRem; entry: MockRem; plan: WikiPlan };
}
async function groupedPage(f: Fixture) {
  const e = await existingPage(f);
  const section = f.plugin.addTestRem('section', 'Section');
  await section.setParent(f.index);
  await e.entry.setParent(section);
  e.plan.pages[0].indexParentRemId = section._id;
  return { ...e, section };
}

describe('public task operation controls', () => {
  it.each(['new', 'reuse', 'answer-only'] as const)(
    'bounds %s verification independently of unrelated Wiki size',
    async (mode) => {
      const f = await fixture();
      const unrelated = f.plugin.addTestRem('unrelated', 'Unrelated partition');
      await unrelated.setParent(f.wiki);
      for (let i = 0; i < 100; i++)
        await f.plugin.addTestRem(`unrelated-${i}`, `Term ${i}`).setParent(unrelated);
      let plan = wikiPlan();
      if (mode === 'reuse') plan = (await existingPage(f)).plan;
      if (mode === 'answer-only') {
        const cards = await f.adapter.applyFlashcards(request(flashPlan(), 'cards'));
        success(cards);
        const answer = await rem(f, cards.ids['answer:a:0']);
        plan = {
          ...plan,
          pages: [],
          answerPatches: [
            {
              key: 'p',
              cardRemId: cards.ids['card:a'],
              remId: answer._id,
              expectedTextHash: await contentHash(answer.text),
              text: ['See ', { remId: 'source' }],
            },
          ],
        };
      }
      const scan = vi.spyOn(unrelated, 'getChildrenRem');
      f.plugin.rem.findOne.mockClear();
      const started = performance.now();
      const result = await f.adapter.applyWiki(request(plan));
      success(result);
      const affected = {
        elapsedMs: performance.now() - started,
        findOneCalls: f.plugin.rem.findOne.mock.calls.length,
        unrelatedScans: scan.mock.calls.length,
      };
      expect(affected.unrelatedScans).toBe(0);
      f.plugin.rem.findOne.mockClear();
      const fullStarted = performance.now();
      const full = await verifyScope(f.plugin as never, {
        schemaVersion: 1,
        inspect: { schemaVersion: 1, subtreeRootIds: ['wiki'] },
        expectations: [{ kind: 'zeroCards', remId: 'wiki', noCardStructure: true }],
      });
      expect(full.status).toBe('passed');
      const wholeWiki = {
        elapsedMs: performance.now() - fullStarted,
        findOneCalls: f.plugin.rem.findOne.mock.calls.length,
        objects: full.objects.length,
      };
      expect(scan).toHaveBeenCalledOnce();
      expect(wholeWiki.objects).toBeGreaterThan(100);
      console.log(
        JSON.stringify({
          benchmark: 'Wiki mock scopes (not native latency)',
          mode,
          affected,
          wholeWiki,
        })
      );
    }
  );
  it('checks all ten page/index subtrees without increasing selector limits', async () => {
    const f = await fixture();
    const plan = wikiPlan();
    plan.pages = Array.from({ length: 10 }, (_, i) => ({
      key: `p${i}`,
      title: `Page ${i}`,
      nodes: [],
      summary: ['Summary'],
    }));
    const result = await f.adapter.applyWiki(request(plan));
    success(result);
    expect(result.checks.filter((c) => c.kind === 'zeroCards')).toHaveLength(21);
  });
  it('verifies affected Wiki subtrees without scanning the entire Wiki', async () => {
    const f = await fixture();
    const scan = vi.spyOn(f.wiki, 'getChildrenRem');
    const result = await f.adapter.applyWiki(request(wikiPlan()));
    success(result);
    expect(result).toHaveProperty('verificationScope', 'affected_objects');
    expect(scan).not.toHaveBeenCalled();
    expect(
      result.checks.some((c) => c.kind === 'zeroCards' && c.remId === result.ids['page:p'])
    ).toBe(true);
    expect(
      result.checks.some((c) => c.kind === 'zeroCards' && c.remId === result.ids['index:p'])
    ).toBe(true);
  });
  it('answer-only patches do not scan Wiki/index/partition or alter card identity', async () => {
    const f = await fixture();
    const cards = await f.adapter.applyFlashcards(request(flashPlan(), 'cards'));
    success(cards);
    const answer = await rem(f, cards.ids['answer:a:0']);
    const rootScan = vi.spyOn(f.wiki, 'getChildrenRem');
    const indexScan = vi.spyOn(f.index, 'getChildrenRem');
    const partitionScan = vi.spyOn(f.partition, 'getChildrenRem');
    const result = await f.adapter.applyWiki(
      request({
        ...wikiPlan(),
        pages: [],
        answerPatches: [
          {
            key: 'answer',
            cardRemId: cards.ids['card:a'],
            remId: answer._id,
            expectedTextHash: await contentHash(answer.text),
            text: ['See ', { remId: 'source' }],
          },
        ],
      })
    );
    success(result);
    expect(rootScan).not.toHaveBeenCalled();
    expect(indexScan).not.toHaveBeenCalled();
    expect(partitionScan).not.toHaveBeenCalled();
    expect(result.facts.find((v) => v.remId === cards.ids['card:a'])?.reviewHash).toBe(
      cards.facts.find((v) => v.remId === cards.ids['card:a'])?.reviewHash
    );
  });
  it('still rejects hidden card structure in a reused Wiki subtree', async () => {
    const f = await fixture();
    const existing = await existingPage(f);
    const child = f.plugin.addTestRem('hidden-card', 'Hidden');
    child.backText = ['Hidden answer'];
    await child.setParent(existing.page);
    const result = await f.adapter.applyWiki(request(existing.plan));
    expect(result.complete).toBe(false);
    expect(result.checks.some((c) => c.kind === 'zeroCards' && c.status === 'failed')).toBe(true);
  });
  it('previews without mutation/storage/date APIs, even when writes are disabled', async () => {
    const f = await fixture();
    f.adapter.updateSettings({ acceptWriteOperations: false });
    const create = vi.spyOn(MockRem.prototype, 'setText');
    for (const result of [
      await f.adapter.applyWiki(request(wikiPlan(), 'wiki', true)),
      await f.adapter.applyFlashcards(request(flashPlan(), 'cards', true)),
    ]) {
      expect(result.status).toBe('preview');
      expect(result.complete).toBe(true);
      expect(result.created).toEqual([]);
    }
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
  it('rejects cardCluster without two new cards before any Card Cluster write', async () => {
    const f = await fixture();
    const plan = flashPlan();
    plan.cardCluster = true;
    plan.newCards = plan.newCards!.slice(0, 1);
    const addPowerup = vi.spyOn(MockRem.prototype, 'addPowerup');
    await expect(f.adapter.applyFlashcards(request(plan))).rejects.toThrow(
      'cardCluster requires a title and two or more new cards'
    );
    expect(addPowerup).not.toHaveBeenCalled();
    expect(f.plugin.rem.createTreeWithMarkdown).not.toHaveBeenCalled();
  });
  it('persists scaffold IDs before a failed follow-up and never recreates them', async () => {
    const f = await fixture();
    vi.spyOn(MockRem.prototype, 'setIsCollapsed').mockRejectedValueOnce(
      new Error('Collapse failed')
    );
    const first = await f.adapter.applyFlashcards(request(flashPlan()));
    expect(first.status).toBe('unknown');
    const stored = await loadJournal<{ steps: Record<string, { remIds: string[] }> }>(
      f,
      'flashcards'
    );
    expect(stored.steps['create:cards'].remIds).toHaveLength(5);
    expect(first.steps.find((step) => step.key === 'create:cards')?.remIds).toEqual(
      stored.steps['create:cards'].remIds
    );
    expect((await adapter(f.plugin).applyFlashcards(request(flashPlan()))).status).toBe('unknown');
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
  it.each([45001, 60001])(
    'starts no new scaffold mutations after a tree call returns at %i ms',
    async (elapsedMs) => {
      const f = await fixture();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
      const mutations = [
        vi.spyOn(MockRem.prototype, 'setParent'),
        vi.spyOn(MockRem.prototype, 'remove'),
        vi.spyOn(MockRem.prototype, 'addTag'),
        vi.spyOn(MockRem.prototype, 'setIsCollapsed'),
      ];
      const createTree = f.plugin.rem.createTreeWithMarkdown.getMockImplementation()!;
      f.plugin.rem.createTreeWithMarkdown.mockImplementation(async (...args) => {
        const tree = await createTree(...args);
        clock.mockReturnValue(elapsedMs);
        for (const mutation of mutations) mutation.mockClear();
        return tree;
      });
      expect((await f.adapter.applyFlashcards(request(flashPlan()))).status).toBe('unknown');
      for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
      expect((await adapter(f.plugin).applyFlashcards(request(flashPlan()))).status).toBe(
        'unknown'
      );
      expect(f.plugin.rem.createTreeWithMarkdown).toHaveBeenCalledTimes(1);
      const independent = await f.adapter.createNote({ title: 'Independent', parentId: 'daily' });
      expect(independent.remIds).toHaveLength(1);
    }
  );
  it('does not tag a cluster after slow native tree creation', async () => {
    const f = await fixture();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    const tag = vi.spyOn(MockRem.prototype, 'addTag');
    const createTree = f.plugin.rem.createTreeWithMarkdown.getMockImplementation()!;
    f.plugin.rem.createTreeWithMarkdown.mockImplementation(async (...args) => {
      const tree = await createTree(...args);
      clock.mockReturnValue(45001);
      return tree;
    });
    expect((await f.adapter.applyFlashcards(request(flashPlan()))).status).toBe('unknown');
    expect(tag).not.toHaveBeenCalled();
    expect(f.plugin.rem.createTreeWithMarkdown).toHaveBeenCalledTimes(1);
  });
  it('does not tag a single card after its in-flight collapse crosses the deadline', async () => {
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
    expect((await f.adapter.applyFlashcards(request(plan))).status).toBe('unknown');
    expect(collapse).toHaveBeenCalledTimes(1);
    expect(tag).not.toHaveBeenCalled();
  });
  it('applies Wiki native references and cross-page summaries without confusing index ownership', async () => {
    const f = await fixture();
    const plan: WikiPlan = {
      ...wikiPlan(),
      pages: [
        {
          key: 'a',
          title: 'Alpha',
          nodes: [{ key: 'body-a', text: [{ pageKey: 'b' }] }],
          summary: ['See ', { pageKey: 'b' }],
        },
        { key: 'b', title: 'Beta', nodes: [], summary: ['See ', { pageKey: 'a' }] },
      ],
    };
    const first = await f.adapter.applyWiki(request(plan));
    success(first);
    expect(first.ids['index:a']).not.toBe(first.ids['index:b']);
    for (const key of ['a', 'b']) {
      const entry = await rem(f, first.ids[`index:${key}`]);
      expect(entry.text[0]).toEqual(ref(first.ids[`page:${key}`]));
    }
    const count = f.plugin.rem.createRem.mock.calls.length;
    const replay = await adapter(f.plugin).applyWiki(request(plan));
    success(replay);
    expect(replay.ids).toEqual(first.ids);
    expect(f.plugin.rem.createRem).toHaveBeenCalledTimes(count);
    expect(await f.log.getChildrenRem()).toHaveLength(1);
    expect(JSON.stringify(f.plugin.storage.setLocal.mock.calls)).not.toContain('Summary');
    expect(f.plugin.date.getTodaysDoc).not.toHaveBeenCalled();
  });
  it('no-op existing Wiki page and patch/reference-only work do not create a log', async () => {
    const f = await fixture();
    const existing = await existingPage(f);
    success(await f.adapter.applyWiki(request(existing.plan, 'no-op')));
    expect(await f.log.getChildrenRem()).toEqual([]);
    const card = f.plugin.addTestRem('old-card', 'Question');
    card.setIsCardItemMock(true);
    card.setCardsMock([
      new MockCard('native-old', 'old-card', 'forward', 1, [{ date: 1, score: 3 } as never]),
    ]);
    const answer = f.plugin.addTestRem('old-answer', 'Before');
    await answer.setParent(card);
    const plan: WikiPlan = {
      ...wikiPlan(),
      pages: [],
      answerPatches: [
        {
          key: 'patch',
          cardRemId: card._id,
          remId: answer._id,
          expectedTextHash: await contentHash(answer.text),
          text: ['See ', { remId: existing.page._id }],
        },
      ],
    };
    const result = await f.adapter.applyWiki(request(plan, 'refs'));
    success(result);
    expect(await f.log.getChildrenRem()).toEqual([]);
    expect(result.facts.find((v) => v.remId === card._id)?.cardIds).toEqual(['native-old']);
  });
});

describe('Wiki replay ownership and plain-state guards', () => {
  it.each(['text', 'alias', 'index'] as const)(
    'never restores externally changed completed %s',
    async (field) => {
      const f = await fixture();
      const plan = wikiPlan();
      const first = await f.adapter.applyWiki(request(plan));
      success(first);
      const page = await rem(f, first.ids['page:p']);
      const index = await rem(f, first.ids['index:p']);
      if (field === 'text') page.text = ['External edit'];
      if (field === 'alias') page.setAliasesMock([]);
      if (field === 'index') index.text = [ref(page._id), 'external summary'];
      const text = vi.spyOn(MockRem.prototype, 'setText');
      const alias = vi.spyOn(MockRem.prototype, 'getOrCreateAliasWithText');
      const result = await adapter(f.plugin).applyWiki(request(plan));
      expect(result.status).toBe('conflict');
      expect(text).not.toHaveBeenCalled();
      expect(alias).not.toHaveBeenCalled();
    }
  );
  it.each(['type', 'tags', 'delimiter', 'cloze', 'document', 'card'] as const)(
    'rejects invalid existing node %s before setters',
    async (variant) => {
      const f = await fixture();
      const existing = await existingPage(f);
      const node = f.plugin.addTestRem('node', 'Old');
      await node.setParent(existing.page);
      if (variant === 'type') node.type = RemType.CONCEPT;
      if (variant === 'tags') await node.addTag(f.tag._id);
      if (variant === 'delimiter')
        node.text = ['front', { i: 's' } as RichTextInterface[number], 'back'];
      if (variant === 'cloze') node.text = [{ i: 'm', text: 'Old', cId: 'cloze-1' }];
      if (variant === 'document') node.setIsDocumentMock(true);
      if (variant === 'card') node.setIsCardItemMock(true);
      existing.plan.pages[0].nodes = [
        {
          key: 'n',
          remId: node._id,
          expectedTextHash: await contentHash(node.text),
          text: ['Changed'],
        },
      ];
      const setter = vi.spyOn(node, 'setText');
      const result = await f.adapter.applyWiki(request(existing.plan));
      expect(result.status).toBe('conflict');
      expect(setter).not.toHaveBeenCalled();
      expect(f.plugin.rem.createRem).not.toHaveBeenCalled();
    }
  );
  it('rejects ambiguous and duplicate native index owners before writes', async () => {
    for (const duplicate of [false, true]) {
      const f = await fixture();
      const e = await existingPage(f);
      if (duplicate) {
        const entry = f.plugin.addTestRem('duplicate', '');
        entry.text = [ref(e.page._id), 'duplicate'];
        await entry.setParent(f.index);
      } else e.entry.text = ['Unowned summary ', ref(e.page._id)];
      const setter = vi.spyOn(MockRem.prototype, 'setText');
      expect((await f.adapter.applyWiki(request(e.plan))).status).toBe('conflict');
      expect(setter).not.toHaveBeenCalled();
      setter.mockRestore();
      expect(f.plugin.rem.createRem).not.toHaveBeenCalled();
    }
  });
  it('retains grouped existing entry parent and rejects missing/new grouped entries before writes', async () => {
    const f = await fixture();
    const e = await existingPage(f);
    const section = f.plugin.addTestRem('section', 'Section');
    await section.setParent(f.index);
    await e.entry.setParent(section);
    success(await f.adapter.applyWiki(request(e.plan, 'existing-group')));
    expect((await e.entry.getParentRem())?._id).toBe(section._id);
    const create = f.plugin.rem.createRem.mock.calls.length;
    const result = await f.adapter.applyWiki(request(wikiPlan(), 'new-group'));
    expect(result.status).toBe('conflict');
    expect(result.errors[0].message).toContain('Grouped index');
    expect(f.plugin.rem.createRem).toHaveBeenCalledTimes(create);
  });
  it.each(['section', 'index'])('creates and replays an entry at explicit %s', async (parentId) => {
    const f = await fixture();
    const e = await groupedPage(f);
    const plan = wikiPlan();
    plan.pages[0].indexParentRemId = parentId;
    const preview = await f.adapter.applyWiki(request(plan, 'grouped', true));
    expect(preview.status).toBe('preview');
    expect(preview.complete).toBe(true);
    expect(f.plugin.rem.createRem).not.toHaveBeenCalled();
    expect(f.plugin.storage.setLocal).not.toHaveBeenCalled();
    const first = await f.adapter.applyWiki(request(plan, 'grouped'));
    success(first);
    expect((await (await rem(f, first.ids['index:p'])).getParentRem())?._id).toBe(parentId);
    const created = f.plugin.rem.createRem.mock.calls.length;
    const replay = await adapter(f.plugin).applyWiki(request(plan, 'grouped'));
    success(replay);
    expect(replay.ids).toEqual(first.ids);
    expect(replay.facts).toEqual(first.facts);
    expect(f.plugin.rem.createRem).toHaveBeenCalledTimes(created);
    expect(await f.log.getChildrenRem()).toHaveLength(1);
    expect((await e.entry.getParentRem())?._id).toBe(e.section._id);
  });
  it.each([true, false])('keeps an existing page with entry present=%s', async (hasEntry) => {
    const f = await fixture();
    const e = await groupedPage(f);
    if (!hasEntry) await e.entry.setParent(f.source);
    const first = await f.adapter.applyWiki(request(e.plan));
    success(first);
    expect(first.ids['page:p']).toBe(e.page._id);
    expect((await (await rem(f, first.ids['index:p'])).getParentRem())?._id).toBe(e.section._id);
    if (hasEntry) expect(first.ids['index:p']).toBe(e.entry._id);
    const count = f.plugin.rem.createRem.mock.calls.length;
    const replay = await adapter(f.plugin).applyWiki(request(e.plan));
    success(replay);
    expect(replay.ids).toEqual(first.ids);
    expect(f.plugin.rem.createRem).toHaveBeenCalledTimes(count);
  });
  it.each(['source', 'missing', 'index'])(
    'rejects foreign, missing or conflicting explicit parent %s before writes',
    async (parentId) => {
      const f = await fixture();
      const e = await groupedPage(f);
      e.plan.pages[0].indexParentRemId = parentId;
      const setter = vi.spyOn(MockRem.prototype, 'setText');
      for (const dryRun of [true, false]) {
        const result = await f.adapter.applyWiki(request(e.plan, 'bad-parent', dryRun));
        expect(result.status).toBe('conflict');
      }
      expect(setter).not.toHaveBeenCalled();
      expect(f.plugin.rem.createRem).not.toHaveBeenCalled();
      expect(f.plugin.storage.setLocal).not.toHaveBeenCalled();
    }
  );
  it.each(['', ' ', 'x'.repeat(257), 1])(
    'validates index parent at the business boundary %#',
    async (value) => {
      const f = await fixture();
      const plan = wikiPlan();
      Object.assign(plan.pages[0], { indexParentRemId: value });
      await expect(f.adapter.applyWiki(request(plan))).rejects.toThrow();
      expect(f.plugin.rem.createRem).not.toHaveBeenCalled();
    }
  );
  it.each(['width', 'depth', 'repeated'])(
    'never narrows the index uniqueness scan for an explicit parent: %s',
    async (bound) => {
      const f = await fixture();
      const e = await groupedPage(f);
      if (bound === 'repeated')
        vi.spyOn(e.section, 'getChildrenRem').mockResolvedValue([e.entry, e.entry]);
      else {
        let parent = f.index;
        for (let i = 0; i < (bound === 'width' ? 1001 : 101); i++) {
          const child = f.plugin.addTestRem(`bound-${i}`, 'Section');
          await child.setParent(parent);
          if (bound === 'depth') parent = child;
        }
      }
      expect((await f.adapter.applyWiki(request(e.plan))).status).toBe('incomplete');
      expect(f.plugin.rem.createRem).not.toHaveBeenCalled();
      expect(f.plugin.storage.setLocal).not.toHaveBeenCalled();
    }
  );
  it('revalidates a section after patch reads and before its setter', async () => {
    const f = await fixture();
    const e = await groupedPage(f);
    e.plan.pages[0].summary = ['Changed'];
    vi.spyOn(e.entry, 'getTagRems').mockImplementation(async () => {
      await e.section.setParent(f.source);
      return [];
    });
    const setter = vi.spyOn(e.entry, 'setText');
    expect((await f.adapter.applyWiki(request(e.plan))).status).toBe('conflict');
    expect(setter).not.toHaveBeenCalled();
    expect(f.plugin.rem.createRem).not.toHaveBeenCalled();
  });
  it('never parents a known-created entry into a section moved after creation', async () => {
    const f = await fixture();
    const e = await groupedPage(f);
    const plan = wikiPlan();
    plan.pages[0].indexParentRemId = e.section._id;
    const original = MockRem.prototype.getTagRems;
    vi.spyOn(MockRem.prototype, 'getTagRems').mockImplementation(async function (this: MockRem) {
      if (f.plugin.rem.createRem.mock.calls.length === 3 && this._id.startsWith('rem_'))
        await e.section.setParent(f.source);
      return original.call(this);
    });
    const result = await f.adapter.applyWiki(request(plan));
    expect(result.status).toBe('conflict');
    const entryId = result.created.find((r) => r.key === 'index:p')!.remId;
    expect((await rem(f, entryId)).parent).toBeUndefined();
    expect(f.plugin.rem.createRem).toHaveBeenCalledTimes(3);
  });
  it.each(['gate', 'deadline'])('rechecks %s after awaited index ancestry', async (boundary) => {
    const f = await fixture();
    const e = await groupedPage(f);
    e.plan.pages[0].summary = ['Changed'];
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    let patchRead = false;
    vi.spyOn(e.entry, 'getTagRems').mockImplementation(async () => {
      patchRead = true;
      return [];
    });
    vi.spyOn(e.section, 'getParentRem').mockImplementation(async () => {
      if (patchRead) {
        if (boundary === 'gate') f.adapter.updateSettings({ acceptWriteOperations: false });
        else clock.mockReturnValue(45001);
      }
      return f.index;
    });
    const setter = vi.spyOn(e.entry, 'setText');
    const result = await f.adapter.applyWiki(request(e.plan));
    expect(result.complete).toBe(false);
    expect(result.errors[0].code).toBe(boundary === 'gate' ? 'write_disabled' : 'incomplete');
    expect(setter).not.toHaveBeenCalled();
  });
  it('rejects late parent drift in final proof instead of reporting success', async () => {
    const f = await fixture();
    const e = await groupedPage(f);
    vi.spyOn(e.page, 'isCollapsed').mockImplementation(async () => {
      await e.entry.setParent(f.index);
      return true;
    });
    const result = await f.adapter.applyWiki(request(e.plan));
    expect(result.status).toBe('conflict');
    expect(result.errors[0].message).toContain('different parent');
  });
});

describe('durable journal and bounded recovery', () => {
  it('persists clone-on-write metadata and resumes a known-created unparented Wiki Rem without duplication', async () => {
    const f = await fixture();
    const original = MockRem.prototype.setParent;
    let interrupted = false;
    const stop = vi.spyOn(MockRem.prototype, 'setParent').mockImplementation(async function (
      this: MockRem,
      parent,
      ...rest
    ) {
      if (!interrupted && parent?._id === 'partition' && this._id.startsWith('rem_')) {
        interrupted = true;
        throw new Error('Interrupted before parent');
      }
      return original.call(this, parent, ...rest);
    });
    const partial = await f.adapter.applyWiki(request(wikiPlan()));
    expect(partial.status).toBe('partial');
    const id = partial.created[0].remId;
    expect((await rem(f, id)).text).toEqual(['']);
    const saved = await loadJournal<Record<string, unknown>>(f, 'wiki');
    expect(saved).toBeDefined();
    saved!.planHash = 'external local mutation';
    expect((await loadJournal<Record<string, unknown>>(f, 'wiki'))!.planHash).not.toBe(
      'external local mutation'
    );
    stop.mockRestore();
    const recovered = await adapter(f.plugin).applyWiki(request(wikiPlan()));
    success(recovered);
    expect(recovered.ids['page:p']).toBe(id);
    expect(f.plugin.rem.createRem).toHaveBeenCalledTimes(4);
  });
  it('checks external text hash before moving a known-created Wiki object', async () => {
    const f = await fixture();
    const original = MockRem.prototype.setParent;
    const stop = vi.spyOn(MockRem.prototype, 'setParent').mockImplementation(async function (
      this: MockRem,
      parent,
      ...rest
    ) {
      if (parent?._id === 'partition' && this._id.startsWith('rem_')) throw new Error('Interrupt');
      return original.call(this, parent, ...rest);
    });
    const first = await f.adapter.applyWiki(request(wikiPlan()));
    expect(first.status).toBe('partial');
    const created = await rem(f, first.created[0].remId);
    created.text = ['External changed text'];
    stop.mockRestore();
    const parent = vi.spyOn(created, 'setParent');
    const text = vi.spyOn(created, 'setText');
    const result = await adapter(f.plugin).applyWiki(request(wikiPlan()));
    expect(result.status).toBe('conflict');
    expect(parent).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(await created.getParentRem()).toBeUndefined();
  });
  it('unknown create response is never retried', async () => {
    const f = await fixture();
    const original = f.plugin.rem.createRem.getMockImplementation()!;
    f.plugin.rem.createRem.mockImplementationOnce(async () => {
      await original();
      throw new Error('Lost create response');
    });
    expect((await f.adapter.applyWiki(request(wikiPlan()))).status).toBe('unknown');
    expect(f.plugin.rem.createRem).toHaveBeenCalledTimes(1);
    expect((await adapter(f.plugin).applyWiki(request(wikiPlan()))).status).toBe('unknown');
    expect(f.plugin.rem.createRem).toHaveBeenCalledTimes(1);
  });
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
    expect(stored!.ids['card:a']).toBe(first.ids['card:a']);
    expect(stored!.ids['card:a']).toBeTruthy();
    const again = await adapter(f.plugin).applyFlashcards(request(flashPlan()));
    expect(again.status).toBe('unknown');
    expect(f.plugin.rem.createTreeWithMarkdown).toHaveBeenCalledTimes(count);
  });
  it('does not overwrite a verified Wiki node restored externally to its original hash during partial work', async () => {
    const f = await fixture();
    const e = await existingPage(f);
    const node = f.plugin.addTestRem('node', 'Original');
    await node.setParent(e.page);
    e.plan.pages[0].nodes = [
      {
        key: 'n',
        remId: node._id,
        text: ['Desired'],
        expectedTextHash: await contentHash(node.text),
      },
    ];
    e.plan.pages[0].summary = ['New summary'];
    const stop = vi.spyOn(e.entry, 'setText').mockRejectedValueOnce(new Error('Index interrupted'));
    const first = await f.adapter.applyWiki(request(e.plan));
    expect(first.status).toBe('partial');
    expect(node.text).toEqual(['Desired']);
    stop.mockRestore();
    node.text = ['Original'];
    const setter = vi.spyOn(node, 'setText');
    const result = await adapter(f.plugin).applyWiki(request(e.plan));
    expect(result.status).toBe('conflict');
    expect(setter).not.toHaveBeenCalled();
    expect(node.text).toEqual(['Original']);
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
      expect(result.status).toBe('conflict');
      expect(text).not.toHaveBeenCalled();
      expect(power).not.toHaveBeenCalled();
    }
  );
});

describe('live write gates after awaited reads', () => {
  it('rechecks after plain-state awaits before a created Wiki parent setter', async () => {
    const f = await fixture();
    const original = f.plugin.rem.createRem.getMockImplementation()!;
    let made: MockRem | undefined;
    f.plugin.rem.createRem.mockImplementationOnce(async () => {
      made = await original();
      vi.spyOn(made, 'isCardItem').mockImplementation(async () => {
        f.adapter.updateSettings({ acceptWriteOperations: false });
        return false;
      });
      vi.spyOn(made, 'setParent');
      vi.spyOn(made, 'setText');
      return made;
    });
    const result = await f.adapter.applyWiki(request(wikiPlan()));
    expect(result.status).not.toBe('verified');
    expect(made!.setParent).not.toHaveBeenCalled();
    expect(made!.setText).not.toHaveBeenCalled();
  });
  it('rechecks after native reference resolution before patch setText', async () => {
    const f = await fixture();
    const card = f.plugin.addTestRem('old-card', 'Question');
    card.setCardsMock([new MockCard('native', 'old-card', 'forward', 1, [])]);
    const answer = f.plugin.addTestRem('answer', 'Old');
    await answer.setParent(card);
    const p: FlashcardsPlan = {
      ...flashPlan(),
      newCards: [],
      title: undefined,
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

describe('additional repaired boundaries', () => {
  it.each(['type', 'tags', 'delimiter'] as const)(
    'never reparents/retypes a known-created Wiki %s drift',
    async (drift) => {
      const f = await fixture();
      const original = MockRem.prototype.setParent;
      const stop = vi.spyOn(MockRem.prototype, 'setParent').mockImplementation(async function (
        this: MockRem,
        parent,
        ...rest
      ) {
        if (parent?._id === 'partition' && this._id.startsWith('rem_'))
          throw new Error('Interrupt known create');
        return original.call(this, parent, ...rest);
      });
      const first = await f.adapter.applyWiki(request(wikiPlan()));
      expect(first.status).toBe('partial');
      stop.mockRestore();
      const target = await rem(f, first.created[0].remId);
      if (drift === 'type') target.type = RemType.CONCEPT;
      if (drift === 'tags') await target.addTag(f.tag._id);
      if (drift === 'delimiter')
        target.text = ['front', { i: 's' } as RichTextInterface[number], 'back'];
      const parent = vi.spyOn(target, 'setParent'),
        text = vi.spyOn(target, 'setText'),
        type = vi.spyOn(target, 'setType');
      const result = await adapter(f.plugin).applyWiki(request(wikiPlan()));
      expect(result.status).toBe('conflict');
      expect(parent).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
      expect(type).not.toHaveBeenCalled();
    }
  );
  it('rechecks live gate after alias read before alias mutation', async () => {
    const f = await fixture();
    const e = await existingPage(f);
    e.plan.pages[0].aliases = ['New alias'];
    vi.spyOn(e.page, 'getAliases').mockImplementation(async () => {
      f.adapter.updateSettings({ acceptWriteOperations: false });
      return [];
    });
    const setter = vi.spyOn(e.page, 'getOrCreateAliasWithText');
    const result = await f.adapter.applyWiki(request(e.plan));
    expect(result.status).not.toBe('verified');
    expect(setter).not.toHaveBeenCalled();
  });
  it('rechecks live gate after collapse read before presentation mutation', async () => {
    const f = await fixture();
    const e = await existingPage(f);
    vi.spyOn(e.page, 'isCollapsed').mockImplementation(async () => {
      f.adapter.updateSettings({ acceptWriteOperations: false });
      return false;
    });
    const setter = vi.spyOn(e.page, 'setIsCollapsed');
    const result = await f.adapter.applyWiki(request(e.plan));
    expect(result.status).not.toBe('verified');
    expect(setter).not.toHaveBeenCalled();
  });
  it('rejects plan/key mismatch without creating or rewriting any target', async () => {
    const f = await fixture();
    success(await f.adapter.applyWiki(request(wikiPlan())));
    const count = f.plugin.rem.createRem.mock.calls.length;
    const text = vi.spyOn(MockRem.prototype, 'setText');
    const p = wikiPlan();
    p.pages[0].title = 'Different plan';
    expect((await adapter(f.plugin).applyWiki(request(p))).status).toBe('conflict');
    expect(f.plugin.rem.createRem).toHaveBeenCalledTimes(count);
    expect(text).not.toHaveBeenCalled();
  });
  it('rejects an in-flight second writer rather than duplicating a batch', async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    f.plugin.kb.getCurrentKnowledgeBaseData.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((r) => (release = r));
      return { _id: 'test-kb', name: 'Test KB' };
    });
    const first = f.adapter.applyWiki(request(wikiPlan(), 'first', true));
    await started;
    const second = await f.adapter.applyWiki(request(wikiPlan(), 'second', true));
    expect(second.complete).toBe(false);
    expect(second.errors[0].code).toBe('busy');
    release();
    expect((await first).status).toBe('preview');
    expect(f.plugin.rem.createRem).not.toHaveBeenCalled();
  });
  it('limits duplicate guards to exact partition names/aliases and fails before writes on collision', async () => {
    const f = await fixture();
    const existing = f.plugin.addTestRem('already-there', 'Elsewhere');
    existing.setAliasesMock([['  PAGE  ']]);
    await existing.setParent(f.partition);
    expect((await f.adapter.applyWiki(request(wikiPlan()))).status).toBe('conflict');
    expect(f.plugin.rem.createRem).not.toHaveBeenCalled();
  });
  it.each(['date', 'unknown', 'key', 'hash', 'pageKey'] as const)(
    'rejects unsupported input %s before any mutation',
    async (issue) => {
      const f = await fixture();
      const p = wikiPlan() as unknown as Record<string, unknown>;
      if (issue === 'date') p.today = true;
      if (issue === 'unknown') p.deleteRemIds = ['r'];
      if (issue === 'key') p.pages = [{ key: 'bad key', title: 'Page', nodes: [], summary: ['x'] }];
      if (issue === 'hash')
        p.answerPatches = [
          { key: 'x', cardRemId: 'r', remId: 'a', expectedTextHash: 'bad', text: ['x'] },
        ];
      if (issue === 'pageKey')
        p.pages = [{ key: 'p', title: 'Page', nodes: [], summary: [{ pageKey: 'missing' }] }];
      await expect(f.adapter.applyWiki(request(p as unknown as WikiPlan))).rejects.toThrow();
      expect(f.plugin.storage.setLocal).not.toHaveBeenCalled();
      expect(f.plugin.rem.createRem).not.toHaveBeenCalled();
    }
  );
});

describe('immediate native reference proof', () => {
  it.each(['empty', 'wrong-id'] as const)(
    'rejects %s reference builder output before patching the target',
    async (variant) => {
      const f = await fixture();
      const e = await existingPage(f);
      const node = f.plugin.addTestRem('ref-target', 'Old');
      await node.setParent(e.page);
      e.plan.pages[0].nodes = [
        {
          key: 'ref-node',
          remId: node._id,
          expectedTextHash: await contentHash(node.text),
          text: [{ remId: 'source' }],
        },
      ];
      f.plugin.richText.rem.mockImplementation(() => ({
        value: vi.fn(async (): Promise<RichTextInterface> =>
          variant === 'empty' ? [] : [ref('wrong-id')]
        ),
      }));
      const setter = vi.spyOn(node, 'setText');
      const result = await f.adapter.applyWiki(request(e.plan));
      expect(result.status).not.toBe('verified');
      expect(result.complete).toBe(false);
      expect(setter).not.toHaveBeenCalled();
      expect(node.text).toEqual(['Old']);
    }
  );
  it('never verifies a correct raw text hash when native references remain unresolved', async () => {
    const f = await fixture();
    const e = await existingPage(f);
    const node = f.plugin.addTestRem('ref-target', 'Old');
    await node.setParent(e.page);
    e.plan.pages[0].nodes = [
      {
        key: 'ref-node',
        remId: node._id,
        expectedTextHash: await contentHash(node.text),
        text: [{ remId: 'source' }],
      },
    ];
    const native = vi.spyOn(node, 'remsBeingReferenced').mockResolvedValue([]);
    const result = await f.adapter.applyWiki(request(e.plan));
    expect(node.text).toEqual([ref('source')]);
    expect(await contentHash(node.text)).toBe(await contentHash([ref('source')]));
    expect(native).toHaveBeenCalled();
    expect(result.status).not.toBe('verified');
    expect(result.complete).toBe(false);
  });
  it.each(['alias', 'title'])(
    'rejects a same-partition formatted %s collision before writing',
    async (kind) => {
      const f = await fixture(),
        r = f.plugin.addTestRem('already', 'Different title');
      await r.setParent(f.partition);
      if (kind === 'alias') await r.getOrCreateAliasWithText([{ i: 'm', text: 'Page', b: true }]);
      else r.text = [{ i: 'm', text: 'Page', b: true }];
      const before = await f.adapter.inspectMany({ schemaVersion: 1, remIds: [r._id] });
      expect(before.complete).toBe(true);
      if (kind === 'alias') expect(before.objects[0].aliases).toEqual(['Page']);
      else expect(before.objects[0].title).toBe('Page');
      const setter = vi.spyOn(r, 'setText'),
        out = await f.adapter.applyWiki(request(wikiPlan()));
      expect(out.status).toBe('conflict');
      expect(f.plugin.rem.createRem).not.toHaveBeenCalled();
      expect(f.plugin.storage.setLocal).not.toHaveBeenCalled();
      expect(setter).not.toHaveBeenCalled();
    }
  );
  it('does not treat failed alias rendering as evidence that a name is unused', async () => {
    const f = await fixture(),
      r = f.plugin.addTestRem('already', 'Existing');
    await r.setParent(f.partition);
    await r.getOrCreateAliasWithText([{ i: 'm', text: 'Page', b: true }]);
    f.plugin.richText.toString.mockRejectedValue(new Error('SDK renderer failed'));
    const out = await f.adapter.applyWiki(request(wikiPlan()));
    expect(out.status).toBe('incomplete');
    expect(f.plugin.rem.createRem).not.toHaveBeenCalled();
    expect(f.plugin.storage.setLocal).not.toHaveBeenCalled();
  });
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
