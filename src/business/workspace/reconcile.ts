import type { LocalContext } from './local.js';
import { nodeKind } from './markdown.js';
import {
  cardIdentities,
  contentProjection,
  immutableProjection,
  publicRevision,
  publicationRevisionHash,
  remoteEditedAt,
  withNativeSnapshot,
  withPublicSnapshot,
} from './snapshots.js';
import {
  hash,
  type SyncPlan,
  type WorkspaceBackend,
  type WorkspacePlan,
  type WorkspaceRem,
  type ContentVersion,
  type SyncConflict,
} from './types.js';
import { remoteVersion, usableVersion } from './versions.js';
import { mapReads } from './read-pool.js';

function batches(ids: string[]): string[][] {
  return Array.from({ length: Math.ceil(ids.length / 50) }, (_, index) =>
    ids.slice(index * 50, index * 50 + 50)
  );
}

/** Exact new IDs under an existing multiline; removals and moves are not inferred. */
function incomingAnswerIds(
  base: WorkspaceRem,
  current: WorkspaceRem,
  native: Map<string, WorkspaceRem>
): string[] | undefined {
  if (
    nodeKind(base, native) !== 'multiline' ||
    base.parent !== current.parent ||
    base.type !== current.type ||
    new Set(current.children).size !== current.children.length ||
    base.children.some((id) => !current.children.includes(id))
  )
    return undefined;
  const added = current.children.filter((id) => !base.children.includes(id));
  return added.some((id) => native.has(id)) ? undefined : added;
}

function incomingAnswerStructure(
  base: WorkspaceRem,
  current: WorkspaceRem,
  native: Map<string, WorkspaceRem>,
  graph: Map<string, WorkspaceRem>
): boolean {
  return (
    incomingAnswerIds(base, current, native) !== undefined &&
    Array.isArray(base.cards) &&
    base.cards.length > 0 &&
    Array.isArray(current.cards) &&
    hash(cardIdentities(base)) === hash(cardIdentities(current)) &&
    nodeKind(current, graph) === 'multiline' &&
    current.children.every((id) => {
      const child = graph.get(id);
      return (
        child !== undefined &&
        child.parent === current.id &&
        child.cardItem === true &&
        child.document === false &&
        child.folder === false &&
        child.backText === null &&
        child.children.length === 0 &&
        Array.isArray(child.cards) &&
        child.cards.length === 0 &&
        nodeKind(child, graph) === 'text'
      );
    })
  );
}

/** Exact-ID public reads are bounded; this does not claim to discover new roots in the KB. */
export async function readRemote(
  context: LocalContext,
  local: WorkspacePlan,
  backend: WorkspaceBackend
): Promise<Map<string, WorkspaceRem>> {
  const result = new Map<string, WorkspaceRem>(),
    ids = local.selection
      ? [...local.selection.reconcileIds, ...local.selection.verificationIds].sort()
      : [...context.native.keys()].sort();
  const publicReads = await mapReads(batches(ids), 4, async (batch) => {
    const seen = new Map<string, WorkspaceRem>();
    for (const snapshot of await backend.readPublic(batch)) {
      const id = snapshot.id;
      if (typeof id !== 'string' || !batch.includes(id) || seen.has(id))
        throw new Error('Malformed exact public snapshot batch');
      seen.set(id, withPublicSnapshot(context.native.get(id)!, snapshot));
    }
    return batch.flatMap((id) => (seen.has(id) ? [seen.get(id)!] : []));
  });
  for (const rem of publicReads.flat()) result.set(rem.id, rem);
  const full = new Set<string>();
  for (const id of ids) {
    const before = context.native.get(id)!;
    const current = result.get(id);
    if (
      current &&
      (hash(publicRevision(before)) !== hash(publicRevision(current)) ||
        remoteEditedAt(before) !== remoteEditedAt(current) ||
        Array.isArray(before.backText) ||
        before.cards?.length)
    )
      full.add(id);
  }
  for (const change of local.changes)
    for (const start of [change.key, change.parent]) {
      let id = start;
      while (id && context.native.has(id)) {
        if (result.has(id)) full.add(id);
        id = context.native.get(id)!.parent;
      }
    }
  for (const id of local.deletion?.ids ?? []) if (result.has(id)) full.add(id);
  for (const id of local.selection?.verificationIds ?? [])
    if (result.has(id) && context.native.get(id)!.unsupported !== 'unverified-native-flags')
      full.add(id);
  for (const id of local.selection?.reconcileIds ?? context.native.keys()) {
    const base = context.native.get(id)!,
      current = result.get(id);
    if (
      current &&
      hash(base.children) !== hash(current.children) &&
      incomingAnswerIds(base, current, context.native) !== undefined
    )
      for (const child of base.children) if (result.has(child)) full.add(child);
  }
  const fullIds = [...full].sort();
  const nativeReads = await mapReads(batches(fullIds), 4, async (batch) => {
    const rems = await backend.read(batch);
    if (
      rems.length !== batch.length ||
      new Set(rems.map((rem) => rem.id)).size !== batch.length ||
      rems.some((rem) => !batch.includes(rem.id))
    )
      throw new Error('Incomplete exact native reconciliation read');
    for (const rem of rems) {
      if (hash(publicRevision(rem)) !== hash(publicRevision(result.get(rem.id)!)))
        throw new Error(`Concurrent remote change while reading ${rem.id}`);
    }
    const byId = new Map(rems.map((rem) => [rem.id, rem]));
    return batch.map((id) => withNativeSnapshot(context.native.get(id)!, byId.get(id)!));
  });
  for (const rem of nativeReads.flat()) result.set(rem.id, rem);
  // Follow only new direct answer IDs explicitly returned by selected multiline parents.
  // This is not a recursive discovery/import, and verification dependencies stay read-only.
  const addedIds = [
    ...new Set(
      [...(local.selection?.reconcileIds ?? context.native.keys())].flatMap((id) => {
        const current = result.get(id);
        return current
          ? (incomingAnswerIds(context.native.get(id)!, current, context.native) ?? [])
          : [];
      })
    ),
  ].sort();
  const addedReads = await mapReads(batches(addedIds), 4, async (batch) => {
    const snapshots = await backend.readPublic(batch),
      rems = await backend.read(batch),
      publicById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    if (
      rems.length !== batch.length ||
      new Set(rems.map((rem) => rem.id)).size !== batch.length ||
      snapshots.length !== batch.length ||
      publicById.size !== batch.length ||
      rems.some((rem) => !batch.includes(rem.id) || !publicById.has(rem.id))
    )
      throw new Error('Incomplete exact incoming answer read');
    for (const rem of rems)
      if (
        hash(publicRevision(rem)) !==
        hash(publicRevision(withPublicSnapshot(rem, publicById.get(rem.id)!)))
      )
        throw new Error(`Concurrent incoming answer change while reading ${rem.id}`);
    return rems;
  });
  for (const rem of addedReads.flat()) result.set(rem.id, rem);
  return result;
}

