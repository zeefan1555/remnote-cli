import type { LocalContext } from './local.js';
import { idSchema } from './identity.js';
import { contentProjection } from './snapshots.js';
import { tagSet } from './tags.js';
import { hash, type WorkspaceRem } from './types.js';

/** IDs, field names and child identities only; never include native body text. */
export function nativeSourceChanges(before: WorkspaceRem, current: WorkspaceRem) {
  const fields = (['text', 'backText'] as const).filter(
    (field) => hash(contentProjection(before)[field]) !== hash(contentProjection(current)[field])
  ) as string[];
  if (Array.isArray(before.tags) && hash(tagSet(before.tags)) !== hash(tagSet(current.tags ?? [])))
    fields.push('tags');
  if (
    Array.isArray(current.references) &&
    hash(before.references ?? null) !== hash(current.references)
  )
    fields.push('references');
  if (hash(before.children) !== hash(current.children)) fields.push('children');
  return {
    id: before.id,
    fields,
    addedChildren: current.children.filter((id) => !before.children.includes(id)),
    oldChildOrderChanged:
      hash(before.children) !== hash(current.children.filter((id) => before.children.includes(id))),
  };
}

/** Read only new descendants of explicitly selected documents, with exact ownership. */
export async function readNativeSourceClosure(
  context: LocalContext,
  paths: string[],
  observed: Map<string, WorkspaceRem>,
  read: (ids: string[]) => Promise<Map<string, WorkspaceRem>>
): Promise<string[]> {
  const owners = new Map(
    paths.flatMap((path) => context.state.documents[path]!.nodeIds.map((id) => [id, path] as const))
  );
  const added: string[] = [];
  for (const [id] of owners) {
    const before = context.native.get(id)!,
      current = observed.get(id)!;
    if (
      before.parent !== current.parent ||
      before.children.some((child) => !current.children.includes(child))
    )
      throw new Error(`Native source adoption refuses deletion or reparenting: ${id}`);
    if (before.feedback)
      throw new Error(`Native source adoption refuses feedback-partitioned nodes: ${id}`);
    if (
      (before.type === 6 || current.type === 6) &&
      hash(before.children) !== hash(current.children)
    )
      throw new Error(`Native source adoption cannot traverse changed Portal children: ${id}`);
  }
  for (;;) {
    const pending = new Map<string, { parent: string; path: string }>();
    for (const [id, path] of owners) {
      const rem = observed.get(id)!;
      if (new Set(rem.children).size !== rem.children.length)
        throw new Error(`Native source adoption refuses duplicate children: ${id}`);
      for (const child of rem.children) {
        idSchema.parse(child);
        if (context.native.has(child) && context.state.entries[child]!.path !== path) {
          if (!context.native.get(id)?.children.includes(child))
            throw new Error(`Native source adoption cannot cross a bound document: ${child}`);
          continue; // Preserve an existing document mount; never adopt its body.
        }
        if (observed.has(child)) {
          if (owners.get(child) !== path || observed.get(child)!.parent !== id)
            throw new Error(`Native source adoption refuses conflicting child ownership: ${child}`);
        } else {
          const previous = pending.get(child);
          if (previous && (previous.parent !== id || previous.path !== path))
            throw new Error(`Native source adoption refuses conflicting child ownership: ${child}`);
          pending.set(child, { parent: id, path });
        }
      }
    }
    if (!pending.size) break;
    for (const [id, rem] of await read([...pending.keys()].sort())) {
      const owner = pending.get(id)!;
      if (
        rem.parent !== owner.parent ||
        rem.type === 6 ||
        rem.document !== false ||
        rem.folder !== false ||
        typeof rem.cardItem !== 'boolean' ||
        typeof rem.enablePractice !== 'boolean' ||
        !['forward', 'backward', 'both', 'none'].includes(rem.practice ?? '') ||
        !Array.isArray(rem.tags)
      )
        throw new Error(`New native descendant has an unsafe boundary or unknown flags: ${id}`);
      observed.set(id, rem);
      owners.set(id, owner.path);
      added.push(id);
    }
  }
  const reached = new Set<string>();
  function visit(id: string, path: string) {
    if (owners.get(id) !== path) return;
    if (reached.has(id))
      throw new Error(`Native source adoption refuses a cycle or duplicate: ${id}`);
    reached.add(id);
    for (const child of observed.get(id)!.children) visit(child, path);
  }
  for (const path of paths) visit(context.state.documents[path]!.rootId, path);
  if (reached.size !== owners.size)
    throw new Error('Native source adoption refuses detached existing nodes');
  return added;
}
