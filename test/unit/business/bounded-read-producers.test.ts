import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { PluginRem } from '@remnote/plugin-sdk';
import { describe, expect, it } from 'vitest';
import { remoteSdk } from '../../../src/remnote-cli/client/remote-sdk.js';
import {
  verifiedCatalog,
  type Capability,
} from '../../../src/remnote-cli/client/sdk-capabilities.js';
import { SdkWorkspaceBackend } from '../../../src/business/workspace/sdk-backend.js';
import { readRemote } from '../../../src/business/workspace/reconcile.js';
import { mapReads } from '../../../src/business/workspace/read-pool.js';
import type { LocalContext } from '../../../src/business/workspace/local.js';
import type { WorkspacePlan } from '../../../src/business/workspace/types.js';
import { RemAdapter } from '../../../src/business/rem-adapter.js';
import { inspectMany } from '../../../src/business/inspection.js';
import { TaskOperations, type FlashcardsPlan } from '../../../src/business/task-operations.js';

// Real remoteSdk bindings and business consumers; only atomic replies are synthetic.
// No SDK runtime, socket, pairing, filesystem state, native writes or user KB.
const methods = [
  'getChildrenRem',
  'getParentRem',
  'isDocument',
  'isFolder',
  'isCardItem',
  'getPracticeDirection',
  'getEnablePractice',
  'isTable',
  'isProperty',
  'isPowerup',
  'isPowerupSlot',
  'isPowerupProperty',
  'isPowerupEnum',
  'isPowerupPropertyListItem',
  'getCards',
  'getTagRems',
  'getPortalType',
  'getPortalDirectlyIncludedRem',
  'hasPowerup',
  'getPowerupProperty',
  'getAliases',
  'remsBeingReferenced',
  'taggedRem',
  'getPropertyType',
  'getTagPropertyValue',
];
const capabilities: Capability[] = [
  ...methods.map((method): Capability => ({
    id: `rem:${method}`,
    target: 'rem',
    method,
    group: 'rem',
    command: method,
    signatures: [],
    status: 'supported',
    mode: 'read',
  })),
  ...['rem.findOne', 'rem.findMany', 'rem.getAll', 'richText.toString'].map((name): Capability => {
    const [namespace, method] = name.split('.');
    return {
      id: `namespace:${name}`,
      target: 'namespace',
      namespace,
      method,
      group: namespace,
      command: method,
      signatures: [],
      status: 'supported',
      mode: 'read',
    };
  }),
];
const catalogData = { sdkVersion: '0.0.46', capabilities };
const catalog = verifiedCatalog({
  ...catalogData,
  sdkCatalogHash: createHash('sha256').update(JSON.stringify(catalogData)).digest('hex'),
});
interface Node {
  id: string;
  parent: string | null;
  children: string[];
  text: unknown[];
  type?: number;
  property?: boolean;
  aliases?: string[];
  tagged?: string[];
}
function node(id: string, parent: string | null = null): Node {
  return { id, parent, children: [], text: [id] };
}
function endpoint(
  nodes: Node[],
  cap = 32,
  beforeReply?: (payload: Record<string, unknown>) => Promise<void>
) {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const stats = { active: 0, peak: 0, rejected: 0, calls: [] as string[] };
  const wire = (id: string): unknown => {
    const value = byId.get(id);
    return value
      ? {
          $type: 'rem',
          id,
          parent: value.parent,
          children: value.children,
          text: value.text,
          ...(value.type === undefined ? {} : { type: value.type }),
        }
      : { $type: 'undefined' };
  };
  let limit = cap;
  const request = async (_action: string, payload: Record<string, unknown>) => {
    if (stats.active >= limit) {
      stats.rejected++;
      throw new Error('Too many outstanding requests; this request was not sent');
    }
    stats.active++;
    stats.peak = Math.max(stats.peak, stats.active);
    const capability = String(payload.capability),
      id = String(payload.targetId);
    const args = payload.args as unknown[];
    stats.calls.push(JSON.stringify([capability, payload.targetId ?? null, args]));
    try {
      await setImmediate();
      await beforeReply?.(payload);
      const rem = byId.get(id);
      let value: unknown;
      switch (capability) {
        case 'namespace:rem.findOne':
          value = wire(String(args[0]));
          break;
        case 'namespace:rem.findMany':
          value = (args[0] as string[]).map(wire);
          break;
        case 'namespace:rem.getAll':
          value = nodes.map((item) => wire(item.id));
          break;
        case 'namespace:richText.toString':
          value = (args[0] as string[]).join('');
          break;
        case 'rem:getChildrenRem':
          value = rem!.children.map(wire);
          break;
        case 'rem:getParentRem':
          value = rem!.parent ? wire(rem!.parent) : { $type: 'undefined' };
          break;
        case 'rem:getAliases':
          value = (rem!.aliases ?? []).map(wire);
          break;
        case 'rem:taggedRem':
          value = (rem!.tagged ?? []).map(wire);
          break;
        case 'rem:isProperty':
          value = rem!.property ?? false;
          break;
        case 'rem:getPropertyType':
          value = 'text';
          break;
        case 'rem:getTagPropertyValue':
          value = [`value:${id}:${args[0]}`];
          break;
        case 'rem:getPracticeDirection':
          value = 'none';
          break;
        case 'rem:getEnablePractice':
          value = true;
          break;
        case 'rem:getPortalType':
          value = 4;
          break;
        case 'rem:hasPowerup':
          value = rem?.type === 6 && args[0] === 'sp';
          break;
        case 'rem:getPowerupProperty':
          value = String(args[1]);
          break;
        case 'rem:getCards':
        case 'rem:getTagRems':
        case 'rem:remsBeingReferenced':
        case 'rem:getPortalDirectlyIncludedRem':
          value = [];
          break;
        default:
          if (capability.startsWith('rem:is')) value = false;
          else throw new Error(`Unexpected synthetic capability: ${capability}`);
      }
      return { capability, value };
    } finally {
      stats.active--;
    }
  };
  return {
    sdk: remoteSdk({ request } as never, catalog, false),
    stats,
    reset(nextCap = cap) {
      expect(stats.active).toBe(0);
      limit = nextCap;
      Object.assign(stats, { peak: 0, rejected: 0, calls: [] });
    },
  };
}
const journal = { getLocal: async () => undefined, setLocal: async () => {} };

