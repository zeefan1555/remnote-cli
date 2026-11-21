/* global console */
import { performance } from 'node:perf_hooks';
import { inspectState } from '../src/business/state-inspect.ts';
import { ReadSession } from '../src/remnote-cli/client/session.ts';

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

function fixture(count = 20) {
  let calls = 0;
  const nodes = new Map();
  for (let i = 0; i < count; i++) {
    const id = `rem-${i}`;
    const call = (value) => async () => {
      calls += 1;
      return value;
    };
    nodes.set(id, {
      _id: id,
      type: 0,
      text: [id],
      backText: undefined,
      isFolder: call(false),
      isDocument: call(false),
      isCardItem: call(false),
      isTable: call(false),
      isProperty: call(false),
      isPowerup: call(false),
      isPowerupSlot: call(false),
      isPowerupProperty: call(false),
      isPowerupEnum: call(false),
      isPowerupPropertyListItem: call(false),
      hasPowerup: call(false),
      getChildrenRem: call([]),
      getTagRems: call([]),
      getAliases: call([]),
      getSources: call([]),
      getCards: call([]),
      getPracticeDirection: call('none'),
      getEnablePractice: call(false),
      getPortalType: call(0),
      getPortalDirectlyIncludedRem: call([]),
      getPowerupProperty: call(undefined),
    });
  }
  const plugin = {
    rem: {
      findMany: async (ids) => {
        calls += 1;
        return ids.flatMap((id) => (nodes.has(id) ? [nodes.get(id)] : []));
      },
      findOne: async (id) => {
        calls += 1;
        return nodes.get(id);
      },
    },
    richText: {
      toString: async (value) =>
        Array.isArray(value)
          ? value.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('')
          : '',
      toMarkdown: async (value) => `md:${String(value)}`,
    },
  };
  return { plugin, calls: () => calls, ids: [...nodes.keys()] };
}

async function measure(useSession) {
  const f = fixture();
  const session = useSession ? new ReadSession() : undefined;
  const params = { remIds: f.ids, fields: ['children', 'cards', 'tags', 'parent'] };
  const samples = [];
  let first;
  for (let i = 0; i < 10; i++) {
    const started = performance.now();
    const result = await inspectState(f.plugin, params, session);
    samples.push(performance.now() - started);
    first ??= result;
    if (JSON.stringify(result) !== JSON.stringify(first)) throw new Error('Semantic drift');
  }
  return {
    samples,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    calls: f.calls(),
  };
}

const baseline = await measure(false);
const session = await measure(true);
console.log(
  JSON.stringify({
    baseline,
    session,
    callReductionPercent: Number(
      (((baseline.calls - session.calls) / baseline.calls) * 100).toFixed(1)
    ),
    p95ChangePercent: Number((((session.p95 - baseline.p95) / baseline.p95) * 100).toFixed(1)),
  })
);
