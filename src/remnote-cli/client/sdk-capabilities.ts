import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SDK_FACTS } from '../spec/sdk-facts.generated.js';

export const CapabilitySchema = z
  .object({
    id: z.string().min(1),
    target: z.enum(['namespace', 'rem', 'card', 'query']),
    namespace: z.string().optional(),
    method: z.string(),
    signatures: z.array(z.string()),
    summary: z.string().optional(),
    status: z.enum(['supported', 'unsupported']),
    mode: z.enum(['read', 'write', 'interactive', 'destructive']),
    reason: z.string().optional(),
    materialize: z.enum(['richText', 'aliasText']).optional(),
  })
  .strict();
export const CatalogSchema = z
  .object({
    catalogSchemaVersion: z.literal(1),
    sdkVersion: z.string().min(1),
    sdkCatalogHash: z.string().regex(/^[a-f0-9]{64}$/),
    capabilities: z.array(CapabilitySchema).max(2000),
  })
  .strict();
export type Capability = z.infer<typeof CapabilitySchema>;
export type CapabilityResult = z.infer<typeof CatalogSchema>;
export interface NavigationCapability extends Capability {
  group: string;
  command: string;
}
export interface NavigationCatalog extends Omit<CapabilityResult, 'capabilities'> {
  capabilities: NavigationCapability[];
}

let localCatalog: CapabilityResult | undefined;

export function verifiedCatalog(value: unknown): CapabilityResult {
  CatalogSchema.parse(value);
  const original = value as CapabilityResult;
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        catalogSchemaVersion: original.catalogSchemaVersion,
        sdkVersion: original.sdkVersion,
        capabilities: original.capabilities,
      })
    )
    .digest('hex');
  if (
    hash !== original.sdkCatalogHash ||
    new Set(original.capabilities.map((c) => c.id)).size !== original.capabilities.length
  )
    throw new Error('SDK catalog content hash or capability identity mismatch');
  return original;
}

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

function capabilitySuffix(value: string): string {
  const slug = toKebabCase(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `${slug}-${hash}`;
}

export function navigationCapability(capability: Capability): NavigationCapability {
  if (capability.target === 'rem')
    return { ...capability, group: 'rem', command: `object-${toKebabCase(capability.method)}` };
  if (capability.target === 'card')
    return { ...capability, group: 'card', command: `object-${toKebabCase(capability.method)}` };
  if (capability.target === 'query')
    return { ...capability, group: 'search', command: `query-${toKebabCase(capability.method)}` };
  if (capability.namespace === 'richText.builder')
    return {
      ...capability,
      group: 'richText',
      command: `builder-${toKebabCase(capability.method)}`,
    };
  if (capability.namespace === 'plugin')
    return { ...capability, group: 'app', command: `plugin-${toKebabCase(capability.method)}` };
  if (!capability.namespace)
    throw new Error(`SDK capability has no navigation group: ${capability.id}`);
  return {
    ...capability,
    group: capability.namespace,
    command: toKebabCase(capability.method),
  };
}

export function navigationCatalog(result: CapabilityResult): NavigationCatalog {
  const initial = result.capabilities.map(navigationCapability);
  const counts = new Map<string, number>();
  for (const capability of initial) {
    const key = `${capability.group}:${capability.command}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const capabilities = initial.map((capability) => {
    const key = `${capability.group}:${capability.command}`;
    return counts.get(key) === 1
      ? capability
      : {
          ...capability,
          command: `${capability.command}--${capabilitySuffix(capability.id)}`,
        };
  });
  return { ...result, capabilities };
}

export function localSdkCapabilities(): CapabilityResult {
  localCatalog ??= verifiedCatalog(SDK_FACTS);
  return localCatalog;
}

export function localSdkNavigation(): NavigationCatalog {
  return navigationCatalog(localSdkCapabilities());
}

export async function getSdkCapabilities(client: {
  execute: (action: string, payload: Record<string, unknown>) => Promise<unknown>;
}): Promise<CapabilityResult> {
  return verifiedCatalog(await client.execute('get_sdk_capabilities', {}));
}
