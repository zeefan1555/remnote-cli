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
import { nativeProof } from './outline.js';
import type { ContentVersion } from './types.js';

export interface Journal {
  version: 2;
  /** Missing on legacy evidence, which is readable but cannot execute. */
  contentAuthority?: 'local';
  planHash: string;
  guardHash: string;
  state: 'preview' | 'applying' | 'verified' | 'unknown' | 'conflict';
  steps: Record<string, 'started' | 'verified' | 'unknown'>;
  ids: Record<string, string>;
  selection: SyncSelection;
  /** Exact-ID resume collected tags on created Rems; recovery must use the same projection. */
  resumed?: true;
  /** Original input-bound proof is sealed by planHash before the first SDK mutation. */
  proof?: { plan: SyncPlan; nativeBefore: Record<string, ReturnType<typeof nativeProof>> };
  final?: {
    hashes: Record<string, string>;
    inputHash: string;
    deleted: string[];
    structuralIds: string[];
    publicationIds: string[];
    /** Sealed legacy evidence only; new journals omit it. */
    remoteVersions?: Record<string, ContentVersion>;
    publishedBaselineHash: string;
    proofHash: string;
  };
}

/** Detect accidental proof corruption/mismatches; a writer can recompute this checksum. */
export function finalProofHash(journal: Journal): string {
  const { proofHash: _proofHash, ...final } = journal.final!;
  return hash({
    planHash: journal.planHash,
    selection: journal.selection,
    ids: journal.ids,
    final,
  });
}

export function requireFinalProof(journal: Journal): NonNullable<Journal['final']> {
  requireLocalAuthority(journal, journal.planHash);
  const final = journal.final;
  if (
    !final ||
    !Array.isArray(final.publicationIds) ||
    !Array.isArray(final.structuralIds) ||
    !Array.isArray(final.deleted) ||
    !final.hashes ||
    !/^[a-f0-9]{64}$/.test(final.publishedBaselineHash ?? '') ||
    !/^[a-f0-9]{64}$/.test(final.inputHash ?? '') ||
    final.proofHash !== finalProofHash(journal) ||
    hash(final.publicationIds) !== hash([...new Set(final.publicationIds)].sort()) ||
    final.publicationIds.some((id) => !Object.hasOwn(final.hashes, id))
  )
    throw new Error('Missing or inconsistent verified publication proof; preserve the journal');
  return final;
}

/** Complete projected semantic baseline: includes unchanged/deleted identities, excludes review clocks/history. */
export function publishedBaselineHash(journal: Journal, native: Map<string, WorkspaceRem>): string {
  const final = journal.final!;
  const ids = [
    ...new Set([
      ...journal.selection.reconcileIds,
      ...journal.selection.verificationIds,
      ...Object.values(journal.ids),
      ...Object.keys(final.hashes),
      ...final.deleted,
    ]),
  ].sort();
  return hash(
    ids.map((id) => [id, native.has(id) ? publicationRevisionHash(native.get(id)!) : null])
  );
}

export function guardedBinding(journal: Journal) {
  if (!journal.proof) return undefined;
  const binding = journal.proof.plan.guarded;
  if (
    !binding ||
    hash(journal.proof.plan) !== journal.planHash ||
    hash(journal.proof.nativeBefore) !== binding.beforeHash ||
    hash(journal.proof.plan.selection) !== hash(journal.selection)
  )
    throw new Error(
      'Original guarded proof binding was modified; preserve the journal without replay'
    );
  return binding;
}

/** Fold the one attempted prefix, never infer a new plan from the current remote state. */
export function foldResume(plan: SyncPlan, journal: Journal, initial: Map<string, WorkspaceRem>) {
  requireLocalAuthority(journal, journal.planHash);
  if (plan.deletion || plan.converged.length || plan.conflicts.length)
    throw new Error(
      'Resume requires an exactly reconstructible outgoing-only plan; preserve this journal'
    );
  const expected = structuredClone(initial),
    structuralIds = new Set<string>();
  const sequence: Array<{
    key: string;
    change: WorkspaceChange;
    operation: 'create' | 'text' | 'backText' | 'parent' | 'cardItem' | 'tag' | 'cardCluster';
    tag?: { id: string; add: boolean };
  }> = [];
  for (const change of plan.changes) {
    const operations: Array<(typeof sequence)[number]['operation']> = [];
    if (change.key.startsWith('new:')) operations.push('create');
    for (const field of ['text', 'backText'] as const)
      if (change.fields[field] !== undefined) operations.push(field);
    for (const operation of operations)
      sequence.push({ key: `${change.key}:${operation}`, change, operation });
    operations.length = 0;
    if (change.tags) {
      for (const id of change.tags.before.filter((id) => !change.tags!.after.includes(id)))
        sequence.push({
          key: `${change.key}:tag:remove:${id}`,
          change,
          operation: 'tag',
          tag: { id, add: false },
        });
      for (const id of change.tags.after.filter((id) => !change.tags!.before.includes(id)))
        sequence.push({
          key: `${change.key}:tag:add:${id}`,
          change,
          operation: 'tag',
          tag: { id, add: true },
        });
    }
    if (change.key.startsWith('new:')) {
      if (change.cardCluster) operations.push('cardCluster');
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
        tags: [],
        ...(change.cardCluster ? { powerupPresence: { cc: false } } : {}),
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
      } else if (operation === 'tag') {
        if (!Array.isArray(rem.tags) || !step.tag)
          throw new Error('Resume requires exact direct tag baseline');
        expected.set(id, {
          ...rem,
          tags: step.tag.add
            ? [...new Set([...rem.tags, step.tag.id])].sort()
            : rem.tags.filter((tag) => tag !== step.tag!.id),
        });
      } else if (operation === 'cardCluster')
        expected.set(id, { ...rem, powerupPresence: { ...rem.powerupPresence, cc: true } });
      else if (operation === 'cardItem') expected.set(id, { ...rem, cardItem: change.cardItem });
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
      hash(actual.tags) !== hash(intended.tags ?? []) ||
      Object.entries(intended.powerupPresence ?? {}).some(
        ([code, present]) => actual.powerupPresence?.[code] !== present
      ) ||
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

/** Old journals remain intact for reconciliation, never executable under new source authority. */
export function requireLocalAuthority(journal: Journal, reference: string): void {
  const legacy = journal.proof?.plan as
    (SyncPlan & { incoming?: unknown; resolutions?: unknown; winner?: unknown }) | undefined;
  if (
    journal.contentAuthority !== 'local' ||
    journal.final?.remoteVersions !== undefined ||
    (legacy &&
      (legacy.contentAuthority !== 'local' ||
        'incoming' in legacy ||
        'resolutions' in legacy ||
        'winner' in legacy))
  )
    throw new Error(
      `Legacy or mixed-authority journal is evidence only; preserve exact journal ${reference}. Manual reconciliation required; no writes or replay.`
    );
}
