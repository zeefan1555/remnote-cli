import type { ReactRNPlugin } from '@remnote/plugin-sdk';
import type { Connection } from './connection.js';
import type { CapabilityResult } from './sdk-capabilities.js';

/** Rehydrate official immutable SDK snapshots; only generated methods get remote call bindings. */
export function remoteSdk(
  connection: Connection,
  catalog: CapabilityResult,
  allowDestructive: boolean
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
      allowDestructive,
      expectedCatalogHash: catalog.sdkCatalogHash,
    })) as { capability: string; value: unknown };
    if (response.capability !== capability) throw new Error('SDK response capability mismatch');
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
