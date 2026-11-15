import { describe, expect, it, vi } from 'vitest';
import type { ReactRNPlugin } from '@remnote/plugin-sdk';
import { SdkWorkspaceBackend } from '../../../src/business/workspace/sdk-backend.js';
import { remoteEditedAt } from '../../../src/business/workspace/snapshots.js';
import type { WorkspaceRem } from '../../../src/business/workspace/types.js';
import { mapReads } from '../../../src/business/workspace/read-pool.js';
import { isReferencePortal } from '../../../src/business/workspace/reference-projection.js';

function fixture(count = 2) {
  const objects = new Map<string, Record<string, unknown>>();
  const flags = new Map<string, Record<string, ReturnType<typeof vi.fn>>>();
  for (let i = 0; i < count; i++) {
    const id = `r${i}`,
      object: Record<string, unknown> = {
        _id: id,
        parent: i === 0 ? null : 'r0',
        children: i === 0 ? Array.from({ length: count - 1 }, (_, n) => `r${n + 1}`) : [],
        text: [id],
      };
    const methods: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const name of [
      'isDocument',
      'isFolder',
      'isCardItem',
      'isTable',
      'isProperty',
      'isPowerup',
      'isPowerupSlot',
      'isPowerupProperty',
      'isPowerupEnum',
      'isPowerupPropertyListItem',
    ])
      methods[name] = vi.fn(async () => false);
    Object.assign(methods, {
      getPracticeDirection: vi.fn(async () => 'forward'),
      getEnablePractice: vi.fn(async () => true),
      getCards: vi.fn(async () => []),
      getPortalType: vi.fn(async () => 0),
      getPortalDirectlyIncludedRem: vi.fn(async () => []),
      getTagRems: vi.fn(async () => []),
      setText: vi.fn(async (value) => {
        object.text = value;
      }),
      setBackText: vi.fn(async (value) => {
        object.backText = value;
      }),
      setParent: vi.fn(async (value) => {
        object.parent = value;
      }),
      setIsCardItem: vi.fn(async () => {}),
      remove: vi.fn(async () => {
        objects.delete(id);
      }),
    });
    for (const [name, value] of Object.entries(methods))
      Object.defineProperty(object, name, { value });
    objects.set(id, object);
    flags.set(id, methods);
  }
  const findMany = vi.fn(async (ids: string[]) =>
    ids.flatMap((id) => (objects.has(id) ? [objects.get(id)!] : []))
  );
  const plugin = {
    rem: {
      getAll: vi.fn(async () => [...objects.values()]),
      findMany,
      findOne: vi.fn(async (id: string) => objects.get(id)),
    },
    kb: { getCurrentKnowledgeBaseData: vi.fn(async () => ({ _id: 'kb' })) },
  };
  const status = vi.fn(async () => ({ kbId: 'kb', writable: true, destructive: true }));
  const backend = new SdkWorkspaceBackend(
    plugin as unknown as ReactRNPlugin,
    { getLocal: async () => undefined, setLocal: async () => {} },
    status
  );
  return { backend, plugin, findMany, objects, flags, status };
}

async function readCardHistory(repetitionHistory: unknown) {
  const f = fixture();
  f.flags
    .get('r1')!
    .getCards!.mockResolvedValue([
      { _id: 'synthetic-card', remId: 'r1', type: 'forward', createdAt: 1, repetitionHistory },
    ]);
  return (await f.backend.read(['r1']))[0]!.cards![0]!.repetitionHistory;
}

