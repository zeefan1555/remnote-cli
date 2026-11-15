import { immutableProjection } from './snapshots.js';
import { hash, type EditGuard, type WorkspaceChange, type WorkspaceRem } from './types.js';

export interface RelationOperation {
  suffix: string;
  kind: 'tag' | 'powerup';
  value: string;
  enabled: boolean;
}

/** Relationships are checked against exact expected sets; no field is exempted from the guard. */
export function editGuard(
  rem: WorkspaceRem,
  tags: string[],
  powerups: Record<string, boolean>
): EditGuard {
  const { tags: _tags, powerupStates: _powerups, ...invariant } = immutableProjection(rem);
  if (!Array.isArray(rem.cards) || rem.cards.some((card) => !Array.isArray(card.repetitionHistory)))
    throw new Error('Exact Card identities and review history are required for structural edits');
  const cards = [...rem.cards].sort((a, b) => a.id.localeCompare(b.id));
  const cardIds = cards.map((card) => card.id).sort();
  if (new Set(cardIds).size !== cardIds.length) throw new Error('Duplicate native Card identities');
  return {
    id: rem.id,
    invariantHash: hash(invariant),
    cardIds,
    reviewHash: hash(
      cards.map(({ id, createdAt, repetitionHistory }) => ({
        id,
        createdAt,
        repetitionHistory,
      }))
    ),
    tags: [...tags].sort(),
    powerups: { ...powerups },
  };
}

/** Compact evidence of complete live history; never copy private history bodies to a receipt. */
export function cardEvidence(guards: EditGuard[]) {
  return Object.fromEntries(
    guards.map(({ id, cardIds, reviewHash }) => [id, { cardIds: [...cardIds], reviewHash }])
  );
}

/** Guard the exact same fresh snapshots as the revision check, before supplemental facts merge. */
export function snapshotEditGuards(
  native: ReadonlyMap<string, WorkspaceRem>,
  ids: string[],
  codes: string[]
): EditGuard[] {
  return [...ids].sort().map((id) => {
    const rem = native.get(id);
    if (
      !rem ||
      !Array.isArray(rem.tags) ||
      new Set(rem.tags).size !== rem.tags.length ||
      codes.some((code) => typeof rem.powerupStates?.[code] !== 'boolean')
    )
      throw new Error(`Incomplete exact native edit relationships: ${id}`);
    return editGuard(
      rem,
      rem.tags,
      Object.fromEntries(codes.map((code) => [code, rem.powerupStates![code]!]))
    );
  });
}

export function relationOperations(
  change: WorkspaceChange,
  guard?: EditGuard
): RelationOperation[] {
  const operations: RelationOperation[] = [];
  const tags = change.relations?.tags;
  if (tags !== undefined) {
    for (const id of [...(guard?.tags ?? [])].sort())
      if (!tags.includes(id))
        operations.push({ suffix: `tag-remove:${id}`, kind: 'tag', value: id, enabled: false });
    for (const id of tags)
      if (!guard?.tags.includes(id))
        operations.push({ suffix: `tag-add:${id}`, kind: 'tag', value: id, enabled: true });
  }
  for (const [code, enabled] of Object.entries(change.relations?.powerups ?? {}).sort()) {
    if (!enabled) throw new Error('Powerup slot removal is not supported');
    if (guard?.powerups[code] !== enabled)
      operations.push({ suffix: `powerup:${code}`, kind: 'powerup', value: code, enabled });
  }
  return operations;
}

export function applyRelation(rem: WorkspaceRem, operation: RelationOperation): WorkspaceRem {
  if (operation.kind === 'powerup')
    return {
      ...rem,
      powerupStates: { ...rem.powerupStates, [operation.value]: operation.enabled },
    };
  const tags = new Set(rem.tags ?? []);
  if (operation.enabled) tags.add(operation.value);
  else tags.delete(operation.value);
  return { ...rem, tags: [...tags].sort() };
}

export function advanceEditGuard(
  guards: EditGuard[],
  id: string,
  operation: RelationOperation
): void {
  const guard = guards.find((value) => value.id === id);
  if (!guard) return; // New Rems are checked by their exact constructor and journal effects.
  if (operation.kind === 'powerup') guard.powerups[operation.value] = operation.enabled;
  else {
    const tags = new Set(guard.tags);
    if (operation.enabled) tags.add(operation.value);
    else tags.delete(operation.value);
    guard.tags = [...tags].sort();
  }
}

export function guardRelations(native: Map<string, WorkspaceRem>, guards: EditGuard[]): void {
  for (const guard of guards) {
    const rem = native.get(guard.id);
    if (rem)
      native.set(guard.id, {
        ...rem,
        tags: guard.tags,
        ...(Object.keys(guard.powerups).length
          ? { powerupStates: { ...rem.powerupStates, ...guard.powerups } }
          : {}),
      });
  }
}
