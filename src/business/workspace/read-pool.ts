/** Read-only concurrency: preserve input order, stop scheduling on failure, and drain before rejecting. */
export async function mapReads<T, R>(
  items: readonly T[],
  limit: number,
  read: (item: T) => Promise<R>
): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid read concurrency');
  const result = new Array<R>(items.length);
  let cursor = 0,
    failed = false,
    failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failed && cursor < items.length) {
        const index = cursor++;
        try {
          result[index] = await read(items[index]!);
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      }
    })
  );
  if (failed) throw failure;
  return result;
}

/** Lazy heterogeneous reads share the same bounded, stop-and-drain scheduling. */
export async function readTuple<const T extends readonly (() => Promise<unknown>)[]>(
  reads: T,
  limit: number
): Promise<{ -readonly [P in keyof T]: Awaited<ReturnType<T[P]>> }> {
  return (await mapReads(reads, limit, (read) => read())) as {
    -readonly [P in keyof T]: Awaited<ReturnType<T[P]>>;
  };
}

/** Independent SDK calls also settle before their enclosing batch may fail. */
export async function settleReads<const T extends readonly unknown[]>(
  reads: T
): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  const settled = await Promise.allSettled(reads);
  return settled.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  }) as { -readonly [P in keyof T]: Awaited<T[P]> };
}
