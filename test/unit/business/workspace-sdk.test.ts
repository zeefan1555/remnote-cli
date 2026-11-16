import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReactRNPlugin } from '@remnote/plugin-sdk';
import { SdkWorkspaceBackend } from '../../../src/business/workspace/sdk-backend.js';
import { remoteEditedAt } from '../../../src/business/workspace/snapshots.js';
import type { WorkspaceRem } from '../../../src/business/workspace/types.js';
import { mapReads } from '../../../src/business/workspace/read-pool.js';
import { isReferencePortal } from '../../../src/business/workspace/reference-projection.js';
import {
  importWorkspace,
  pushWorkspace,
  readWorkspace,
  saveWorkspace,
} from '../../../src/business/workspace/workspace.js';
import { loadState, localStore } from '../../../src/business/workspace/local.js';
import { readPrivate } from '../../../src/business/workspace/files.js';
import type { Journal } from '../../../src/business/workspace/resume.js';

function fixture(count = 2) {
  const objects = new Map<string, Record<string, unknown>>();
  const entityChildren = new Map<string, string[]>();
  const flags = new Map<string, Record<string, ReturnType<typeof vi.fn>>>();
  for (let i = 0; i < count; i++) {
    const id = `r${i}`,
      object: Record<string, unknown> = {
        _id: id,
        parent: i === 0 ? null : 'r0',
        children: i === 0 ? Array.from({ length: count - 1 }, (_, n) => `r${n + 1}`) : [],
        text: [id],
      };
    entityChildren.set(id, [...(object.children as string[])]);
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
      getChildrenRem: vi.fn(async () => entityChildren.get(id)!.map((child) => objects.get(child))),
      getPracticeDirection: vi.fn(async () => 'forward'),
      getEnablePractice: vi.fn(async () => true),
      getCards: vi.fn(async () => []),
      getPortalType: vi.fn(async () => 0),
      getPortalDirectlyIncludedRem: vi.fn(async () => []),
      getTagRems: vi.fn(async () => []),
      addTag: vi.fn(async () => {}),
      removeTag: vi.fn(async () => {}),
      addPowerup: vi.fn(async () => {}),
      hasPowerup: vi.fn(async () => false),
      getPowerupProperty: vi.fn(async () => undefined),
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
  return { backend, plugin, findMany, objects, entityChildren, flags, status };
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
  it('uses exact tag IDs and preserves properties on removal behind both existing destructive gates', async () => {
    const f = fixture();
    await f.backend.addTag('r1', 'r0');
    expect(f.flags.get('r1')!.addTag).toHaveBeenCalledWith('r0');
    await f.backend.removeTag('r1', 'r0');
    expect(f.flags.get('r1')!.removeTag).toHaveBeenCalledWith('r0', false);
    f.status.mockResolvedValue({ kbId: 'kb', writable: true, destructive: false });
    await expect(f.backend.removeTag('r1', 'r0')).rejects.toThrow(/destructive|gate/i);
    expect(f.flags.get('r1')!.removeTag).toHaveBeenCalledTimes(1);
  });
  it('uses cc SDK capability and reads explicit hasPowerup facts even on the cheap probe path', async () => {
    const f = fixture();
    await f.backend.setCardCluster('r1');
    expect(f.flags.get('r1')!.addPowerup).toHaveBeenCalledWith('cc');
    f.flags.get('r1')!.hasPowerup!.mockResolvedValue(true);
    expect(await f.backend.readProbe(['r1'], { powerupCodes: { r1: ['cc'] } })).toMatchObject([
      { powerupPresence: { cc: true } },
    ]);
    expect(f.flags.get('r1')!.getCards).not.toHaveBeenCalled();
    expect((await f.backend.read(['r1'], { powerupCodes: { r1: ['cc'] } }))[0]).toMatchObject({
      powerupPresence: { cc: true },
    });
    f.flags.get('r1')!.hasPowerup!.mockResolvedValue(undefined);
    await expect(f.backend.readProbe(['r1'], { powerupCodes: { r1: ['cc'] } })).rejects.toThrow();
  });
  it('probes exact public content and direct tags without native flags or cards', async () => {
    const f = fixture();
    f.flags.get('r1')!.getTagRems!.mockResolvedValue([{ _id: 'tag' }]);
    const result = await f.backend.readProbe(['r0', 'r1']);
    expect(result.map((row) => [row.snapshot.id, row.tags])).toEqual([
      ['r0', []],
      ['r1', ['tag']],
    ]);
    expect(f.findMany).toHaveBeenCalledTimes(1);
    for (const methods of f.flags.values()) {
      expect(methods.getCards).not.toHaveBeenCalled();
      expect(methods.isDocument).not.toHaveBeenCalled();
      expect(methods.getTagRems).toHaveBeenCalledTimes(1);
    }
  });
  it('collects exact tags only when requested for resume verification', async () => {
    const f = fixture(),
      tags = f.flags.get('r1')!.getTagRems!;
    tags.mockResolvedValue([{ _id: 'tag-b' }, { _id: 'tag-a' }]);
    expect((await f.backend.read(['r1']))[0]!.tags).toBeUndefined();
    expect(tags).not.toHaveBeenCalled();
    expect((await f.backend.read(['r1'], { tags: true }))[0]!.tags).toEqual(['tag-a', 'tag-b']);
    tags.mockResolvedValue([{ _id: 'tag' }, { _id: 'tag' }]);
    await expect(f.backend.read(['r1'], { tags: true })).rejects.toThrow('Duplicate native tags');
    tags.mockResolvedValue(undefined);
    await expect(f.backend.read(['r1'], { tags: true })).rejects.toThrow('Incomplete native tags');
  });
  it('reads fresh portal subtype and direct membership only for native portal Rems', async () => {
    const f = fixture();
    f.objects.get('r0')!.type = 6;
    const methods = f.flags.get('r0')!;
    methods.getPortalType!.mockResolvedValue(4);
    methods.getPortalDirectlyIncludedRem!.mockResolvedValue([{ _id: 'r1' }]);
    const first = (await f.backend.read(['r0', 'r1']))[0]!;
    expect(first.portal).toEqual({
      type: 4,
      directlyIncludedRemIds: ['r1'],
      query: null,
      filter: null,
    });
    expect(isReferencePortal(first)).toBe(true);
    expect(f.flags.get('r1')!.getPortalType).not.toHaveBeenCalled();
    expect(f.flags.get('r1')!.getPortalDirectlyIncludedRem).not.toHaveBeenCalled();
    methods.getPortalType!.mockResolvedValue(99);
    methods.getPortalDirectlyIncludedRem!.mockResolvedValue([]);
    const next = (await f.backend.read(['r0']))[0]!;
    expect(next.portal).toEqual({
      type: 99,
      directlyIncludedRemIds: [],
      query: null,
      filter: null,
    });
    expect(isReferencePortal(next)).toBe(false);
    expect(methods.getPortalType).toHaveBeenCalledTimes(2);
  });
  it('reads search Portal query/filter through public slots and refuses incomplete query reads', async () => {
    const f = fixture(),
      methods = f.flags.get('r0')!;
    f.objects.get('r0')!.type = 6;
    methods.hasPowerup!.mockResolvedValue(true);
    methods.getPowerupProperty!.mockImplementation(async (_code, slot) =>
      slot === 'Query' ? '{"search":"native"}' : 'filter'
    );
    expect((await f.backend.read(['r0']))[0]!.portal).toMatchObject({
      query: '{"search":"native"}',
      filter: 'filter',
    });
    expect(methods.getPowerupProperty).toHaveBeenCalledWith('sp', 'Query');
    expect(methods.getPowerupProperty).toHaveBeenCalledWith('sp', 'Filter');
    methods.getPowerupProperty!.mockRejectedValue(new Error('query inaccessible'));
    await expect(f.backend.read(['r0'])).rejects.toThrow('query inaccessible');
  });

  it.each([null, undefined])(
    'preserves an observed nullish portal subtype without classifying it: %s',
    async (type) => {
      const f = fixture();
      f.objects.get('r1')!.type = 6;
      f.flags.get('r1')!.getPortalType!.mockResolvedValue(type);
      f.flags.get('r1')!.getPortalDirectlyIncludedRem!.mockResolvedValue([{ _id: 'r0' }]);
      const rem = (await f.backend.read(['r1']))[0]!;
      expect(rem.portal).toEqual({
        type: null,
        directlyIncludedRemIds: ['r0'],
        query: null,
        filter: null,
      });
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

  it('bounds two concurrent full batches to eight snapshots and 32 in-flight native flags', async () => {
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
    const result = await mapReads(batches, 2, (batch) => f.backend.read(batch));
    expect(result.flat().map((rem) => rem.id)).toEqual(ids);
    expect(peak).toBe(32);
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
  it('reads exact public snapshots without flags/cards and retains unknown fields and explicit undefined', async () => {
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
  it('fails closed on missing/duplicate IDs or malformed public child arrays', async () => {
    const f = fixture();
    await expect(f.backend.read(['missing'])).rejects.toThrow('Incomplete');
    f.objects.get('r0')!.children = null;
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

type Fixture = ReturnType<typeof fixture>;
const observations = {
  read: (f: Fixture) => f.backend.read(['r0']),
  public: (f: Fixture) => f.backend.readPublic(['r0']),
  probe: (f: Fixture) => f.backend.readProbe(['r0']),
  discover: (f: Fixture) => f.backend.discover(['r0']),
  subtree: (f: Fixture) => f.backend.subtree(['r0']),
  enumerate: (f: Fixture) => f.backend.enumerate(),
  guard: (f: Fixture) => f.backend.guard(['r0']),
};

describe('authoritative native entity children', () => {
  it.each([[], undefined, ['r1', 'r3']].map((declared) => ({ declared })))(
    'retains the full entity order when public children omit entries: $declared',
    async ({ declared }) => {
      const f = fixture(4);
      f.objects.get('r0')!.children = declared;
      f.objects.get('r2')!.type = 6;
      const expected = ['r1', 'r2', 'r3'];
      expect((await f.backend.read(['r0']))[0]).toMatchObject({
        children: expected,
        public: { children: expected },
      });
      expect((await f.backend.readPublic(['r0']))[0]!.children).toEqual(expected);
      expect((await f.backend.readProbe(['r0']))[0]!.snapshot.children).toEqual(expected);
      expect((await f.backend.discover(['r0'])).snapshots[0]!.children).toEqual(expected);
      expect((await f.backend.enumerate())[0]!.children).toEqual(expected);
      expect((await f.backend.subtree(['r0'])).map((rem) => rem.id)).toEqual(['r0', ...expected]);
      await f.backend.guard(['r0']);
      expect(f.flags.get('r0')!.getChildrenRem).toHaveBeenCalledTimes(7);
      expect(f.objects.get('r0')!.children).toEqual(declared);
    }
  );

  for (const [name, observe] of Object.entries(observations)) {
    it.each([
      { label: 'undefined entity result', actual: undefined },
      { label: 'null entity result', actual: null },
      { label: 'non-array entity result', actual: {} },
      { label: 'null entity', actual: [null] },
      { label: 'missing ID', actual: [{ parent: 'r0' }] },
      { label: 'invalid ID', actual: [{ _id: 'bad/id', parent: 'r0' }] },
      { label: 'empty ID', actual: [{ _id: '', parent: 'r0' }] },
      { label: 'unknown parent', actual: [{ _id: 'r1' }] },
      { label: 'foreign parent', actual: [{ _id: 'r1', parent: 'foreign' }] },
      { label: 'null parent', actual: [{ _id: 'r1', parent: null }] },
      { label: 'self child', actual: [{ _id: 'r0', parent: 'r0' }] },
      {
        label: 'duplicate entity',
        actual: [
          { _id: 'r1', parent: 'r0' },
          { _id: 'r1', parent: 'r0' },
        ],
      },
      { label: 'sparse entity result', actual: new Array(1) },
    ])(`${name} rejects $label, never falling back to an empty public list`, async ({ actual }) => {
      const f = fixture();
      f.objects.get('r0')!.children = [];
      f.flags.get('r0')!.getChildrenRem!.mockResolvedValue(actual);
      await expect(observe(f)).rejects.toThrow();
    });
    it.each(
      [null, {}, ['r1', 'r1'], ['bad/id'], new Array(1), ['missing'], ['r2', 'r1']].map(
        (declared) => ({ declared })
      )
    )(
      `${name} rejects malformed, omitted or reordered declared children: $declared`,
      async ({ declared }) => {
        const f = fixture(3);
        f.objects.get('r0')!.children = declared;
        await expect(observe(f)).rejects.toThrow();
      }
    );
    it(`${name} propagates an entity read error without using public children`, async () => {
      const f = fixture();
      f.flags.get('r0')!.getChildrenRem!.mockRejectedValue(new Error('entity read unavailable'));
      await expect(observe(f)).rejects.toThrow('entity read unavailable');
    });
  }

  it('retains the cheap path and its exact-ID batch limit with stale public children', async () => {
    const f = fixture(52);
    f.objects.get('r0')!.children = [];
    const ids = [...f.objects.keys()].slice(0, 50);
    expect((await f.backend.readProbe(ids))[0]!.snapshot.children).toHaveLength(51);
    expect(f.findMany.mock.calls.map(([batch]) => batch.length)).toEqual([50]);
    for (const methods of f.flags.values()) {
      expect(methods.getCards).not.toHaveBeenCalled();
      expect(methods.isDocument).not.toHaveBeenCalled();
      expect(methods.isCardItem).not.toHaveBeenCalled();
    }
    await expect(f.backend.readProbe([...f.objects.keys()])).rejects.toThrow('50');
    expect(f.findMany).toHaveBeenCalledTimes(1);
    expect((await f.backend.subtree(['r0'])).map((rem) => rem.id)).toEqual([...f.objects.keys()]);
    expect(f.findMany.mock.calls.slice(1).map(([batch]) => batch.length)).toEqual([1, 50, 1]);
  });

  it('drains sibling entity reads before reporting a failed probe batch', async () => {
    const f = fixture();
    let release!: () => void, started!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invoked = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.flags.get('r0')!.getChildrenRem!.mockRejectedValue(new Error('entity read unavailable'));
    f.flags.get('r1')!.getChildrenRem!.mockImplementation(async () => {
      started();
      await pending;
      return [];
    });
    let finished = false;
    const result = f.backend.readProbe(['r0', 'r1']).finally(() => {
      finished = true;
    });
    const rejected = expect(result).rejects.toThrow('entity read unavailable');
    await invoked;
    expect(finished).toBe(false);
    release();
    await rejected;
    expect(finished).toBe(true);
  });
});

describe('entity structure sync gates through the actual SDK backend', () => {
  let temporary: string | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (temporary) await rm(temporary, { recursive: true, force: true });
    temporary = undefined;
  });

  async function imported() {
    temporary = await realpath(await mkdtemp(join(tmpdir(), 'remnote-entity-children-test-')));
    vi.stubEnv('REMNOTE_CLI_CONFIG', join(temporary, 'config', 'connection.json'));
    const directory = join(temporary, 'vault'),
      f = fixture(5);
    f.flags.get('r0')!.isDocument!.mockResolvedValue(true);
    f.objects.get('r0')!.children = ['r1', 'r2'];
    f.entityChildren.set('r0', ['r1', 'r2']);
    await importWorkspace(directory, 'kb', async () => f.backend, { rootId: 'r0' });
    for (const methods of f.flags.values())
      for (const method of Object.values(methods)) method.mockClear();
    const apply = (options: Record<string, unknown> = {}) =>
      pushWorkspace(directory, async () => f.backend, {
        apply: true,
        paths: ['r0.md'],
        ...options,
      });
    return { ...f, directory, apply };
  }

  it('bounds default changed publication and later probes without narrowing initial discovery', async () => {
    temporary = await realpath(await mkdtemp(join(tmpdir(), 'remnote-publication-N200-')));
    vi.stubEnv('REMNOTE_CLI_CONFIG', join(temporary, 'config', 'connection.json'));
    const directory = join(temporary, 'vault'),
      f = fixture(20);
    f.flags.get('r0')!.isDocument!.mockResolvedValue(true);
    await importWorkspace(directory, 'kb', async () => f.backend, { rootId: 'r0' });
    const count = () =>
      f.findMany.mock.calls.length +
      f.plugin.rem.findOne.mock.calls.length +
      f.plugin.kb.getCurrentKnowledgeBaseData.mock.calls.length +
      [...f.flags.values()].reduce(
        (sum, methods) =>
          sum + Object.values(methods).reduce((n, method) => n + method.mock.calls.length, 0),
        0
      );
    const clear = () => {
      f.findMany.mockClear();
      f.plugin.rem.findOne.mockClear();
      f.plugin.kb.getCurrentKnowledgeBaseData.mockClear();
      for (const methods of f.flags.values())
        for (const method of Object.values(methods)) method.mockClear();
    };
    clear();
    expect(await pushWorkspace(directory, async () => f.backend, { apply: true })).toMatchObject({
      status: 'unchanged',
    });
    expect(count()).toBe(42);
    const read = await readWorkspace(directory, 'r0.md');
    await saveWorkspace(
      directory,
      'r0.md',
      read.content.replace('r11 ^', 'edited-r11 ^'),
      read.fileHash
    );
    const before = await loadState(directory);
    const bytes = new Map(
      await Promise.all(
        Object.entries(before.entries).map(
          async ([id, entry]) => [id, await readPrivate(directory, entry.rawPath)] as const
        )
      )
    );
    const probe = vi.spyOn(f.backend, 'readProbe'),
      guard = vi.spyOn(f.backend, 'guard'),
      full = vi.spyOn(f.backend, 'read');
    clear();
    const result = (await pushWorkspace(directory, async () => f.backend, { apply: true })) as {
      planHash: string;
    };
    expect(result).toMatchObject({ status: 'verified', updated: ['r11'], remoteWrites: 1 });
    expect(probe.mock.calls.map(([ids]) => ids.length)).toEqual([20, 2, 2]);
    expect(count()).toBe(274);
    expect(guard.mock.calls.map(([ids]) => [...ids].sort())).toEqual(
      Array.from({ length: 3 }, () => ['r0', 'r11'])
    );
    expect(full.mock.calls.map(([ids]) => [...ids].sort())).toEqual([
      ['r0', 'r11'],
      ['r0', 'r11'],
      ['r11'],
      ['r11'],
      ['r0', 'r11'],
    ]);
    const after = await loadState(directory);
    const { hash } = await import('../../../src/business/workspace/types.js');
    const journal = await localStore('kb').getLocal<Journal>(
      `workspace-v2:kb:${hash(directory)}:${result.planHash}`
    );
    expect(journal!.final!.publicationIds).toEqual(['r11']);
    expect(Object.keys(journal!.final!.hashes).sort()).toEqual(['r0', 'r11']);
    for (const [id, entry] of Object.entries(after.entries))
      if (id !== 'r11') {
        expect(await readPrivate(directory, entry.rawPath)).toBe(bytes.get(id));
        expect(after.localVersions?.[id]).toEqual(before.localVersions?.[id]);
        expect(after.remoteVersions?.[id]).toEqual(before.remoteVersions?.[id]);
      }
    expect(after.entries.r11!.rawHash).not.toBe(before.entries.r11!.rawHash);
  });

  function noWrites(f: Fixture) {
    for (const methods of f.flags.values())
      for (const name of [
        'setText',
        'setBackText',
        'setParent',
        'setIsCardItem',
        'addPowerup',
        'addTag',
        'removeTag',
        'remove',
      ])
        expect(methods[name]).not.toHaveBeenCalled();
  }

  it.each(['changed', 'all'])(
    'does not invent a conflict for unchanged entity children in %s mode',
    async (scope) => {
      const f = await imported();
      f.objects.get('r0')!.children = [];
      expect(await f.apply({ scope })).toMatchObject({
        status: 'unchanged',
        complete: true,
        remoteWrites: 0,
      });
      if (scope === 'changed')
        for (const methods of f.flags.values()) {
          expect(methods.getCards).not.toHaveBeenCalled();
          expect(methods.isDocument).not.toHaveBeenCalled();
        }
      const { fileHash } = await readWorkspace(f.directory, 'r0.md');
      expect(await f.apply({ expectedFileHash: fileHash })).toMatchObject({
        status: 'verified',
        complete: true,
        remoteWrites: 0,
        outline: { nodes: { r0: { children: ['r1', 'r2'] } } },
      });
      noWrites(f);
    }
  );

  it.each(['changed', 'all', 'guarded'])(
    'rejects exact type 6 descendant additions in %s mode without importing them or writing',
    async (mode) => {
      const f = await imported();
      const source = await readPrivate(f.directory, 'r0.md'),
        identity = await readPrivate(f.directory, '.remnote/identity.json');
      const before = await loadState(f.directory);
      f.entityChildren.set('r1', ['r3']);
      Object.assign(f.objects.get('r3')!, { parent: 'r1', type: 6, children: ['r4'] });
      Object.assign(f.objects.get('r4')!, { parent: 'r3' });
      f.entityChildren.set('r3', ['r4']);
      const options =
        mode === 'guarded'
          ? { expectedFileHash: (await readWorkspace(f.directory, 'r0.md')).fileHash }
          : { scope: mode };
      expect(await f.apply(options)).toMatchObject({
        contentAuthority: 'local',
        status: 'conflict',
        complete: false,
        remoteWrites: 0,
        conflicts: [expect.objectContaining({ id: 'r1', reason: 'remote-structure' })],
      });
      noWrites(f);
      expect(f.entityChildren.get('r1')).toEqual(['r3']);
      expect(await readPrivate(f.directory, 'r0.md')).toBe(source);
      expect(await readPrivate(f.directory, '.remnote/identity.json')).toBe(identity);
      expect((await loadState(f.directory)).entries).toEqual(before.entries);
      expect(f.flags.get('r3')!.getChildrenRem).not.toHaveBeenCalled();
      expect(f.flags.get('r4')!.getChildrenRem).not.toHaveBeenCalled();
    }
  );

  it('rejects a true entity order change concealed by empty public children', async () => {
    const f = await imported();
    f.objects.get('r0')!.children = [];
    f.entityChildren.set('r0', ['r2', 'r1']);
    expect(await f.apply()).toMatchObject({
      status: 'conflict',
      complete: false,
      remoteWrites: 0,
      conflicts: [expect.objectContaining({ id: 'r0', reason: 'remote-structure' })],
    });
    noWrites(f);
  });

  it('rejects a concealed addition after the immutable guard at the fresh revision boundary', async () => {
    const f = await imported();
    const guard = f.backend.guard.bind(f.backend);
    vi.spyOn(f.backend, 'guard').mockImplementation(async (ids) => {
      const result = await guard(ids);
      f.entityChildren.set('r1', ['r3']);
      f.objects.get('r3')!.parent = 'r1';
      return result;
    });
    const { fileHash } = await readWorkspace(f.directory, 'r0.md');
    expect(await f.apply({ expectedFileHash: fileHash })).toMatchObject({
      status: 'conflict',
      complete: false,
      remoteWrites: 0,
      error: 'Concurrent remote change on r1',
    });
    noWrites(f);
  });
});
