import { describe, expect, it, vi } from 'vitest';
import { RemType } from '../../../src/business/sdk-constants.generated.js';
import { contentHash } from '../../../src/business/content-hash.js';
import {
  INSPECT_CONCURRENCY,
  inspectState,
  requestedFields,
} from '../../../src/business/state-inspect.js';
import { builtinSlotName, getPowerupSlot } from '../../../src/business/powerup-read.js';

function textOf(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((part) =>
      typeof part === 'string'
        ? part
        : part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
          ? part.text
          : ''
    )
    .join('');
}

function fixture() {
  type Rem = ReturnType<typeof make>;
  const nodes = new Map<string, Rem>();
  function make(id: string, text: unknown = [id], parent?: string) {
    const rem = {
      _id: id,
      type: RemType.DEFAULT_TYPE as number | undefined,
      text,
      backText: undefined as unknown,
      parent,
      isFolder: vi.fn(async () => false),
      isDocument: vi.fn(async () => false),
      isCardItem: vi.fn(async () => false),
      hasPowerup: vi.fn(async () => false),
      getChildrenRem: vi.fn(async () => [] as Rem[]),
      getTagRems: vi.fn(async () => [] as Rem[]),
      getAliases: vi.fn(async () => [] as Array<{ text: unknown }>),
      getSources: vi.fn(async () => [] as Rem[]),
      getCards: vi.fn(async () => [] as unknown[]),
      getPracticeDirection: vi.fn(async () => 'none'),
      getEnablePractice: vi.fn(async () => false),
      getPortalType: vi.fn(async () => 0),
      getPortalDirectlyIncludedRem: vi.fn(async () => [] as Rem[]),
      getPowerupProperty: vi.fn(async () => undefined),
      isCode: vi.fn(async () => true),
    };
    nodes.set(id, rem);
    if (parent) {
      const parentRem = nodes.get(parent);
      if (parentRem)
        parentRem.getChildrenRem.mockImplementation(async () =>
          [...nodes.values()].filter((child) => child.parent === parent)
        );
    }
    return rem;
  }
  const plugin = {
    rem: {
      findMany: vi.fn(async (ids: string[]) =>
        ids.flatMap((id) => {
          const rem = nodes.get(id);
          return rem ? [rem] : [];
        })
      ),
      findOne: vi.fn(async (id: string) => nodes.get(id)),
    },
    richText: {
      toString: vi.fn(async (value: unknown) => textOf(value)),
      toMarkdown: vi.fn(async (value: unknown) => `md:${textOf(value)}`),
    },
  };
  return { make, plugin, nodes };
}

