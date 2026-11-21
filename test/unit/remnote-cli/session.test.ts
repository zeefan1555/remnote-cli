import { describe, expect, it, vi } from 'vitest';
import { ReadSession } from '../../../src/remnote-cli/client/session.js';

describe('command read session', () => {
  it('shares one load for concurrent equal reads and caches successful values', async () => {
    const session = new ReadSession();
    let release!: (value: string) => void;
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        })
    );
    const first = session.read('same', load);
    const second = session.read('same', load);
    expect(first).toBe(second);
    release('value');
    await expect(first).resolves.toBe('value');
    await expect(session.read('same', load)).resolves.toBe('value');
    expect(load).toHaveBeenCalledOnce();
    session.invalidateAll();
    const fresh = session.read('same', async () => 'fresh');
    await expect(fresh).resolves.toBe('fresh');
  });

  it('deduplicates Rem methods by capability and invalidates stale in-flight values', async () => {
    const session = new ReadSession();
    const child = {
      _id: 'child',
      getChildrenRem: vi.fn(async () => []),
    };
    let release!: (value: (typeof child)[]) => void;
    const getChildrenRem = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<(typeof child)[]>((resolve) => {
            release = resolve;
          })
      )
      .mockResolvedValue([child]);
    const rem = session.wrapRem({ _id: 'root', getChildrenRem });
    const first = rem.getChildrenRem();
    const second = rem.getChildrenRem();
    expect(second).toBe(first);
    expect(getChildrenRem).toHaveBeenCalledOnce();
    session.invalidateAll();
    release([child]);
    await expect(first).resolves.toHaveLength(1);
    expect(session.getRem('child')).toBeUndefined();
    await rem.getChildrenRem();
    expect(getChildrenRem).toHaveBeenCalledTimes(2);
    expect(session.getRem('child')).toBeDefined();
  });

  it('batches missing Rem loads and preserves bounded concurrency', async () => {
    const session = new ReadSession();
    const rem = (id: string) => ({ _id: id, getChildrenRem: async () => [] });
    const loadMany = vi.fn(async (ids: string[]) => ids.map(rem));
    expect(await session.findMany(['a', 'b'], loadMany)).toHaveLength(2);
    expect(await session.findMany(['b', 'c'], loadMany)).toHaveLength(2);
    expect(loadMany.mock.calls).toEqual([[['a', 'b']], [['c']]]);

    let active = 0,
      max = 0;
    const values = await session.all(
      Array.from({ length: 40 }, (_, i) => async () => {
        active += 1;
        max = Math.max(max, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return i;
      })
    );
    expect(values).toEqual(Array.from({ length: 40 }, (_, i) => i));
    expect(max).toBeLessThanOrEqual(16);
  });
});
