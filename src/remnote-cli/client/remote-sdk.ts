import type { ReactRNPlugin } from '@remnote/plugin-sdk';
import type { Connection } from './connection.js';
import type { CapabilityResult } from './sdk-capabilities.js';

/** Authorization lives only for one exact workspace mirror SDK call. */
export function createMirrorScope() {
  let active: { capability: string; id: string; args: string } | undefined;
  return {
    permits(capability: string, id: string | undefined, args: unknown[]): boolean {
      return (
        active !== undefined &&
        active.capability === capability &&
        active.id === id &&
        active.args === JSON.stringify(args)
      );
    },
    async run<T>(
      capability: string,
      id: string,
      args: unknown[],
      fn: () => Promise<T>
    ): Promise<T> {
      const valid =
        (capability === 'rem:remove' && args.length === 0) ||
        (capability === 'rem:removeTag' &&
          args.length === 2 &&
          typeof args[0] === 'string' &&
          args[1] === false);
      if (!valid || !id) throw new Error('Unsupported mirror operation');
      if (active) throw new Error('Concurrent mirror mutation is not allowed');
      active = { capability, id, args: JSON.stringify(args) };
      try {
        return await fn();
      } finally {
        active = undefined;
      }
    },
  };
}

/** Rehydrate official immutable SDK snapshots; only generated methods get remote call bindings. */
export function remoteSdk(
  connection: Connection,
  catalog: CapabilityResult,
  allowDestructive:
    boolean | ((capability: string, targetId: string | undefined, args: unknown[]) => boolean)
): ReactRNPlugin {
  const references = new WeakMap<object, { $ref: 'rem' | 'card'; id: string }>();
  const encode = (value: unknown): unknown => {
    if (value === undefined) return { $type: 'undefined' };
    if (value instanceof Date) return { $type: 'date', value: value.toISOString() };
    if (value && typeof value === 'object') {
      if (references.has(value)) return references.get(value);
      if (Array.isArray(value)) return value.map(encode);
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encode(entry)]));
    }
    if (typeof value === 'function' || typeof value === 'symbol')
      throw new Error('Callbacks cannot cross the SDK bridge');
    return value;
  };
  const invoke = async (
    capability: string,
    args: unknown[],
    targetId?: string
  ): Promise<unknown> => {
    const response = (await connection.request('sdk_call', {
      capability,
      ...(targetId ? { targetId } : {}),
      args: encode(args),
      allowDestructive:
        typeof allowDestructive === 'function'
          ? allowDestructive(capability, targetId, args)
          : allowDestructive,
      expectedCatalogHash: catalog.sdkCatalogHash,
    })) as { capability: string; value: unknown };
    if (response.capability !== capability) throw new Error('SDK response capability mismatch');
    if (!Object.hasOwn(response, 'value') || response.value === undefined)
      throw new Error('Incomplete SDK response value');
    return decode(response.value);
  };
  const decode = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(decode);
    if (!value || typeof value !== 'object') return value;
    const data = value as Record<string, unknown>;
    if (data.$type === 'undefined') return undefined;
    if (data.$type === 'date') return new Date(String(data.value));
    if (data.$type === 'rem' || data.$type === 'card') {
      if (typeof data.id !== 'string' || !data.id) throw new Error('Invalid SDK object identity');
      const object = Object.fromEntries(
        Object.entries(data)
          .filter(([key]) => key !== '$type' && key !== 'id')
          .map(([key, v]) => [key, decode(v)])
      );
      object._id = data.id;
      references.set(object, { $ref: data.$type, id: data.id });
      for (const method of catalog.capabilities.filter(
        (c) => c.target === data.$type && c.status === 'supported'
      ))
        Object.defineProperty(object, method.method, {
          value: (...args: unknown[]) => invoke(method.id, args, data.id as string),
        });
      return object;
    }
    return Object.fromEntries(Object.entries(data).map(([key, entry]) => [key, decode(entry)]));
  };
  const plugin: Record<string, Record<string, unknown>> = Object.create(null);
  for (const method of catalog.capabilities) {
    if (
      method.target !== 'namespace' ||
      !method.namespace ||
      method.namespace.includes('.') ||
      method.status !== 'supported'
    )
      continue;
    const namespace = (plugin[method.namespace] ??= Object.create(null));
    namespace[method.method] =
      method.materialize === 'richText'
        ? (...args: unknown[]) => ({ value: () => invoke(method.id, args) })
        : (...args: unknown[]) => invoke(method.id, args);
  }
  (plugin.app ??= Object.create(null)).transaction = async (): Promise<never> => {
    throw new Error(
      'Native transactions are unavailable: SDK 0.0.46 cannot acknowledge abort. No transaction writes were started. Use a journaled task or individual SDK calls.'
    );
  };
  return plugin as unknown as ReactRNPlugin;
}
