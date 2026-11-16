import { z } from 'zod';
import { idSchema } from './identity.js';
import type { WorkspaceRem } from './types.js';

// Obsidian tags are case-insensitive, hierarchical and cannot be numbers alone.
export const tagTokenSchema = z
  .string()
  .refine(
    (value) =>
      value === value.normalize('NFC') &&
      /^[\p{L}\p{M}\p{N}_-]+(?:\/[\p{L}\p{M}\p{N}_-]+)*$/u.test(value) &&
      /[\p{L}\p{M}_/-]/u.test(value),
    'Use a standard Obsidian tag without #, spaces or empty hierarchy segments'
  );
export const tagIdsSchema = z.record(tagTokenSchema, idSchema).superRefine((value, ctx) => {
  const tokens = new Set<string>(),
    ids = new Set<string>();
  for (const [token, id] of Object.entries(value)) {
    const folded = token.toLocaleLowerCase('und');
    if (tokens.has(folded) || ids.has(id))
      ctx.addIssue({ code: 'custom', message: 'Tag tokens and native IDs must be one-to-one' });
    tokens.add(folded);
    ids.add(id);
  }
});
export type TagIds = z.infer<typeof tagIdsSchema>;

export function tagSet(value: string[]): string[] {
  return [...new Set(value)].sort();
}

export function nativeTagToken(
  rems: Map<string, WorkspaceRem>,
  id: string,
  seen = new Set<string>()
): string {
  if (seen.has(id)) throw new Error('Cyclic native tag ancestor path');
  seen.add(id);
  const rem = rems.get(id);
  if (!rem) throw new Error(`Unmapped native tag ancestor ${id}`);
  if (!Array.isArray(rem.text) || rem.text.some((part) => typeof part !== 'string'))
    throw new Error(`Native tag ${id} needs a plain text name`);
  const segment = rem.text
    .join('')
    .normalize('NFC')
    .trim()
    .replace(/[^\p{L}\p{M}\p{N}_-]+/gu, '_');
  return tagTokenSchema.parse(
    rem.parent ? `${nativeTagToken(rems, rem.parent, seen)}/${segment}` : segment
  );
}

export function resolveTags(
  tokens: string[],
  registry: TagIds,
  native?: Map<string, WorkspaceRem>
): string[] {
  const byToken = new Map(
    Object.entries(registry).map(([token, id]) => [token.toLocaleLowerCase('und'), id])
  );
  return tagSet(
    tokens.map((token) => {
      tagTokenSchema.parse(token);
      let id = byToken.get(token.toLocaleLowerCase('und'));
      if (!id && native) {
        const candidates: string[] = [];
        for (const candidate of native.keys()) {
          let name: string;
          try {
            name = nativeTagToken(native, candidate);
          } catch {
            continue;
          }
          if (name.toLocaleLowerCase('und') === token.toLocaleLowerCase('und'))
            candidates.push(candidate);
        }
        if (candidates.length > 1)
          throw new Error(`Ambiguous Obsidian tag #${token}; sealed native paths collide`);
        id = candidates[0];
        if (id && Object.values(registry).includes(id))
          throw new Error(`Tag #${token} conflicts with the sealed one-to-one mapping`);
      }
      if (!id)
        throw new Error(`Unknown tag #${token}; no sealed token-to-native-ID mapping exists`);
      return id;
    })
  );
}

export function renderTags(ids: string[] | null | undefined, registry: TagIds): string[] {
  if (ids == null) return [];
  const byId = new Map(Object.entries(registry).map(([token, id]) => [id, token]));
  return tagSet(
    ids.map((id) => {
      const token = byId.get(id);
      if (!token)
        throw new Error(`Unmapped native tag ${id}; collect its exact native ancestor path first`);
      return token;
    })
  );
}

/** Stable names identify native tag Rems; retagging never renames those Rems. */
export function registerTags(rems: Map<string, WorkspaceRem>, previous: TagIds = {}): TagIds {
  return registerTagIds(
    rems,
    tagSet([...rems.values()].flatMap((rem) => rem.tags ?? [])),
    previous
  );
}

export function registerTagIds(
  rems: Map<string, WorkspaceRem>,
  needed: string[],
  previous: TagIds = {}
): TagIds {
  const registry = tagIdsSchema.parse(previous);
  const byId = new Map(Object.entries(registry).map(([token, id]) => [id, token]));
  const folded = new Map(
    Object.entries(registry).map(([token, id]) => [token.toLocaleLowerCase('und'), id])
  );
  for (const id of needed) {
    if (byId.has(id)) continue;
    const token = nativeTagToken(rems, id),
      other = folded.get(token.toLocaleLowerCase('und'));
    if (other && other !== id)
      throw new Error(`Ambiguous Obsidian tag #${token}; native tag paths collide`);
    registry[token] = id;
    byId.set(id, token);
    folded.set(token.toLocaleLowerCase('und'), id);
  }
  return tagIdsSchema.parse(registry);
}
