import { cardMetadataSchema } from './metadata.js';
import { nativeProof } from './outline.js';
import { cardIdentities } from './snapshots.js';
import { hash, type SyncPlan, type WorkspaceRem } from './types.js';

export type HistoryProof = { cardIds: string[]; reviewHash: string };
export type HistoryGuard = {
  version: 1;
  requested: string[];
  proofs: Record<string, HistoryProof>;
  binding: string;
};
export class HistoryChangedError extends Error {}

/** Only Rems directly mutated or whose physical child edge is mutated can affect existing Cards. */
export function historyCandidates(
  plan: SyncPlan,
  native: Map<string, WorkspaceRem>,
  requested: string[]
): string[] {
  const ids = new Set(requested);
  const deleted = new Set(plan.deletion?.ids ?? []);
  function include(id: string | null | undefined): void {
    if (!id || id.startsWith('new:') || deleted.has(id)) return;
    const visited = new Set<string>();
    let current: string = id;
    while (true) {
      const rem = native.get(current);
      if (!rem || typeof rem.cardItem !== 'boolean' || visited.has(current))
        throw new Error(`Native card owner cannot be determined: ${id}`);
      visited.add(current);
      ids.add(current);
      if (!rem.cardItem) break;
      if (!rem.parent || deleted.has(rem.parent))
        throw new Error(`Native card owner cannot be determined: ${id}`);
      current = rem.parent;
    }
  }
  for (const change of plan.changes)
    include(change.key.startsWith('new:') ? change.parent : change.key);
  for (const root of plan.deletion?.roots ?? []) include(root.parent);
  return [...ids].sort();
}

/** A missing raw cards field or history is unknown; an observed empty history is valid. */
export function observedHistory(
  rem: WorkspaceRem | undefined,
  id: string,
  requireCard = false
): HistoryProof {
  if (!rem || !Array.isArray(rem.cards)) throw new Error(`Native card history unavailable: ${id}`);
  const cards = rem.cards;
  if (
    (requireCard && !cards.length) ||
    new Set(cards.map((card) => card?.id)).size !== cards.length ||
    cards.some(
      (card) =>
        !cardMetadataSchema.safeParse(card).success ||
        card.remId !== id ||
        typeof card.createdAt !== 'number' ||
        !Number.isFinite(card.createdAt) ||
        !Array.isArray(card.repetitionHistory)
    )
  )
    throw new Error(`Native card history unavailable: ${id}`);
  const proof = nativeProof(rem);
  if (!proof.cardIds || !proof.reviewHash)
    throw new Error(`Native card history unavailable: ${id}`);
  return { cardIds: proof.cardIds, reviewHash: proof.reviewHash };
}

export function assertKnownCardIdentities(baseline: WorkspaceRem, fresh: WorkspaceRem): void {
  if (
    Array.isArray(baseline.cards) &&
    hash(cardIdentities(baseline)) !== hash(cardIdentities(fresh))
  )
    throw new Error(`Native card identity changed: ${baseline.id}`);
}
export function historyBinding(
  planHash: string,
  requested: string[],
  proofs: Record<string, HistoryProof>
): string {
  return hash({ version: 1, planHash, requested, proofs });
}
export function requireUnchangedHistory(
  guard: HistoryGuard,
  id: string,
  rem: WorkspaceRem | undefined
): void {
  const before = guard.proofs[id];
  if (!before) return;
  try {
    const current = observedHistory(rem, id, guard.requested.includes(id));
    if (hash(current) !== hash(before)) throw new Error('history differs');
  } catch {
    throw new HistoryChangedError(`Native card history changed or became unavailable: ${id}`);
  }
}
