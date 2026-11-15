import type { LocalContext } from './local.js';
import type { WorkspacePlan } from './types.js';
import { nodeKind } from './markdown.js';

export interface DeleteOptions {
  deleteId?: string;
  scopeRoot?: string;
}

/** Explicit authorization boundary, separate from Markdown absence. */
export function planDeletion(
  context: LocalContext,
  options: DeleteOptions
): WorkspacePlan['deletion'] {
  if (!options.deleteId && !options.scopeRoot) return undefined;
  if (!options.deleteId || !options.scopeRoot)
    throw new Error('Explicit deletion requires both --delete-id and --scope-root');
  const target = context.native.get(options.deleteId),
    scope = context.native.get(options.scopeRoot);
  if (!target || !scope || target.id === scope.id)
    throw new Error('Delete target must be an existing descendant, not the scope root');
  let ancestor = target.parent ? context.native.get(target.parent) : undefined;
  let within = false;
  while (ancestor) {
    if (ancestor.id === scope.id) within = true;
    ancestor = ancestor.parent ? context.native.get(ancestor.parent) : undefined;
  }
  if (!within) throw new Error('Delete target is outside explicit scope root');
  const parent = target.parent ? context.native.get(target.parent) : undefined;
  if (parent && nodeKind(parent, context.native) === 'multiline')
    throw new Error('Delete the whole card, not an individual answer from an existing card');
  const ids: string[] = [];
  function visit(id: string): void {
    const rem = context.native.get(id)!;
    if (rem.document || rem.folder)
      throw new Error('Workspace deletion supports notes/cards only, not native Documents/Folders');
    rem.children.forEach(visit);
    ids.push(id);
  }
  visit(target.id);
  if (ids.length > 100)
    throw new Error('Explicit deletion is limited to 100 frozen descendant IDs');
  return { rootId: target.id, scopeRoot: scope.id, ids };
}
