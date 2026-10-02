import { createHash } from 'node:crypto';
import { z } from 'zod';
export const CapabilitySchema = z
  .object({
    id: z.string().min(1),
    target: z.enum(['namespace', 'rem', 'card', 'query']),
    namespace: z.string().optional(),
    method: z.string(),
    group: z.string(),
    command: z.string(),
    signatures: z.array(z.string()),
    summary: z.string().optional(),
    status: z.enum(['supported', 'unsupported']),
    mode: z.enum(['read', 'write', 'interactive', 'destructive']),
    reason: z.string().optional(),
    materialize: z.literal('richText').optional(),
  })
  .strict();
export const CatalogSchema = z
  .object({
    sdkVersion: z.string().min(1),
    sdkCatalogHash: z.string().regex(/^[a-f0-9]{64}$/),
    capabilities: z.array(CapabilitySchema).max(2000),
  })
  .strict();
export type Capability = z.infer<typeof CapabilitySchema>;
export type CapabilityResult = z.infer<typeof CatalogSchema>;
export function verifiedCatalog(value: unknown): CapabilityResult {
  CatalogSchema.parse(value);
  const original = value as CapabilityResult;
  const hash = createHash('sha256')
    .update(
      JSON.stringify({ sdkVersion: original.sdkVersion, capabilities: original.capabilities })
    )
    .digest('hex');
  if (
    hash !== original.sdkCatalogHash ||
    new Set(original.capabilities.map((c) => c.id)).size !== original.capabilities.length
  )
    throw new Error('SDK catalog content hash or capability identity mismatch');
  return original;
}
export async function getSdkCapabilities(client: {
  execute: (action: string, payload: Record<string, unknown>) => Promise<unknown>;
}): Promise<CapabilityResult> {
  return verifiedCatalog(await client.execute('get_sdk_capabilities', {}));
}
