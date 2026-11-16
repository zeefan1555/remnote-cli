import type { LocalContext } from './local.js';
import type { WorkspacePlan } from './types.js';

/** Follow a bound document identity through a local rename without guessing by filename. */
export function deletionPath(context: LocalContext, id: string): string {
  const original = context.state.entries[id]!.path;
  const root = context.state.documents[original]?.rootId;
  return (
    [...context.parsed].find(([, document]) => document.metadata?.root === root)?.[0] ?? original
  );
}

/** Missing bound identities are local deletion intent, not remote discovery. */
export function planDeletion(context: LocalContext): WorkspacePlan['deletion'] {
  const missing = new Set<string>();
  for (const [path, old] of context.baseline) {
    const current = new Set(context.parsed.get(path)!.nodes.map((node) => node.key));
    for (const node of old.nodes)
      if (node.kind !== 'mount' && !current.has(node.key)) missing.add(node.key);
  }
  for (const path of context.missing)
    for (const id of context.state.documents[path]!.nodeIds) missing.add(id);
  if (!missing.size) return undefined;

  for (const id of missing) {
    const rem = context.native.get(id);
    if (!rem) throw new Error(`Deleted local identity has no sealed native baseline: ${id}`);
    if (rem.feedback) throw new Error(`Cannot delete feedback-partitioned source: ${id}`);
    if (rem.unsupported) throw new Error(`Cannot delete unsupported native content: ${id}`);
    if (context.state.rootIds.includes(id))
      throw new Error(`Cannot delete an imported scope root: ${id}`);
    for (const child of rem.children)
      if (!missing.has(child))
        throw new Error(
          `Cannot delete ${id} while a native descendant remains in local source: ${child}`
        );
  }
  const referencedIds = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(referencedIds);
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    if (item.i === 'q' && typeof item._id === 'string') return [item._id];
    return Object.values(item).flatMap(referencedIds);
  };
  for (const [path, document] of context.parsed)
    for (const node of document.nodes) {
      if (node.kind === 'mount' || missing.has(node.key)) continue;
      const target = referencedIds([node.text, node.backText]).find((id) => missing.has(id));
      if (target)
        throw new Error(`Local reference in ${path} still points to deleted identity ${target}`);
    }
  const roots = [...missing].filter((id) => !missing.has(context.native.get(id)!.parent ?? ''));
  for (const id of roots) {
    const parent = context.native.get(id)!.parent;
    if (parent && !context.native.has(parent))
      throw new Error(`Cannot verify external deletion parent: ${id}`);
  }
  const ids: string[] = [];
  function visit(id: string): void {
    for (const child of context.native.get(id)!.children) visit(child);
    ids.push(id);
  }
  for (const id of roots.sort()) visit(id);
  if (ids.length !== missing.size) throw new Error('Invalid deletion graph');
  if (ids.length > 100)
    throw new Error('One sync is limited to 100 deleted identities; split the local deletion');
  return { roots: roots.map((id) => ({ id, parent: context.native.get(id)!.parent })), ids };
}
