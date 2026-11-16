import type { LocalContext } from './local.js';
import { hash, type FeedbackRoles, type WorkspacePlan, type WorkspaceRem } from './types.js';
import { nodeKind } from './markdown.js';

/** Only exact, observed empty feedback partitions may participate in deletion. */
export function requireEmptyDeletionFeedback(rem: WorkspaceRem, roles?: FeedbackRoles): void {
  if (!roles) {
    throw new Error(
      'Deletion requires bound exact TODO/DONE feedback roles; no native writes were started'
    );
  }
  if (
    !rem.feedback ||
    hash(rem.feedback.roles) !== hash(roles) ||
    !Array.isArray(rem.feedback.attachmentIds) ||
    rem.feedback.attachmentIds.length ||
    !Array.isArray(rem.tags) ||
    rem.tags.includes(roles.todoTagId) ||
    rem.tags.includes(roles.doneTagId)
  )
    throw new Error(`Feedback or unknown feedback partition prevents deletion: ${rem.id}`);
}

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
    if (rem.unsupported) throw new Error(`Cannot delete unsupported native content: ${id}`);
    if (context.state.rootIds.includes(id))
      throw new Error(`Cannot delete an imported scope root: ${id}`);
    if (rem.parent && !missing.has(rem.parent)) {
      const parent = context.native.get(rem.parent);
      if (!parent) throw new Error(`Cannot verify external deletion parent: ${id}`);
      if (parent.unsupported || nodeKind(parent, context.native) === 'opaque')
        throw new Error(
          `Cannot verify deletion parent native identity and structure: ${rem.parent}`
        );
      if (rem.cardItem === true || nodeKind(parent, context.native) === 'multiline')
        throw new Error(`Cannot delete an individual answer from an existing card: ${id}`);
    }
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
      const native = context.native.get(node.key);
      const target = [
        ...referencedIds([
          node.text,
          node.backText,
          ...(node.kind === 'opaque' && native ? [native.text, native.backText] : []),
        ]),
        ...(node.readonlyLinks ?? []).map((link) => link.id),
        ...(native?.references ?? []),
        ...(native?.portal?.directlyIncludedRemIds ?? []),
      ].find((id) => missing.has(id));
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

/** Apply feedback guards only to selected deletions, not unrelated local edits. */
export function requireSelectedDeletionFeedback(
  context: LocalContext,
  deletion: NonNullable<WorkspacePlan['deletion']>
): void {
  const roles = context.state.feedbackRoles;
  if (!roles)
    throw new Error(
      'Deletion requires bound exact TODO/DONE feedback roles; no native writes were started'
    );
  if (deletion.ids.some((id) => id === roles.todoTagId || id === roles.doneTagId))
    throw new Error('Cannot delete a bound TODO/DONE feedback role');
  for (const id of [
    ...deletion.ids,
    ...deletion.roots.flatMap((root) => (root.parent ? [root.parent] : [])),
  ]) {
    const rem = context.native.get(id)!;
    if (
      !Array.isArray(rem.tags) ||
      rem.tags.includes(roles.todoTagId) ||
      rem.tags.includes(roles.doneTagId)
    )
      throw new Error(`Feedback or unknown feedback partition prevents deletion: ${id}`);
    // Missing feedback is unproven, not empty. Live reads must prove it before writes.
    if (rem.feedback) requireEmptyDeletionFeedback(rem, roles);
  }
}
