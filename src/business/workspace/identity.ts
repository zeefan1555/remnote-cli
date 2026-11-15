import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { WorkspaceState } from './types.js';

export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
export const keySchema = z.string().regex(/^(?:[A-Za-z0-9_-]{1,256}|new:[A-Za-z0-9_-]{1,100})$/);
export const blockSchema = z.string().regex(/^[A-Za-z0-9-]{1,600}$/);
export const shortBlockSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

export const IDENTITY = '.remnote/identity.json';
export const identitySchema = z
  .object({
    schema: z.literal('remnote-identity/1'),
    kbId: z.string().min(1),
    documents: z.record(
      shortBlockSchema,
      z
        .object({
          rootId: idSchema,
          blocks: z.record(shortBlockSchema, idSchema),
        })
        .strict()
    ),
  })
  .strict();

/** Once assigned this is retained, including when a local key receives a native Rem ID. */
export function nativeBlockId(id: string): string {
  return shortBlockId(idSchema.parse(id), new Set());
}

/** Deterministic compact IDs, extended on collision rather than silently aliasing a Rem. */
export function shortBlockId(seed: string, used: ReadonlySet<string>): string {
  const digest = createHash('sha256').update(seed).digest('hex');
  for (let length = 8; length <= 62; length += 2) {
    const candidate = `r-${digest.slice(0, length)}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('Cannot allocate an unambiguous short block ID');
}

/** New names are scoped by document, so the same human anchor may occur in two notes. */
export function localNodeKey(rootId: string, block: string): string {
  return `new:${createHash('sha256').update(`${rootId}:${block}`).digest('hex').slice(0, 32)}`;
}

/** Tracked identity is only a portable projection of the authoritative manifest, not another database. */
export function workspaceIdentity(state: WorkspaceState): z.infer<typeof identitySchema> {
  const documents: z.infer<typeof identitySchema>['documents'] = {};
  const roots = new Set<string>(),
    mapped = new Set<string>();
  for (const document of Object.values(state.documents)) {
    const key = state.entries[document.rootId]?.blockId;
    if (!key || Object.hasOwn(documents, key) || roots.has(document.rootId))
      throw new Error('Duplicate or missing document identity');
    roots.add(document.rootId);
    const blocks: Record<string, string> = {};
    for (const id of document.nodeIds) {
      const block = state.entries[id]?.blockId;
      if (!block || Object.hasOwn(blocks, block) || mapped.has(id))
        throw new Error('Duplicate or missing block identity');
      blocks[block] = id;
      mapped.add(id);
    }
    if (blocks[key] !== document.rootId)
      throw new Error('Document key must reuse its root block ID');
    documents[key] = { rootId: document.rootId, blocks };
  }
  if (mapped.size !== Object.keys(state.entries).length)
    throw new Error('Identity map does not cover the native baseline');
  return identitySchema.parse({ schema: 'remnote-identity/1', kbId: state.kbId, documents });
}

export function recordPath(id: string): string {
  return `.remnote/records/${idSchema.parse(id)}.json`;
}

export function originalPath(kind: 'rems' | 'public', id: string): string {
  return `.remnote/originals/${kind}/${idSchema.parse(id)}.json`;
}