export function reconcile(
  context: LocalContext,
  local: WorkspacePlan,
  remote: Map<string, WorkspaceRem>
): { plan: SyncPlan; metadataChanged: string[]; remoteVersions: Record<string, ContentVersion> } {
  const plan: SyncPlan = {
    ...local,
    changes: [...local.changes],
    remoteHashes: {},
    incoming: [],
    converged: [],
    conflicts: [],
    resolutions: [],
  };
  const remoteVersions: Record<string, ContentVersion> = { ...context.state.remoteVersions };
  const nodes = new Map(
    [...context.parsed].flatMap(([path, doc]) =>
      doc.nodes
        .filter((node) => node.kind !== 'mount')
        .map((node) => [node.key, { path, node }] as const)
    )
  );
  const metadataChanged: string[] = [];
  const incomingStructures = new Map<string, SyncConflict>();
  const graph = new Map([...context.native, ...remote]);
  for (const id of local.selection?.reconcileIds ?? context.native.keys()) {
    const base = context.native.get(id)!;
    const { path, node } = nodes.get(id)!,
      current = remote.get(id);
    const localRem =
      node.kind === 'opaque'
        ? base
        : {
            ...base,
            text: node.text,
            ...(node.kind === 'basic' ? { backText: node.backText } : {}),
          };
    const baseHash = hash(contentProjection(base)),
      localHash = hash(contentProjection(localRem));
    const remoteHash = current ? hash(contentProjection(current)) : null;
    const conflict = (reason: 'untrusted-edit-order' | 'remote-structure' | 'remote-missing') =>
      plan.conflicts.push({
        id,
        path,
        reason,
        baseHash,
        localHash,
        remoteHash,
        remoteUpdatedAt: current ? remoteEditedAt(current) : null,
      });
    if (!current) {
      conflict('remote-missing');
      continue;
    }
    plan.remoteHashes[id] = publicationRevisionHash(current);
    const localVersion = context.state.localVersions?.[id],
      nativeVersion = remoteVersion(current, context.state.remoteVersions?.[id], baseHash);
    remoteVersions[id] = nativeVersion;
    const localEdited = localHash !== baseHash || localVersion?.contentHash === localHash,
      remoteEdited = remoteHash !== baseHash || nativeVersion.sinceBaseline === true;
    if (hash(base) !== hash(current)) metadataChanged.push(id);
    // Moves/removals remain conflicts. Read-only direct answer insertion/reordering
    // is accepted only with the original multiline Card identity and verified leaf facts.
    if (
      base.parent !== current.parent ||
      base.type !== current.type ||
      (base.document !== null && base.document !== current.document) ||
      (base.folder !== null && base.folder !== current.folder)
    ) {
      conflict('remote-structure');
      continue;
    }
    if (hash(base.children) !== hash(current.children)) {
      if (localEdited || !incomingAnswerStructure(base, current, context.native, graph)) {
        conflict('remote-structure');
        continue;
      }
      incomingStructures.set(id, {
        id,
        path,
        reason: 'remote-structure',
        baseHash,
        localHash,
        remoteHash,
        remoteUpdatedAt: remoteEditedAt(current),
      });
    }
    if (
      local.deletion?.ids.includes(id) &&
      (remoteHash !== baseHash || base.type !== current.type)
    ) {
      conflict('remote-structure');
      continue;
    }
    if (localEdited && nodeKind(current, graph) !== node.kind) {
      conflict('remote-structure');
      continue;
    }
    if (!localEdited && !remoteEdited) continue;
    if (localHash === remoteHash) {
      plan.changes = plan.changes.flatMap((change) =>
        change.key !== id ? [change] : change.relations ? [{ ...change, fields: {} }] : []
      );
      plan.converged.push(id);
      continue;
    }
    if (!remoteEdited) continue;
    if (!localEdited) {
      plan.incoming.push(id);
      continue;
    }
    const localChange = plan.changes.find((change) => change.key === id);
    plan.changes = plan.changes.filter((change) => change.key !== id);
    if (
      !usableVersion(localVersion, localHash, 'cli-save') ||
      !usableVersion(nativeVersion, remoteHash!, 'rem-updated-at') ||
      localVersion.timestamp === nativeVersion.timestamp
    ) {
      conflict('untrusted-edit-order');
      continue;
    }
    const winner = localVersion.timestamp > nativeVersion.timestamp ? 'local' : 'remote';
    plan.resolutions.push({
      id,
      path,
      baseHash,
      local: localVersion,
      remote: nativeVersion,
      policy: 'version-time-lww',
      winner,
    });
    if (winner === 'remote') {
      plan.incoming.push(id);
      if (localChange?.relations) plan.changes.push({ ...localChange, fields: {} });
    } else {
      if (!localChange) throw new Error('Missing local content change for LWW');
      // The entire Rem wins. A base-relative delta could otherwise fabricate a third version.
      const fields: typeof localChange.fields = {};
      if (hash(contentProjection(localRem).text) !== hash(contentProjection(current).text))
        fields.text = node.text;
      if (
        node.kind === 'basic' &&
        hash(contentProjection(localRem).backText) !== hash(contentProjection(current).backText)
      )
        fields.backText = node.backText;
      plan.changes.push({ ...localChange, fields });
    }
  }
  const writesRemote = plan.changes.length > 0 || Boolean(plan.deletion);
  if (writesRemote) plan.conflicts.push(...incomingStructures.values());
  else
    for (const id of incomingStructures.keys()) {
      plan.incoming.push(id);
      for (const childId of remote.get(id)!.children)
        if (!context.native.has(childId)) {
          plan.incoming.push(childId);
          remoteVersions[childId] = remoteVersion(remote.get(childId)!);
        }
    }
  // A read-only incoming plan may observe a dependency's changed child list without
  // importing it. The final operation set decides this; any native write keeps the
  // sealed structure guard. Identity, flags, existence and concurrent-change checks remain.
  for (const id of local.selection?.verificationIds ?? []) {
    const base = context.native.get(id)!,
      current = remote.get(id);
    if (!current) throw new Error(`Missing verification dependency ${id}`);
    if (
      hash([base.parent, base.type]) !== hash([current.parent, current.type]) ||
      (writesRemote && hash(base.children) !== hash(current.children)) ||
      (base.unsupported !== 'unverified-native-flags' &&
        hash(immutableProjection(base)) !== hash(immutableProjection(current)))
    )
      throw new Error(`Verification dependency structure changed: ${id}`);
  }
  for (const [id, rem] of remote) plan.remoteHashes[id] = publicationRevisionHash(rem);
  if (plan.selection)
    plan.selection = {
      ...plan.selection,
      outgoingKeys: plan.changes.map((change) => change.key).sort(),
    };
  plan.resolutions.sort((a, b) => a.id.localeCompare(b.id));
  plan.incoming = [...new Set(plan.incoming)].sort();
  for (const list of [plan.converged, metadataChanged]) list.sort();
  return { plan, metadataChanged, remoteVersions };
}

/** Client-side optimistic readback over the bound content set. SDK setters have no conditional version argument. */
export async function checkPublicRevision(
  backend: WorkspaceBackend,
  expected: Map<string, WorkspaceRem>
): Promise<void> {
  const ids = [...expected.keys()].sort();
  const checked = await mapReads(batches(ids), 4, async (batch) => {
    const snapshots = await backend.readPublic(batch);
    if (
      snapshots.length !== batch.length ||
      new Set(snapshots.map((snapshot) => snapshot.id)).size !== batch.length
    )
      throw new Error('Concurrent remote ID-set change');
    const updated = new Map<string, WorkspaceRem>();
    for (const snapshot of snapshots) {
      const id = snapshot.id;
      if (typeof id !== 'string' || !batch.includes(id))
        throw new Error('Unexpected public revision-check identity');
      const before = expected.get(id)!,
        current = withPublicSnapshot(before, snapshot);
      if (hash(publicRevision(before)) !== hash(publicRevision(current)))
        throw new Error(`Concurrent remote change on ${id}`);
      updated.set(id, current);
    }
    return batch.map((id) => updated.get(id)!);
  });
  for (const rem of checked.flat()) expected.set(rem.id, rem);
}
