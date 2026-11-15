import type { LocalContext } from './local.js';
import { idSchema } from './identity.js';
import { publicRevision, withPublicSnapshot } from './snapshots.js';
import { hash, type WorkspaceBackend, type WorkspacePlan, type WorkspaceRem } from './types.js';

/** Existing identities and their relative order are never inferred from a newly observed branch. */
function additiveChildren(before: WorkspaceRem, after: WorkspaceRem): boolean {
  const known = new Set(before.children);
  return (
    hash(before.children) === hash(after.children.filter((id) => known.has(id))) &&
    new Set(after.children).size === after.children.length
  );
}

/** Exact child links are the only discovery authority; references/portal members are not roots. */
export async function readIncoming(
  context: LocalContext,
  plan: WorkspacePlan,
  remote: Map<string, WorkspaceRem>,
  backend: WorkspaceBackend,
  assigned: ReadonlySet<string> = new Set()
): Promise<string[]> {
  if (plan.deletion) return [];
  const parents = new Map<string, string>();
  const queue: string[] = [];
  function enqueue(parent: WorkspaceRem): void {
    for (const child of parent.children) {
      idSchema.parse(child);
      if (assigned.has(child)) continue;
      if (context.native.has(child)) {
        if (context.native.get(child)!.parent !== parent.id)
          throw new Error(`Incoming branch moves an existing native identity: ${child}`);
        continue;
      }
      if (parents.has(child)) throw new Error(`Duplicate/cyclic incoming child identity: ${child}`);
      parents.set(child, parent.id);
      if (parents.size > 100000) throw new Error('Incoming descendants exceed 100000 Rem bound');
      queue.push(child);
    }
  }
  for (const id of plan.selection?.reconcileIds ?? context.native.keys()) {
    const before = context.native.get(id)!,
      after = remote.get(id);
    if (!after || !additiveChildren(before, after) || before.parent !== after.parent) continue;
    // Leave moves/reorders to the ordinary structural conflict path, without importing their trees.
    if (
      after.children.some(
        (child) => context.native.has(child) && context.native.get(child)!.parent !== id
      )
    )
      continue;
    enqueue(after);
  }
  while (queue.length) {
    const batch = queue.splice(0, 50),
      rems = await backend.read(batch, { tags: true });
    if (
      rems.length !== batch.length ||
      new Set(rems.map((rem) => rem.id)).size !== batch.length ||
      rems.some((rem) => !batch.includes(rem.id))
    )
      throw new Error('Incomplete exact incoming descendant read');
    for (const rem of rems) {
      if (
        rem.parent !== parents.get(rem.id) ||
        !Array.isArray(rem.tags) ||
        !Array.isArray(rem.cards) ||
        !rem.public ||
        new Set(rem.cards.map((card) => card.id)).size !== rem.cards.length ||
        rem.cards.some((card) => card.remId !== rem.id) ||
        [rem.document, rem.folder, rem.cardItem, rem.practice, rem.enablePractice].some(
          (value) => value === null
        )
      )
        throw new Error(`Incomplete incoming native facts or disagreeing parent: ${rem.id}`);
      if (hash(publicRevision(rem)) !== hash(publicRevision(withPublicSnapshot(rem, rem.public))))
        throw new Error(`Disagreeing incoming public/native snapshot: ${rem.id}`);
      if (
        rem.type === 6 &&
        (!rem.portal ||
          !Array.isArray(rem.portal.directlyIncludedRemIds) ||
          rem.portal.query === undefined ||
          rem.portal.filter === undefined)
      )
        throw new Error(`Incoming Portal query facts were not completely read: ${rem.id}`);
      remote.set(rem.id, rem);
      enqueue(rem);
    }
  }
  const added = [...parents.keys()].sort();
  if (plan.selection?.addedIds && hash(plan.selection.addedIds) !== hash(added))
    throw new Error('Incoming ID set changed after verified sync');
  return added;
}
