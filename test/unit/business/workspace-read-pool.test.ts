import { describe, expect, it, vi } from 'vitest';
import { mapReads, settleReads } from '../../../src/business/workspace/read-pool.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('workspace read pool', () => {
  it('caps concurrent reads and preserves input order when completion order differs', async () => {
    const pending = Array.from({ length: 5 }, () => deferred<number>());
    const read = vi.fn((index: number) => pending[index]!.promise);
    const result = mapReads([0, 1, 2, 3, 4], 2, read);
    expect(read.mock.calls.flat()).toEqual([0, 1]);
    pending[1]!.resolve(11);
    await Promise.resolve();
    expect(read.mock.calls.flat()).toEqual([0, 1, 2]);
    pending[2]!.resolve(12);
    await Promise.resolve();
    pending[3]!.resolve(13);
    await Promise.resolve();
    pending[4]!.resolve(14);
    pending[0]!.resolve(10);
    expect(await result).toEqual([10, 11, 12, 13, 14]);
  });

  it.each(['reject', 'timeout'])(
    'stops scheduling after %s and drains every in-flight read before rejecting',
    async (reason) => {
      const pending = Array.from({ length: 6 }, () => deferred<number>());
      const read = vi.fn((index: number) => pending[index]!.promise);
      let settled = false;
      const result = mapReads([0, 1, 2, 3, 4, 5], 4, read).finally(() => {
        settled = true;
      });
      const rejected = expect(result).rejects.toThrow(reason);
      pending[1]!.reject(new Error(reason));
      await Promise.resolve();
      expect(settled).toBe(false);
      pending[0]!.resolve(0);
      pending[2]!.resolve(2);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(read.mock.calls.flat()).toEqual([0, 1, 2, 3]);
      pending[3]!.resolve(3);
      await rejected;
      expect(settled).toBe(true);
      expect(read.mock.calls.flat()).toEqual([0, 1, 2, 3]);
    }
  );

  it('also drains independent SDK flag reads after an early rejection', async () => {
    const slow = deferred<string>();
    let settled = false;
    const result = settleReads([
      Promise.reject(new Error('flag unavailable')),
      slow.promise,
    ]).finally(() => {
      settled = true;
    });
    const rejected = expect(result).rejects.toThrow('flag unavailable');
    await Promise.resolve();
    expect(settled).toBe(false);
    slow.resolve('done');
    await rejected;
    expect(settled).toBe(true);
  });
});
