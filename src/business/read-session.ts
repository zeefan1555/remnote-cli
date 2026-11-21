import type { ReadSession, ReadableRem } from '../remnote-cli/client/session.js';

export const READ_SESSION_CONCURRENCY = 16;

export function wrapReadRem<T extends ReadableRem>(session: ReadSession | undefined, rem: T): T {
  return session ? session.wrapRem(rem) : rem;
}

export function readRem<T extends ReadableRem>(
  session: ReadSession | undefined,
  id: string,
  load: () => Promise<T | null | undefined>
): Promise<T | null | undefined> {
  if (!session) return load();
  const cached = session.getRem<T>(id);
  if (cached) return Promise.resolve(cached);
  return session.read(`rem:${id}`, async () => {
    const rem = await load();
    return rem && rem._id === id ? session.wrapRem(rem) : rem;
  });
}

export function allReads<const Tasks extends ReadonlyArray<() => Promise<unknown>>>(
  session: ReadSession | undefined,
  reads: Tasks
): Promise<{ -readonly [P in keyof Tasks]: Awaited<ReturnType<Tasks[P]>> }> {
  return session
    ? session.all(reads)
    : (Promise.all(reads.map((read) => read())) as Promise<{
        -readonly [P in keyof Tasks]: Awaited<ReturnType<Tasks[P]>>;
      }>);
}