describe('generic inspect', () => {
  it('loads requested ids in one findMany and summarizes every requested field', async () => {
    const { make, plugin } = fixture();
    const root = make('root', ['Home']);
    root.isFolder.mockResolvedValue(true);
    const parent = make('parent', ['Projects'], 'root');
    parent.isDocument.mockResolvedValue(true);
    const tag = make('tag', ['Code'], 'parent');
    tag.type = RemType.CONCEPT;
    const answer = make('answer', [{ i: 'm', text: 'Question' }], 'parent');
    answer.backText = [{ i: 'm', text: 'return 1', code: true, language: 'python' }];
    answer.isCardItem.mockResolvedValue(true);
    answer.getPracticeDirection.mockResolvedValue('forward');
    answer.getEnablePractice.mockResolvedValue(true);
    answer.getTagRems.mockResolvedValue([tag]);
    answer.getAliases.mockResolvedValue([{ text: ['aka'] }]);
    answer.getSources.mockResolvedValue([make('source', ['Paper'])]);
    answer.getCards.mockResolvedValue([
      {
        _id: 'card-1',
        remId: 'answer',
        type: 'forward',
        nextRepetitionTime: 50,
        repetitionHistory: [{ score: 1 }],
      },
    ]);
    answer.getChildrenRem.mockResolvedValue([make('child', ['Child'], 'answer')]);
    const portal = make('portal', ['Table']);
    portal.type = RemType.PORTAL;
    portal.getPortalType.mockResolvedValue(4);
    portal.getPortalDirectlyIncludedRem.mockResolvedValue([answer]);
    portal.getPowerupProperty.mockImplementation(async (code: string, slot: string) => {
      if (code === 'sp' && slot === 'Query') return ['parent:Home'];
      if (code === 'sp' && slot === 'Filter') return ['status:open'];
      return undefined;
    });

    const result = await inspectState(plugin as never, {
      remIds: ['answer', 'portal', 'missing'],
      descendants: 1,
    });

    expect(plugin.rem.findMany).toHaveBeenCalledWith(['answer', 'portal', 'missing']);
    expect(plugin.rem.findOne).not.toHaveBeenCalled();
    expect(answer.isCode).not.toHaveBeenCalled();
    expect(result.complete).toBe(false);
    expect(result.errors).toEqual([
      { id: 'missing', field: 'rem', message: 'Rem missing from exact batch lookup' },
    ]);
    const row = result.rems.find((rem) => rem.id === 'answer')!;
    expect(row.type).toBe('text');
    expect(row.text).toEqual([{ i: 'm', text: 'Question' }]);
    expect(row.elements?.backText.counts).toMatchObject({ code: 1, plain: 0 });
    expect(row.elements?.backText.items).toContainEqual({
      kind: 'code',
      text: 'return 1',
      language: 'python',
    });
    expect(row.markdown).toBe('md:Question');
    expect(row.backMarkdown).toBe('md:return 1');
    expect(row.isCardItem).toBe(true);
    expect(row.hasCardStructure).toBe(true);
    expect(row.practiceDirection).toBe('forward');
    expect(row.enablePractice).toBe(true);
    expect(row.cards?.[0]).toMatchObject({
      id: 'card-1',
      type: 'forward',
      due: 50,
      nextRepetition: 50,
      historyLength: 1,
    });
    expect(row.cards?.[0].hash).toBe(
      await contentHash({
        cardId: 'card-1',
        remId: 'answer',
        type: 'forward',
        history: [{ score: 1 }],
      })
    );
    const sameDue = { ...row.cards![0] };
    answer.getCards.mockResolvedValue([
      {
        _id: 'card-1',
        remId: 'answer',
        type: 'forward',
        nextRepetitionTime: 99,
        repetitionHistory: [{ score: 1 }],
      },
    ]);
    const again = await inspectState(plugin as never, { remIds: ['answer'], fields: ['cards'] });
    expect(again.rems[0].cards?.[0].hash).toBe(sameDue.hash);
    expect(again.rems[0].cards?.[0].due).toBe(99);
    expect(row.tags).toEqual([
      {
        id: 'tag',
        name: 'Code',
        type: 'concept',
        ancestors: [
          { id: 'root', name: 'Home', type: 'folder' },
          { id: 'parent', name: 'Projects', type: 'document' },
        ],
      },
    ]);
    expect(row.parent).toEqual([
      { id: 'root', name: 'Home', type: 'folder' },
      { id: 'parent', name: 'Projects', type: 'document' },
    ]);
    expect(row.children).toEqual(['child']);
    expect(row.aliases).toEqual(['aka']);
    expect(row.sources).toEqual([{ id: 'source', name: 'Paper' }]);
    expect(result.rems.find((rem) => rem.id === 'child')?.text).toEqual(['Child']);
    expect(portal.getPowerupProperty).toHaveBeenCalledWith('sp', 'Query');
    expect(portal.getPowerupProperty).toHaveBeenCalledWith('sp', 'Filter');
    expect(result.rems.find((rem) => rem.id === 'portal')?.portal).toEqual({
      portalType: 'searchPortal',
      portalTypeCode: 4,
      portalTypeRaw: 4,
      includedIds: ['answer'],
      query: ['parent:Home'],
      filter: ['status:open'],
    });
    expect(result.rems.find((rem) => rem.id === 'missing')).toMatchObject({ missing: true });
    const ancestorCalls = plugin.rem.findMany.mock.calls.slice(1).map((call) => call[0]);
    expect(ancestorCalls.flat()).toEqual(expect.arrayContaining(['parent', 'root']));
  });

  it('limits SDK calls to the requested fields and keeps summary off raw text', async () => {
    const { make, plugin } = fixture();
    const rem = make('only', ['Body']);
    rem.getChildrenRem.mockResolvedValue([]);
    await inspectState(plugin as never, { remIds: ['only'], fields: ['children'] });
    expect(rem.getCards).not.toHaveBeenCalled();
    expect(rem.getTagRems).not.toHaveBeenCalled();
    expect(rem.getPowerupProperty).not.toHaveBeenCalled();
    expect(plugin.richText.toMarkdown).not.toHaveBeenCalled();
    const childrenOnly = await inspectState(plugin as never, {
      remIds: ['only'],
      fields: ['children'],
    });
    expect(Object.keys(childrenOnly.rems[0]).sort()).toEqual(['children', 'id']);
    expect(requestedFields({ summary: true }).has('text')).toBe(false);
    expect(requestedFields({ summary: true, fields: ['text'] }).has('text')).toBe(true);
    const summary = await inspectState(plugin as never, { remIds: ['only'], summary: true });
    expect(summary.rems[0]).not.toHaveProperty('text');
    expect(summary.rems[0]).not.toHaveProperty('markdown');
    expect(summary.rems[0].elements?.text.items).toEqual([{ kind: 'plain', text: 'Body' }]);
    expect(plugin.richText.toMarkdown).not.toHaveBeenCalled();
  });

  it('keeps a portal when a slot read fails and stops a descendant walk at maxRems', async () => {
    const { make, plugin } = fixture();
    const portal = make('portal', ['Portal']);
    portal.type = RemType.PORTAL;
    portal.getPortalType.mockResolvedValue(4);
    portal.getPowerupProperty.mockImplementation(async (_code: string, slot: string) => {
      if (slot === 'Filter') throw new Error('powerupSlot parameter: Required');
      return 'query';
    });
    const failed = await inspectState(plugin as never, { remIds: ['portal'], fields: ['portal'] });
    expect(failed.complete).toBe(false);
    expect(failed.rems[0].portal).toMatchObject({
      query: 'query',
      filter: null,
      portalType: 'searchPortal',
      portalTypeRaw: 4,
    });
    expect(failed.rems[0].errors).toEqual([
      { field: 'portal.filter', message: 'powerupSlot parameter: Required' },
    ]);
    expect(failed.errors).toEqual([
      {
        id: 'portal',
        field: 'portal.filter',
        message: 'powerupSlot parameter: Required',
      },
    ]);

    const odd = make('odd-portal', ['Odd']);
    odd.type = RemType.PORTAL;
    odd.getPortalType.mockResolvedValue('embedded-text' as never);
    const unclassified = await inspectState(plugin as never, {
      remIds: ['odd-portal'],
      fields: ['portal'],
    });
    expect(unclassified.complete).toBe(true);
    expect(unclassified.errors).toEqual([]);
    expect(unclassified.rems[0].errors).toBeUndefined();
    expect(unclassified.rems[0].portal).toMatchObject({
      portalType: null,
      portalTypeCode: null,
      portalTypeRaw: 'embedded-text',
    });

    const numbered = make('numbered-portal', ['Numbered']);
    numbered.type = RemType.PORTAL;
    numbered.getPortalType.mockResolvedValue(7 as never);
    const unknownCode = await inspectState(plugin as never, {
      remIds: ['numbered-portal'],
      fields: ['portal'],
    });
    expect(unknownCode.complete).toBe(true);
    expect(unknownCode.errors).toEqual([]);
    expect(unknownCode.rems[0].portal).toMatchObject({
      portalType: null,
      portalTypeCode: null,
      portalTypeRaw: 7,
    });

    const broken = make('broken-portal', ['Broken']);
    broken.type = RemType.PORTAL;
    broken.getPortalType.mockRejectedValue(new Error('sdk down'));
    const failedCall = await inspectState(plugin as never, {
      remIds: ['broken-portal'],
      fields: ['portal'],
    });
    expect(failedCall.complete).toBe(false);
    expect(failedCall.errors).toEqual([
      { id: 'broken-portal', field: 'portal', message: 'sdk down' },
    ]);

    const root = make('root', ['Root']);
    root.getChildrenRem.mockResolvedValue([make('a', ['A'], 'root'), make('b', ['B'], 'root')]);
    const truncated = await inspectState(plugin as never, {
      remIds: ['root'],
      descendants: 1,
      fields: ['children'],
      maxRems: 2,
    });
    expect(truncated.truncated).toBe(true);
    expect(truncated.complete).toBe(false);
    expect(truncated.rems.map((rem) => rem.id)).toEqual(['root', 'a']);
    expect(truncated.errors.map((error) => error.message)).toContain(
      'Stopped because the descendant walk reached the Rem limit'
    );
  });

  it('reuses one ancestor chain for sibling rems and reports a parent cycle', async () => {
    const { make, plugin } = fixture();
    const root = make('root', ['Home']);
    root.isFolder.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(true), 15))
    );
    const ids = ['root'];
    for (let index = 0; index < 24; index += 1) {
      const id = `child-${index}`;
      make(id, [id], 'root');
      ids.push(id);
    }
    const shared = await inspectState(plugin as never, { remIds: ids, fields: ['parent', 'type'] });
    expect(shared.complete).toBe(true);
    expect(shared.errors).toEqual([]);
    expect(shared.rems.find((rem) => rem.id === 'child-0')?.parent).toEqual([
      { id: 'root', name: 'Home', type: 'folder' },
    ]);
    expect(root.isFolder).toHaveBeenCalledTimes(1);

    const cycle = fixture();
    cycle.make('a', ['A'], 'b');
    cycle.make('b', ['B'], 'a');
    const cyclic = await inspectState(cycle.plugin as never, {
      remIds: ['a', 'b'],
      fields: ['parent'],
    });
    expect(cyclic.complete).toBe(false);
    expect(cyclic.errors).toEqual([
      { id: 'a', field: 'parent', message: 'Ancestor cycle' },
      { id: 'b', field: 'parent', message: 'Ancestor cycle' },
    ]);
  });

  it('passes powerup and slot codes through on a single rem read', async () => {
    const calls: unknown[][] = [];
    const plugin = {
      rem: {
        findOne: vi.fn(async (id: string) =>
          id === 'portal'
            ? {
                _id: 'portal',
                getPowerupProperty: vi.fn(async (...args: unknown[]) => {
                  calls.push(args);
                  return ['status:open'];
                }),
                getPowerupPropertyAsRichText: vi.fn(async () => ['rich']),
                getPowerupPropertyAsRem: vi.fn(async () => ({ _id: 'slot-rem' })),
              }
            : undefined
        ),
      },
    };
    await expect(
      getPowerupSlot(plugin as never, { remId: 'portal', powerup: 'sp', slot: 'f' })
    ).resolves.toEqual({
      remId: 'portal',
      powerup: 'sp',
      slot: 'f',
      as: 'value',
      value: ['status:open'],
    });
    expect(builtinSlotName('sp', 'f')).toBe('Filter');
    expect(builtinSlotName('sp', 'Filter')).toBe('Filter');
    expect(builtinSlotName('sp', 'q')).toBe('Query');
    expect(builtinSlotName('custom', 'message')).toBe('message');
    expect(builtinSlotName('sp', 'not-a-slot')).toBe('not-a-slot');
    expect(calls).toEqual([['sp', 'Filter']]);
    await getPowerupSlot(plugin as never, {
      remId: 'portal',
      powerup: 'sp',
      slot: 'not-a-slot',
    });
    expect(calls.at(-1)).toEqual(['sp', 'not-a-slot']);
    await expect(
      getPowerupSlot(plugin as never, { remId: 'missing', powerup: 'sp', slot: 'q' })
    ).rejects.toThrow('Rem not found: missing');
  });

  it('reads rems with bounded concurrency and serializes each rem once for the size cap', async () => {
    const { make, plugin } = fixture();
    let active = 0;
    let maxActive = 0;
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ids: string[] = [];
    for (let index = 0; index < INSPECT_CONCURRENCY * 2; index += 1) {
      const id = `rem-${index}`;
      ids.push(id);
      const rem = make(id, [id]);
      rem.getChildrenRem.mockImplementation(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        started += 1;
        if (started === INSPECT_CONCURRENCY) release();
        await gate;
        active -= 1;
        return [];
      });
    }
    const result = await inspectState(plugin as never, { remIds: ids, fields: ['children'] });
    expect(result.rems).toHaveLength(ids.length);
    expect(maxActive).toBe(INSPECT_CONCURRENCY);

    const stringify = JSON.stringify;
    const arrayLengths: number[] = [];
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value: unknown) => {
      if (Array.isArray(value)) arrayLengths.push(value.length);
      return stringify(value);
    });
    const wide = fixture();
    const many = Array.from({ length: 12 }, (_, index) => {
      const id = `row-${index}`;
      wide.make(id, [id]);
      return id;
    });
    await inspectState(wide.plugin as never, { remIds: many, fields: ['children'] });
    expect(arrayLengths.filter((length) => length > 1)).toEqual([]);
    spy.mockRestore();

    const heavy = fixture();
    heavy.make('big', ['x'.repeat(700_000)]);
    heavy.make('next', ['y'.repeat(700_000)]);
    const truncated = await inspectState(heavy.plugin as never, {
      remIds: ['big', 'next'],
      fields: ['text'],
    });
    expect(truncated.truncated).toBe(true);
    expect(truncated.complete).toBe(false);
    expect(truncated.rems.map((rem) => rem.id)).toEqual(['big']);
    expect(truncated.errors[0]?.message).toMatch(/1 MB/);
  });
});