describe('bounded business read producers', () => {
  it.each(['reconcile', 'read', 'probe', 'guard', 'enumerate'] as const)(
    'preserves all %s facts and atomic requests within the 32-outstanding budget',
    async (mode) => {
      const nodes = Array.from({ length: 200 }, (_, i) => ({
        ...node(`r${String(i).padStart(3, '0')}`),
        ...(i % 7 === 0 ? { type: 6 } : {}),
      }));
      const ids = nodes.map((item) => item.id);
      const chunks = Array.from({ length: 4 }, (_, i) => ids.slice(i * 50, i * 50 + 50));
      const powerupCodes = Object.fromEntries(ids.map((id) => [id, ['a', 'b', 'c', 'd']]));
      async function run(cap: number) {
        const e = endpoint(nodes, Infinity);
        const backend = new SdkWorkspaceBackend(e.sdk, journal, async () => ({
          kbId: 'kb',
          writable: false,
        }));
        // Prepare only synthetic sealed facts, then measure the production consumer.
        const baseline = (
          await mapReads(chunks, 1, (batch) => backend.read(batch, { tags: true, powerupCodes }))
        ).flat();
        e.reset(cap);
        let result: unknown;
        if (mode === 'reconcile') {
          const context = {
            native: new Map(baseline.map((rem) => [rem.id, rem])),
            state: { tagIds: {} },
          } as LocalContext;
          const plan: WorkspacePlan = {
            version: 1,
            directory: '/synthetic',
            kbId: 'kb',
            baseHash: '',
            files: {},
            changes: [],
            selection: {
              scope: 'all',
              paths: [],
              files: [],
              outgoingKeys: [],
              reconcileIds: ids,
              verificationIds: [],
            },
          };
          result = [...(await readRemote(context, plan, backend, powerupCodes)).values()];
        } else if (mode === 'read') {
          result = await backend.read(ids.slice(0, 50), { tags: true, powerupCodes });
        } else if (mode === 'probe') {
          result = await mapReads(chunks, 4, (batch) => backend.readProbe(batch, { powerupCodes }));
        } else if (mode === 'guard') result = await backend.guard(ids);
        else result = await backend.enumerate();
        expect(e.stats.active).toBe(0);
        expect(e.stats.rejected).toBe(0);
        return { result, peak: e.stats.peak, calls: e.stats.calls.sort() };
      }
      const expected = await run(Infinity),
        actual = await run(32);
      expect(actual.peak).toBe(mode === 'reconcile' || mode === 'probe' ? 32 : 16);
      expect(actual.result).toEqual(expected.result);
      expect(actual.calls).toEqual(expected.calls);
    }
  );

  it('stops later Rems and flags, draining the started snapshot reads before rejecting', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let flagReads = 0;
    const initialFlags = new Set([
      'rem:isDocument',
      'rem:isFolder',
      'rem:isCardItem',
      'rem:getPracticeDirection',
    ]);
    const e = endpoint(
      Array.from({ length: 6 }, (_, i) => node(`r${i}`)),
      32,
      async (payload) => {
        if (!initialFlags.has(String(payload.capability))) return;
        if (++flagReads === 16) entered();
        if (payload.capability === 'rem:isDocument') throw new Error('native flag unavailable');
        await gate;
      }
    );
    const backend = new SdkWorkspaceBackend(e.sdk, journal, async () => ({
      kbId: 'kb',
      writable: false,
    }));
    let settled = false;
    const result = backend.read(['r0', 'r1', 'r2', 'r3', 'r4', 'r5']).finally(() => {
      settled = true;
    });
    const rejected = expect(result).rejects.toThrow('native flag unavailable');
    await started;
    await setImmediate();
    expect(e.stats.active).toBe(12);
    expect(settled).toBe(false);
    release();
    await rejected;
    expect(e.stats.active).toBe(0);
    expect(e.stats.rejected).toBe(0);
    expect(flagReads).toBe(16);
    expect(e.stats.calls).toHaveLength(21); // findMany + four children + four initial flags per Rem.
    expect(
      e.stats.calls.some((call) => call.includes('getCards') || call.includes('getEnablePractice'))
    ).toBe(false);
  });

  it.each([50, 150])('reads %i table rows and 40 columns without eager fan-out', async (limit) => {
    const table = node('table'),
      ref = node('ref');
    const properties = Array.from({ length: 40 }, (_, i) => ({
      ...node(`prop${i}`, 'table'),
      property: true,
      text: [{ i: 'q', _id: 'ref' }],
    }));
    const rows = Array.from({ length: 150 }, (_, i) => node(`row${i}`));
    table.children = properties.map((item) => item.id);
    table.tagged = rows.map((item) => item.id);
    const e = endpoint([table, ref, ...properties, ...rows]);
    const adapter = new RemAdapter(e.sdk, { acceptWriteOperations: false });
    const result = await adapter.readTable({ tableRemId: 'table', limit });
    expect(result.rows.map((row) => row.remId)).toEqual(rows.slice(0, limit).map((row) => row.id));
    expect(result.columns.map((column) => column.propertyId)).toEqual(table.children);
    expect(result.rows.at(-1)!.values.prop39).toBe(`value:row${limit - 1}:prop39`);
    expect(e.stats.active).toBe(0);
    expect(e.stats.peak).toBe(16);
    expect(e.stats.rejected).toBe(0);
  });

  it('renders 80 aliases through actual remoteSdk without discarding any alias', async () => {
    const owner = node('owner'),
      aliases = Array.from({ length: 80 }, (_, i) => node(`alias${i}`));
    owner.aliases = aliases.map((item) => item.id);
    const e = endpoint([owner, ...aliases]);
    const result = await inspectMany(e.sdk, { schemaVersion: 1, remIds: ['owner'] });
    expect(result.complete).toBe(true);
    expect(result.objects[0].aliases).toEqual(owner.aliases);
    expect(e.stats.active).toBe(0);
    expect(e.stats.peak).toBe(16);
    expect(e.stats.rejected).toBe(0);
  });

  it('binds and rereads the full 708-Rem, 700-answer scaffold without native writes', async () => {
    const root = node('root', 'daily'),
      daily = node('daily');
    const cards = Array.from({ length: 7 }, (_, i) => node(`card${i}`, 'root'));
    root.children = cards.map((item) => item.id);
    daily.children = ['root'];
    const answers = cards.flatMap((card, i) => {
      const children = Array.from({ length: 100 }, (_, j) => node(`answer${i}_${j}`, card.id));
      card.children = children.map((item) => item.id);
      return children;
    });
    const scaffold = [root, ...cards, ...answers],
      ids = scaffold.map((item) => item.id);
    const plan: FlashcardsPlan = {
      schemaVersion: 1,
      dailyRemId: 'daily',
      title: 'Cluster',
      tags: {},
      newCards: cards.map((card) => ({
        key: card.id,
        question: card.id,
        answer: Array.from({ length: 100 }, (_, i) => [`answer${i}`]),
      })),
    };
    const e = endpoint([daily, ...scaffold]);
    const operations = new TaskOperations({
      plugin: e.sdk,
      journal,
      canWrite: () => false,
    }) as unknown as {
      bindScaffold(plan: FlashcardsPlan, ids: string[], state: unknown): Promise<void>;
      boundScaffold(
        plan: FlashcardsPlan,
        ids: string[],
        state: unknown
      ): Promise<{ root: PluginRem; cards: PluginRem[]; answers: PluginRem[][] }>;
    };
    const state = {
      ids: {},
      createdParentIds: Object.fromEntries(scaffold.map((item) => [item.id, item.parent])),
      createdChildrenIds: Object.fromEntries(scaffold.map((item) => [item.id, item.children])),
      createdTagIds: Object.fromEntries(scaffold.map((item) => [item.id, []])),
    };
    await operations.bindScaffold(plan, ids, state);
    const result = await operations.boundScaffold(plan, ids, state);
    expect(Object.keys(state.ids)).toHaveLength(708);
    expect(result.root._id).toBe('root');
    expect(result.cards.map((card) => card._id)).toEqual(root.children);
    expect(result.answers.flat().map((answer) => answer._id)).toEqual(
      answers.map((item) => item.id)
    );
    expect(e.stats.active).toBe(0);
    expect(e.stats.peak).toBe(16);
    expect(e.stats.rejected).toBe(0);
  });

  it('classifies all 80 metadata children within budget before considering any deletion', async () => {
    const owner = node('owner');
    const children = Array.from({ length: 80 }, (_, i) => ({
      ...node(`child${i}`, 'owner'),
      property: true,
    }));
    owner.children = children.map((child) => child.id);
    const e = endpoint([owner, ...children]);
    const adapter = new RemAdapter(e.sdk, { acceptWriteOperations: false }) as unknown as {
      clearDirectContentChildren(rem: PluginRem): Promise<void>;
      extractRemResults(rems: PluginRem[]): Promise<{ remIds: string[]; titles: string[] }>;
    };
    await adapter.clearDirectContentChildren((await e.sdk.rem.findOne('owner'))!);
    expect(e.stats.calls.filter((call) => call.includes('rem:isProperty'))).toHaveLength(80);
    expect(e.stats.active).toBe(0);
    expect(e.stats.peak).toBe(16);
    expect(e.stats.rejected).toBe(0);

    const refs = (
      await mapReads([owner.children.slice(0, 50), owner.children.slice(50)], 1, (batch) =>
        e.sdk.rem.findMany(batch)
      )
    ).flat();
    const referenced = refs.map(
      (rem) => ({ ...rem, text: [{ i: 'q', _id: 'owner' }] }) as PluginRem
    );
    const result = await adapter.extractRemResults(referenced);
    expect(result.remIds).toEqual(owner.children);
    expect(result.titles).toEqual(Array(80).fill('[[owner]]'));
    expect(e.stats.peak).toBe(16);
    expect(e.stats.active).toBe(0);
  });
});
