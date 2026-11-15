import { PORTAL_TYPE, RemType } from '../sdk-constants.generated.js';
import type { NativeMetadata, WorkspaceMetadata } from './metadata.js';
import type { WorkspaceRem } from './types.js';

const referenceTypes = new Set<number>([PORTAL_TYPE.PORTAL, PORTAL_TYPE.SEARCH_PORTAL]);

export function isReferencePortal(
  rem: Pick<WorkspaceRem, 'type' | 'cardItem' | 'document' | 'folder' | 'portal'>
): boolean {
  return (
    rem.type === RemType.PORTAL &&
    rem.cardItem === false &&
    rem.document === false &&
    rem.folder === false &&
    typeof rem.portal?.type === 'number' &&
    referenceTypes.has(rem.portal.type) &&
    Array.isArray(rem.portal.directlyIncludedRemIds)
  );
}

function knownPortal(native: NativeMetadata): boolean {
  return isReferencePortal({
    type: native.type,
    cardItem: native.isCardItem,
    document: native.isDocument,
    folder: native.isFolder,
    portal: native.portal,
  });
}

/** Unknown subtype stays unknown. Only this documented, fully observed empty wrapper shape is folded. */
export function emptyReferenceWrappers(byId: ReadonlyMap<string, WorkspaceRem>): Set<string> {
  const result = new Set<string>();
  for (const parent of byId.values()) {
    if (!isReferencePortal(parent) || parent.portal?.type !== PORTAL_TYPE.SEARCH_PORTAL) continue;
    for (const id of parent.children) {
      const child = byId.get(id);
      if (
        child &&
        parent.portal.directlyIncludedRemIds!.includes(id) &&
        child.type === RemType.PORTAL &&
        child.cardItem === false &&
        child.document === false &&
        child.folder === false &&
        Array.isArray(child.text) &&
        child.text.length === 0 &&
        child.backText === null &&
        child.children.length === 0 &&
        Array.isArray(child.cards) &&
        child.cards.length === 0 &&
        child.portal?.type === null &&
        Array.isArray(child.portal.directlyIncludedRemIds) &&
        child.portal.directlyIncludedRemIds.length > 0
      )
        result.add(id);
    }
  }
  return result;
}

/** A displayed native reference needs a real Obsidian target, even when its target is a helper. */
export function nativeReferenceTargets(byId: ReadonlyMap<string, WorkspaceRem>): Set<string> {
  const targets = new Set<string>();
  function rich(value: unknown): void {
    if (Array.isArray(value)) for (const part of value) rich(part);
    else if (value && typeof value === 'object') {
      const part = value as Record<string, unknown>;
      if (part.i === 'q' && typeof part._id === 'string') targets.add(part._id);
    }
  }
  for (const rem of byId.values()) {
    rich(rem.text);
    rich(rem.backText);
    for (const id of rem.references ?? []) targets.add(id);
    for (const id of rem.portal?.directlyIncludedRemIds ?? [])
      if (!(
        isReferencePortal(rem) &&
        rem.portal?.type === PORTAL_TYPE.SEARCH_PORTAL &&
        rem.children.includes(id)
      ))
        targets.add(id);
  }
  return targets;
}

/** Only verified portal-only native branches may be folded. Missing Markdown never defines this set. */
export function referenceBranches(
  metadata: WorkspaceMetadata
): Map<string, { ids: string[]; targets: string[] }> {
  const result = new Map<string, { ids: string[]; targets: string[] }>();
  function collect(
    id: string,
    visiting: Set<string>
  ): { ids: string[]; targets: string[] } | undefined {
    if (visiting.has(id)) return;
    const entry = metadata.rems[id];
    if (visiting.size && entry?.id !== null && entry?.projection === 'anchor-required') return;
    if (
      !entry ||
      entry.id === null ||
      !(knownPortal(entry.native) || entry.projection === 'reference-wrapper') ||
      entry.native.children === null
    )
      return;
    const ids = [id],
      targets = [...entry.native.portal!.directlyIncludedRemIds!];
    for (const child of entry.native.children) {
      const branch = collect(child, new Set([...visiting, id]));
      if (!branch) return;
      ids.push(...branch.ids);
      targets.push(...branch.targets);
    }
    return { ids, targets: [...new Set(targets)].filter((target) => !ids.includes(target)) };
  }
  for (const id of Object.keys(metadata.rems)) {
    const branch = collect(id, new Set());
    if (branch) result.set(id, branch);
  }
  return result;
}
