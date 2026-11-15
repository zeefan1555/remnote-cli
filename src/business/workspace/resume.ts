import {
  contentProjection,
  publicationRevisionHash,
  revisionHash,
  withNativeSnapshot,
} from './snapshots.js';
import {
  hash,
  type SyncPlan,
  type SyncSelection,
  type WorkspaceChange,
  type WorkspaceRem,
} from './types.js';

export interface Journal {
  version: 2;
  planHash: string;
  guardHash: string;
  state: 'preview' | 'applying' | 'verified' | 'unknown' | 'conflict';
  steps: Record<string, 'started' | 'verified' | 'unknown'>;
  ids: Record<string, string>;
  selection: SyncSelection;
  /** Exact-ID resume collected tags on created Rems; recovery must use the same projection. */
  resumed?: true;
  final?: {
    hashes: Record<string, string>;
    inputHash: string;
    deleted: string[];
    structuralIds: string[];
  };
}

/** Fold the one attempted prefix, never infer a new plan from the current remote state. */
export function foldResume(plan: SyncPlan, journal: Journal, initial: Map<string, WorkspaceRem>) {
  if (
    plan.deletion ||
    plan.incoming.length ||
    plan.converged.length ||
    plan.resolutions.length ||
    plan.conflicts.length
  )
    throw new Error(
      'Resume requires an exactly reconstructible outgoing-only plan; preserve this journal'
    );
  const expected = structuredClone(initial),
    structuralIds = new Set<string>();
  const sequence: Array<{
    key: string;
    change: WorkspaceChange;
    operation: 'create' | 'text' | 'backText' | 'parent' | 'cardItem';
  }> = [];
  for (const change of plan.changes) {
    const operations: Array<(typeof sequence)[number]['operation']> = [];
    if (change.key.startsWith('new:')) operations.push('create');
    for (const field of ['text', 'backText'] as const)
      if (change.fields[field] !== undefined) operations.push(field);
    if (change.key.startsWith('new:')) {
      operations.push('parent');
      if (change.cardItem) operations.push('cardItem');
    }
    for (const operation of operations)
      sequence.push({ key: `${change.key}:${operation}`, change, operation });
  }
  const entries = Object.entries(journal.steps),
    assigned = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const [key, status] = entries[i]!,
      step = sequence[i];
    if (
      !step ||
      step.key !== key ||
      !['verified', 'started', 'unknown'].includes(status) ||
      (status !== 'verified' && i !== entries.length - 1)
    )
      throw new Error(
        'Resume journal must be one contiguous verified prefix and at most one final uncertain step'
      );
    const { change, operation } = step;
    const isNew = change.key.startsWith('new:'),
      id = isNew ? journal.ids[change.key] : change.key;
    if (!id)
      throw new Error('Unknown creation has no persisted ID; never recreate or search by title');
    if (operation === 'create') {
      if (expected.has(id) || assigned.has(id) || !/^[A-Za-z0-9_-]+$/.test(id))
        throw new Error('Resume journal contains an invalid or duplicate creation identity');
      assigned.add(id);
      expected.set(id, {
        id,
        parent: null,
        children: [],
        type: null,
        text: change.kind === 'multiline' ? ['Workspace question'] : [],
        backText: change.kind === 'multiline' ? [] : null,
        document: false,
        folder: false,
        cardItem: false,
        practice: 'forward',
        enablePractice: true,
      });
    } else {
      const rem = expected.get(id);
      if (!rem) throw new Error('Resume step has no proven native identity');
      if (operation === 'parent') {
        const parent = change.parent?.startsWith('new:')
          ? journal.ids[change.parent]
          : change.parent;
        const p = parent ? expected.get(parent) : undefined;
        if (
          !parent ||
          !p ||
          rem.parent !== null ||
          p.children.includes(id) ||
          change.position > p.children.length
        )
          throw new Error('Resume parent step has an inconsistent ordered graph');
        const children = [...p.children];
        children.splice(change.position, 0, id);
        expected.set(id, { ...rem, parent });
        expected.set(parent, { ...p, children });
        structuralIds.add(parent);
      } else if (operation === 'cardItem') expected.set(id, { ...rem, cardItem: change.cardItem });
      else expected.set(id, { ...rem, [operation]: change.fields[operation] });
    }
  }
  if (
    Object.values(journal.ids).length !== assigned.size ||
    Object.entries(journal.ids).some(
      ([key, id]) => !assigned.has(id) || !entries.some(([step]) => step === `${key}:create`)
    )
  )
    throw new Error('Resume creation IDs do not match the attempted prefix');
  return {
    expected,
    structuralIds,
    recognized: entries.filter(([, status]) => status !== 'verified').map(([key]) => key),
  };
}