describe('public SDK sync adapter', () => {
  it('reads fresh portal subtype and direct membership only for native portal Rems', async () => {
    const f = fixture();
    f.objects.get('r0')!.type = 6;
    const methods = f.flags.get('r0')!;
    methods.getPortalType!.mockResolvedValue(4);
    methods.getPortalDirectlyIncludedRem!.mockResolvedValue([{ _id: 'r1' }]);
    const first = (await f.backend.read(['r0', 'r1']))[0]!;
    expect(first.portal).toEqual({ type: 4, directlyIncludedRemIds: ['r1'] });
    expect(isReferencePortal(first)).toBe(true);
    expect(f.flags.get('r1')!.getPortalType).not.toHaveBeenCalled();
    expect(f.flags.get('r1')!.getPortalDirectlyIncludedRem).not.toHaveBeenCalled();
    methods.getPortalType!.mockResolvedValue(99);
    methods.getPortalDirectlyIncludedRem!.mockResolvedValue([]);
    const next = (await f.backend.read(['r0']))[0]!;
    expect(next.portal).toEqual({ type: 99, directlyIncludedRemIds: [] });
    expect(isReferencePortal(next)).toBe(false);
    expect(methods.getPortalType).toHaveBeenCalledTimes(2);
  });

  it.each([null, undefined])(
    'preserves an observed nullish portal subtype without classifying it: %s',
    async (type) => {
      const f = fixture();
      f.objects.get('r1')!.type = 6;
      f.flags.get('r1')!.getPortalType!.mockResolvedValue(type);
      f.flags.get('r1')!.getPortalDirectlyIncludedRem!.mockResolvedValue([{ _id: 'r0' }]);
      const rem = (await f.backend.read(['r1']))[0]!;
      expect(rem.portal).toEqual({ type: null, directlyIncludedRemIds: ['r0'] });
      expect(isReferencePortal(rem)).toBe(false);
    }
  );

  it.each([
    { type: undefined, members: undefined },
    { type: '4', members: [] },
    { type: 1.5, members: [] },
    { type: Infinity, members: [] },
    { type: 4, members: null },
    { type: 4, members: [{ _id: 'r1' }, { _id: 'r1' }] },
    { type: 4, members: [{}] },
  ])('rejects incomplete or ambiguous portal facts: %j', async ({ type, members }) => {
    const f = fixture();
    f.objects.get('r0')!.type = 6;
    f.flags.get('r0')!.getPortalType!.mockResolvedValue(type);
    f.flags.get('r0')!.getPortalDirectlyIncludedRem!.mockResolvedValue(members);
    await expect(f.backend.read(['r0'])).rejects.toThrow();
  });

  it('reports malformed portal value shapes without subtype content', async () => {
    const f = fixture();
    f.objects.get('r0')!.type = 6;
    f.flags.get('r0')!.getPortalType!.mockResolvedValue('synthetic unclassified subtype');
    f.flags.get('r0')!.getPortalDirectlyIncludedRem!.mockResolvedValue(undefined);
    await expect(f.backend.read(['r0'])).rejects.toThrow(
      /^Incomplete native portal membership for r0: subtype=string, integer=false, members=undefined$/
    );
  });

  it('drains a portal membership read before reporting a sibling portal failure', async () => {
    const f = fixture();
    f.objects.get('r0')!.type = 6;
    let release!: () => void, started!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invoked = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.flags.get('r0')!.getPortalType!.mockRejectedValue(new Error('portal unavailable'));
    f.flags.get('r0')!.getPortalDirectlyIncludedRem!.mockImplementation(async () => {
      started();
      await pending;
      return [];
    });
    let finished = false;
    const result = f.backend.read(['r0']).finally(() => {
      finished = true;
    });
    const rejected = expect(result).rejects.toThrow('portal unavailable');
    await invoked;
    expect(finished).toBe(false);
    release();
    await rejected;
    expect(finished).toBe(true);
  });

  it('returns requested identity order even when findMany returns shuffled results', async () => {
    const f = fixture();
    f.findMany.mockImplementation(async (ids) => ids.map((id) => f.objects.get(id)!).reverse());
    expect((await f.backend.read(['r0', 'r1'])).map((rem) => rem.id)).toEqual(['r0', 'r1']);
    expect((await f.backend.readPublic(['r0', 'r1'])).map((rem) => rem.id)).toEqual(['r0', 'r1']);
    expect((await f.backend.discover(['r0', 'r1'])).snapshots.map((rem) => rem.id)).toEqual([
      'r0',
      'r1',
    ]);
  });

  it('bounds four concurrent full batches to 16 snapshots and 192 in-flight native flags', async () => {
    const f = fixture(200);
    let active = 0,
      peak = 0;
    for (const methods of f.flags.values()) {
      for (const name of [
        'isDocument',
        'isFolder',
        'isCardItem',
        'isTable',
        'isProperty',
        'isPowerup',
        'isPowerupSlot',
        'isPowerupProperty',
        'isPowerupEnum',
        'isPowerupPropertyListItem',
        'getPracticeDirection',
        'getEnablePractice',
      ]) {
        methods[name]!.mockImplementation(async () => {
          active++;
          peak = Math.max(peak, active);
          await Promise.resolve();
          active--;
          return name === 'getPracticeDirection' ? 'forward' : name === 'getEnablePractice';
        });
      }
    }
    const ids = [...f.objects.keys()];
    const batches = Array.from({ length: 4 }, (_, i) => ids.slice(i * 50, i * 50 + 50));
    const result = await mapReads(batches, 4, (batch) => f.backend.read(batch));
    expect(result.flat().map((rem) => rem.id)).toEqual(ids);
    expect(peak).toBe(192);
    expect(active).toBe(0);
  });

  it('does not return from a failed native batch until outstanding flag reads have drained', async () => {
    const f = fixture(10);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.flags.get('r0')!.isDocument!.mockRejectedValue(new Error('native flag lost'));
    f.flags.get('r0')!.isFolder!.mockImplementation(async () => {
      await pending;
      return false;
    });
    let finished = false;
    const result = f.backend.read([...f.objects.keys()]).finally(() => {
      finished = true;
    });
    const rejected = expect(result).rejects.toThrow('native flag lost');
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await rejected;
    expect(finished).toBe(true);
    const calls = [...f.flags.values()].map((methods) => methods.isDocument!.mock.calls.length);
    await Promise.resolve();
    expect([...f.flags.values()].map((methods) => methods.isDocument!.mock.calls.length)).toEqual(
      calls
    );
  });

  it('discovers an exact subtree through bounded public snapshots without getAll', async () => {
    const f = fixture(52),
      rems = await f.backend.subtree(['r0']);
    expect(rems).toHaveLength(52);
    expect(f.plugin.rem.getAll).not.toHaveBeenCalled();
    expect(f.findMany.mock.calls.map(([ids]) => ids.length)).toEqual([1, 50, 1]);
    expect(rems[0]).toMatchObject({
      id: 'r0',
      type: null,
      backText: null,
      cardItem: false,
      practice: 'forward',
    });
  });
  it('uses only two native layout flags per node during full official discovery', async () => {
    const f = fixture(51),
      ids = [...f.objects.keys()],
      result = await f.backend.discover(ids);
    expect(f.findMany.mock.calls.map(([batch]) => batch.length)).toEqual([50, 1]);
    expect(result.snapshots).toHaveLength(51);
    expect(result.snapshots[0]).toMatchObject({ $type: 'rem', id: 'r0' });
    for (const methods of f.flags.values()) {
      expect(methods.isDocument).toHaveBeenCalledTimes(1);
      expect(methods.isFolder).toHaveBeenCalledTimes(1);
      expect(methods.isTable).not.toHaveBeenCalled();
      expect(methods.isCardItem).not.toHaveBeenCalled();
    }
    expect(result.flags.r0).toEqual({
      document: false,
      folder: false,
      unsupported: 'unverified-native-flags',
    });
  });
  it('reads exact public snapshots without native getters and retains unknown fields and explicit undefined', async () => {
    const f = fixture();
    Object.assign(f.objects.get('r0')!, {
      updatedAt: 9,
      future: { nested: [null, true] },
      backText: undefined,
    });
    const snapshots = await f.backend.readPublic(['r0', 'missing']);
    expect(snapshots).toEqual([
      expect.objectContaining({
        $type: 'rem',
        id: 'r0',
        updatedAt: 9,
        future: { nested: [null, true] },
        backText: { $type: 'undefined' },
      }),
    ]);
    expect(f.flags.get('r0')!.isDocument).not.toHaveBeenCalled();
    expect(f.flags.get('r0')!.getCards).not.toHaveBeenCalled();
    await expect(f.backend.readPublic(['r0', 'r0'])).rejects.toThrow('repeats');
    await expect(
      f.backend.readPublic(Array.from({ length: 51 }, (_, index) => `x${index}`))
    ).rejects.toThrow('50');
  });
  it('does not interpret compressed private fields or arrival timestamps as edit timestamps', () => {
    expect(
      remoteEditedAt({ public: { u: 100, localUpdatedAt: 200 } } as unknown as WorkspaceRem)
    ).toBeNull();
    expect(
      remoteEditedAt({ public: { updatedAt: { $type: 'undefined' } } } as unknown as WorkspaceRem)
    ).toBeNull();
    expect(remoteEditedAt({ public: { updatedAt: 100 } } as unknown as WorkspaceRem)).toBe(100);
  });
  it('preserves empty-array question backText and string future types instead of normalizing them away', async () => {
    const f = fixture();
    f.objects.get('r0')!.backText = [];
    f.objects.get('r1')!.type = 'future';
    const rems = await f.backend.read(['r0', 'r1']);
    expect(rems[0]).toMatchObject({ backText: [], cardItem: false });
    expect(rems[1]!.type).toBe('future');
  });
  it('omits undefined object properties in Card history without changing defined values or review order', async () => {
    const nested = Object.freeze({ omitted: undefined, kept: 'future-value' }),
      latest = Object.freeze({
        date: 20,
        score: 1,
        responseTime: 0,
        isCram: false,
        explanation: '',
        schedulerMetadata: { interval: 0, optional: undefined },
        forceNextRevealDate: null,
        forceEase: 0,
        pluginData: { future: ['', false, 0, null, nested], optional: undefined },
        futureField: { retained: true },
      }),
      earlier = Object.freeze({
        date: 10,
        score: 2,
        responseTime: undefined,
        explanation: undefined,
        schedulerMetadata: undefined,
        forceNextRevealDate: undefined,
        forceEase: undefined,
      }),
      history = Object.freeze([latest, earlier]);

    expect(await readCardHistory(history)).toStrictEqual([
      {
        date: 20,
        score: 1,
        responseTime: 0,
        isCram: false,
        explanation: '',
        schedulerMetadata: { interval: 0 },
        forceNextRevealDate: null,
        forceEase: 0,
        pluginData: { future: ['', false, 0, null, { kept: 'future-value' }] },
        futureField: { retained: true },
      },
      { date: 10, score: 2 },
    ]);
    expect(earlier).toHaveProperty('explanation', undefined);
    expect(latest.schedulerMetadata).toHaveProperty('optional', undefined);
    expect(nested).toHaveProperty('omitted', undefined);
    expect(history).toStrictEqual([latest, earlier]);
  });
  it('keeps special JSON keys as data without prototype pollution', async () => {
    const data = Object.fromEntries([
        ['__proto__', { polluted: 'data-only', optional: undefined }],
        ['constructor', { prototype: { polluted: 'data-only' } }],
        ['prototype', { kept: true }],
      ]),
      history = await readCardHistory([{ date: 1, score: 1, pluginData: data }]),
      result = (history![0] as { pluginData: Record<string, unknown> }).pluginData;

    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(result.__proto__).toStrictEqual({ polluted: 'data-only' });
    expect(result.constructor).toStrictEqual({ prototype: { polluted: 'data-only' } });
    expect(result.prototype).toStrictEqual({ kept: true });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });
  it('normalizes null-prototype history objects without dropping their defined fields', async () => {
    const data: Record<string, unknown> = Object.create(null);
    data.kept = { value: false, optional: undefined };
    data.optional = undefined;
    expect(await readCardHistory([{ date: 1, score: 1, pluginData: data }])).toStrictEqual([
      { date: 1, score: 1, pluginData: { kept: { value: false } } },
    ]);
    expect(Object.hasOwn(data, 'optional')).toBe(true);
    expect(Object.getPrototypeOf(data)).toBeNull();
  });
  it.each([
    { label: 'absent', history: undefined, expected: null },
    { label: 'null', history: null, expected: null },
    { label: 'empty', history: [], expected: [] },
  ])('preserves $label Card history', async ({ history, expected }) => {
    expect(await readCardHistory(history)).toStrictEqual(expected);
  });
  it.each([
    { label: 'Date', value: new Date(0) },
    { label: 'class instance', value: new (class Future {})() },
    {
      label: 'custom prototype',
      value: Object.assign(Object.create({ inherited: 1 }), { own: 2 }),
    },
  ])('rejects $label objects in Card history', async ({ value }) => {
    await expect(readCardHistory([{ future: value }])).rejects.toThrow(TypeError);
  });
  it.each([
    { label: 'undefined history entry', history: [undefined] },
    { label: 'sparse history', history: new Array(1) },
    { label: 'nested undefined array entry', history: [{ future: [undefined] }] },
    { label: 'nested sparse array', history: [{ future: new Array(1) }] },
    { label: 'function', history: [{ future: () => 1 }] },
    { label: 'symbol', history: [{ future: Symbol('invalid') }] },
    { label: 'bigint', history: [{ future: 1n }] },
    { label: 'NaN', history: [{ future: Number.NaN }] },
    { label: 'infinity', history: [{ future: Number.POSITIVE_INFINITY }] },
    {
      label: 'non-JSON special key value',
      history: [{ future: Object.fromEntries([['__proto__', 1n]]) }],
    },
  ])('rejects $label instead of silently rewriting Card history', async ({ history }) => {
    await expect(readCardHistory(history)).rejects.toMatchObject({ name: 'ZodError' });
  });
  it('fails closed on missing/duplicate IDs or missing public child arrays', async () => {
    const f = fixture();
    await expect(f.backend.read(['missing'])).rejects.toThrow('Incomplete');
    delete f.objects.get('r0')!.children;
    await expect(f.backend.subtree(['r0'])).rejects.toThrow('Incomplete');
    f.findMany.mockResolvedValue([f.objects.get('r1')!, f.objects.get('r1')!]);
    await expect(f.backend.discover(['r0', 'r1'])).rejects.toThrow('Incomplete');
  });
  it('requires exact live KB and both destructive gates before mutation', async () => {
    const f = fixture();
    f.status.mockResolvedValue({ kbId: 'wrong', writable: true, destructive: true });
    await expect(f.backend.writeField('r1', 'text', ['x'])).rejects.toThrow('KB');
    expect(f.flags.get('r1')!.setText).not.toHaveBeenCalled();
    f.status.mockResolvedValue({ kbId: 'kb', writable: true, destructive: false });
    await expect(f.backend.remove('r1')).rejects.toThrow('gates');
    expect(f.flags.get('r1')!.remove).not.toHaveBeenCalled();
  });
  it('guards immutable flags, tags and Card identities without treating review history as content', async () => {
    const f = fixture(),
      methods = f.flags.get('r1')!;
    methods.getCards!.mockResolvedValue([
      {
        _id: 'card',
        remId: 'r1',
        type: 'forward',
        createdAt: 1,
        repetitionHistory: [{ time: 7 }],
        timesWrongInRow: 0,
      },
    ]);
    const before = await f.backend.guard(['r1']);
    await f.backend.writeField('r1', 'text', ['Updated']);
    expect(await f.backend.guard(['r1'])).toBe(before);
    methods.getCards!.mockResolvedValue([
      {
        _id: 'card',
        remId: 'r1',
        type: 'forward',
        createdAt: 1,
        repetitionHistory: [{ time: 8 }],
        timesWrongInRow: 0,
      },
    ]);
    expect(await f.backend.guard(['r1'])).toBe(before);
    methods.getCards!.mockResolvedValue([
      { _id: 'different-card', remId: 'r1', type: 'forward', createdAt: 2 },
    ]);
    expect(await f.backend.guard(['r1'])).not.toBe(before);
  });
});
