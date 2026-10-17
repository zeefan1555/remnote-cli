import { describe, expect, it } from 'vitest';
import { RemType } from '../../../src/business/sdk-constants.generated.js';
import { inspectState } from '../../../src/business/state-inspect.js';

const LATENCY_MS = 8;

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), LATENCY_MS));
}

describe('inspect latency model', () => {
  it('measures a 182-rem full inspect against per-call latency', async () => {
    const calls = new Map<string, number>();
    const hit = (name: string) => {
      calls.set(name, (calls.get(name) ?? 0) + 1);
    };
    type Rem = {
      _id: string;
      type: number | undefined;
      text: unknown;
      backText: unknown;
      parent?: string;
      isFolder: () => Promise<boolean>;
      isDocument: () => Promise<boolean>;
      isCardItem: () => Promise<boolean>;
      hasPowerup: (code: string) => Promise<boolean>;
      getChildrenRem: () => Promise<Rem[]>;
      getTagRems: () => Promise<Rem[]>;
      getAliases: () => Promise<Array<{ text: unknown }>>;
      getSources: () => Promise<Rem[]>;
      getCards: () => Promise<unknown[]>;
      getPracticeDirection: () => Promise<string>;
      getEnablePractice: () => Promise<boolean>;
      getPortalType: () => Promise<number>;
      getPortalDirectlyIncludedRem: () => Promise<Rem[]>;
      getPowerupProperty: (powerup: string, slot: string) => Promise<unknown>;
    };
    const nodes = new Map<string, Rem>();
    const make = (id: string, text: unknown = [id], parent?: string): Rem => {
      const rem: Rem = {
        _id: id,
        type: RemType.DEFAULT_TYPE as number | undefined,
        text,
        backText: ['back'],
        parent,
        isFolder: () => {
          hit('isFolder');
          return delay(false);
        },
        isDocument: () => {
          hit('isDocument');
          return delay(false);
        },
        isCardItem: () => {
          hit('isCardItem');
          return delay(false);
        },
        hasPowerup: () => {
          hit('hasPowerup');
          return delay(false);
        },
        getChildrenRem: () => {
          hit('getChildrenRem');
          return delay([]);
        },
        getTagRems: () => {
          hit('getTagRems');
          const found = nodes.get('tag');
          return delay(found ? [found] : []);
        },
        getAliases: () => {
          hit('getAliases');
          return delay([{ text: ['aka'] }]);
        },
        getSources: () => {
          hit('getSources');
          const source = nodes.get('a0');
          return delay(source ? [source] : []);
        },
        getCards: () => {
          hit('getCards');
          return delay([
            {
              _id: `${id}-card`,
              remId: id,
              type: 'forward',
              nextRepetitionTime: 1,
              repetitionHistory: [{ score: 1 }],
            },
          ]);
        },
        getPracticeDirection: () => {
          hit('getPracticeDirection');
          return delay('none');
        },
        getEnablePractice: () => {
          hit('getEnablePractice');
          return delay(false);
        },
        getPortalType: () => {
          hit('getPortalType');
          return delay(4);
        },
        getPortalDirectlyIncludedRem: () => {
          hit('getPortalDirectlyIncludedRem');
          return delay([]);
        },
        getPowerupProperty: () => {
          hit('getPowerupProperty');
          return delay('slot');
        },
      };
      nodes.set(id, rem);
      return rem;
    };
    for (let index = 0; index < 4; index += 1)
      make(`a${index}`, [`a${index}`], index === 0 ? undefined : `a${index - 1}`);
    const tag = make('tag', ['Tag'], 'a3');
    tag.type = RemType.CONCEPT;
    const root = make('root', ['Root'], 'a3');
    const children: Rem[] = [];
    for (let index = 0; index < 181; index += 1) {
      const rem = make(`r${index}`, [`r${index}`], 'root');
      if (index < 13) rem.type = RemType.PORTAL;
      children.push(rem);
    }
    root.getChildrenRem = () => {
      hit('getChildrenRem');
      return delay(children);
    };
    const plugin = {
      rem: {
        findMany: async (requested: string[]) => {
          hit('findMany');
          return delay(requested.flatMap((id) => (nodes.get(id) ? [nodes.get(id)!] : [])));
        },
      },
      richText: {
        toString: (value: unknown) => {
          hit('toString');
          return delay(Array.isArray(value) ? String(value[0] ?? '') : '');
        },
        toMarkdown: (value: unknown) => {
          hit('toMarkdown');
          return delay(Array.isArray(value) ? String(value[0] ?? '') : '');
        },
      },
    };
    const started = performance.now();
    const result = await inspectState(plugin as never, { remIds: ['root'], descendants: 1 });
    const elapsed = performance.now() - started;
    console.log(
      JSON.stringify(
        {
          elapsedMs: Math.round(elapsed),
          complete: result.complete,
          rems: result.rems.length,
          calls: Object.fromEntries([...calls.entries()].sort((left, right) => right[1] - left[1])),
        },
        null,
        2
      )
    );
    expect(result.complete).toBe(true);
    expect(result.rems).toHaveLength(182);
    // Same 8ms model, same call counts: serial fields at concurrency 8 took 2458ms.
    // Overlapped fields at concurrency 32 took 804ms. Live full inspect was 12.2s at the old ratio.
    expect(elapsed).toBeLessThan(1_500);
  }, 120_000);
});
