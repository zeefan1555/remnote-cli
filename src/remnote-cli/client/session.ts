const MAX_CACHED_VALUES = 20_000;

export interface ReadableRem {
  _id: string;
  getChildrenRem: () => Promise<ReadableRem[]>;
}

function isRemLike(value: unknown): value is ReadableRem {
  return Boolean(
    value &&
    typeof value === 'object' &&
    '_id' in value &&
    typeof (value as { _id?: unknown })._id === 'string' &&
    'getChildrenRem' in value &&
    typeof (value as { getChildrenRem?: unknown }).getChildrenRem === 'function'
  );
}

function stableArgument(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableArgument);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableArgument((value as Record<string, unknown>)[key])])
    );
  if (typeof value === 'function' || typeof value === 'symbol')
    throw new Error('Read session arguments must be JSON serializable');
  return value;
}

/** Command-local read deduplication. No value survives the owning DirectClient. */
export class ReadSession {
  private readonly values = new Map<string, unknown>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly rems = new Map<string, ReadableRem>();
  private generation = 0;

  private remember<T>(key: string, value: T, generation = this.generation): T {
    if (generation === this.generation) {
      this.values.set(key, value);
      while (this.values.size > MAX_CACHED_VALUES) {
        const oldest = this.values.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.values.delete(oldest);
      }
    }
    return value;
  }

  read<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (this.values.has(key)) return Promise.resolve(this.values.get(key) as T);
    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) return pending;
    const generation = this.generation;
    const promise = load()
      .then((value) => this.remember(key, value, generation))
      .finally(() => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  wrapRem<T extends ReadableRem>(rem: T): T {
    const cached = this.rems.get(rem._id);
    if (cached) return cached as T;
    this.rems.set(rem._id, rem);
    this.remember(`rem:${rem._id}`, rem);
    const wrapper = Object.create(Object.getPrototypeOf(rem)) as T;
    const names = new Set<PropertyKey>();
    for (
      let cursor: object | null = rem;
      cursor && cursor !== Object.prototype;
      cursor = Object.getPrototypeOf(cursor)
    )
      for (const name of Reflect.ownKeys(cursor)) names.add(name);
    for (const name of names) {
      if (name === 'constructor') continue;
      const value = Reflect.get(rem, name, rem);
      const wrappedValue =
        typeof value === 'function'
          ? (...args: unknown[]) => {
              const generation = this.generation;
              return this.read(
                `rem:${rem._id}:${String(name)}:${JSON.stringify(stableArgument(args))}`,
                async () => {
                  const result = await Reflect.apply(value, rem, args);
                  return generation === this.generation
                    ? this.rememberValue(result, 0, generation)
                    : result;
                }
              );
            }
          : value;
      Object.defineProperty(wrapper, name, {
        configurable: true,
        enumerable: Object.prototype.propertyIsEnumerable.call(rem, name),
        writable: true,
        value: wrappedValue,
      });
    }
    this.rems.set(rem._id, wrapper);
    return wrapper;
  }

  getRem<T extends ReadableRem>(id: string): T | undefined {
    return this.rems.get(id) as unknown as T | undefined;
  }

  async findMany<T extends ReadableRem>(
    ids: readonly string[],
    load: (missing: string[]) => Promise<T[] | undefined>
  ): Promise<T[]> {
    const unique = [...new Set(ids)];
    const missing = unique.filter((id) => !this.rems.has(id));
    if (missing.length) {
      const found = await this.read(`findMany:${[...missing].sort().join(',')}`, () =>
        load(missing)
      );
      for (const rem of found ?? []) this.wrapRem(rem);
    }
    return unique.flatMap((id) => {
      const rem = this.rems.get(id);
      return rem ? [rem as unknown as T] : [];
    });
  }

  async all<const Tasks extends ReadonlyArray<() => Promise<unknown>>>(
    tasks: Tasks
  ): Promise<{ -readonly [P in keyof Tasks]: Awaited<ReturnType<Tasks[P]>> }> {
    const results = new Array(tasks.length) as unknown[];
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(16, tasks.length) }, async () => {
        while (cursor < tasks.length) {
          const index = cursor++;
          results[index] = await tasks[index]!();
        }
      })
    );
    return results as { -readonly [P in keyof Tasks]: Awaited<ReturnType<Tasks[P]>> };
  }

  invalidateAll(): void {
    this.generation += 1;
    this.values.clear();
    this.inFlight.clear();
    this.rems.clear();
  }

  private rememberValue(value: unknown, depth: number, generation: number): unknown {
    if (generation !== this.generation || depth > 4) return value;
    if (Array.isArray(value))
      return value.map((entry) => this.rememberValue(entry, depth + 1, generation));
    if (isRemLike(value)) return this.wrapRem(value);
    return value;
  }
}