/** Old journals do not contain creation snapshots. Accept only provable default shapes and recorded effects. */
export function verifyResumeReadback(
  expected: Map<string, WorkspaceRem>,
  fresh: Map<string, WorkspaceRem>,
  createdIds: Set<string>
): Map<string, WorkspaceRem> {
  const result = new Map<string, WorkspaceRem>();
  for (const [id, intended] of expected) {
    const actual = fresh.get(id);
    if (!actual) throw new Error(`Resume is missing exact native ID ${id}`);
    if (!createdIds.has(id)) {
      const merged = withNativeSnapshot(intended, actual);
      if (publicationRevisionHash(merged) !== publicationRevisionHash(intended))
        throw new Error(`Concurrent remote change during resume on ${id}`);
      result.set(id, merged);
      continue;
    }
    // Read tags explicitly: ordinary native snapshots do not collect them. Do not bless current metadata.
    const changedFacts = Object.entries(actual.facts ?? {})
      .filter(
        ([key, value]) =>
          !(
            ['createdAt', 'localUpdatedAt', 'updatedAt'].includes(key) ||
            value === false ||
            value === null ||
            (['aliasRemIds', 'sourceRemIds'].includes(key) &&
              Array.isArray(value) &&
              value.length === 0)
          )
      )
      .map(([key]) => `facts.${key}`);
    const forward =
      Array.isArray(intended.backText) &&
      (intended.backText.length > 0 ||
        intended.children.some((child) => expected.get(child)?.cardItem));
    const cards = actual.cards;
    if (
      changedFacts.length ||
      actual.unsupported ||
      !Array.isArray(actual.tags) ||
      actual.tags.length ||
      (actual.powerups?.length ?? 0) ||
      (actual.propertyValues?.length ?? 0) ||
      actual.portal ||
      !Array.isArray(cards) ||
      cards.length !== (forward ? 1 : 0) ||
      cards.some((card) => card.remId !== id || card.type !== 'forward') ||
      hash(contentProjection(actual)) !== hash(contentProjection(intended)) ||
      revisionHash(actual) !== revisionHash({ ...actual, ...intended })
    ) {
      const observed = { ...actual, ...contentProjection(actual) },
        wanted = { ...intended, ...contentProjection(intended) };
      const fields = [
        ...Object.entries(wanted)
          .filter(([key, value]) => hash(observed[key as keyof WorkspaceRem]) !== hash(value))
          .map(([key]) => key),
        ...changedFacts,
        ...(actual.unsupported ? ['unsupported'] : []),
        ...(!Array.isArray(actual.tags) || actual.tags.length ? ['tags'] : []),
        ...(actual.powerups?.length ? ['powerups'] : []),
        ...(actual.propertyValues?.length ? ['propertyValues'] : []),
        ...(actual.portal ? ['portal'] : []),
        ...(!Array.isArray(cards) ||
        cards.length !== (forward ? 1 : 0) ||
        cards.some((card) => card.remId !== id || card.type !== 'forward')
          ? ['cards']
          : []),
      ];
      throw new Error(
        `Resume created Rem differs from its proven default shape and journal effects: ${id} ` +
          `(fields: ${[...new Set(fields)].join(', ') || 'nativeRevision'})`
      );
    }
    // New card identities are first observed here, not claimed to be a historical checkpoint.
    result.set(id, actual);
  }
  return result;
}
