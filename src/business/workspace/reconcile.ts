import type { LocalContext } from './local.js';
import { nodeKind } from './markdown.js';
import {
  contentProjection,
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
} from './types.js';
import { remoteVersion, usableVersion } from './versions.js';
import { mapReads } from './read-pool.js';

function batches(ids: string[]): string[][] {
  return Array.from({ length: Math.ceil(ids.length / 50) }, (_, index) =>
    ids.slice(index * 50, index * 50 + 50)
  );
}

/** Exact-ID public reads are bounded; this does not claim to discover new roots in the KB. */
export async function readRemote(
  context: LocalContext,
  local: WorkspacePlan,
  backend: WorkspaceBackend
): Promise<Map<string, WorkspaceRem>> {
  const result = new Map<string, WorkspaceRem>(),
    ids = [...context.native.keys()].sort();
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
  for (const [id, before] of context.native) {
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
  const remoteVersions: Record<string, ContentVersion> = {};
  const nodes = new Map(
    [...context.parsed].flatMap(([path, doc]) =>
      doc.nodes
        .filter((node) => node.kind !== 'mount')
        .map((node) => [node.key, { path, node }] as const)
    )
  );
  const metadataChanged: string[] = [];
  for (const [id, base] of context.native) {
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
    // Structural moves/additions/removals are visible conflicts, never a silent subset refresh or delete.
    if (
      hash([base.parent, base.children, base.type]) !==
        hash([current.parent, current.children, current.type]) ||
      (base.document !== null && base.document !== current.document) ||
      (base.folder !== null && base.folder !== current.folder)
    ) {
      conflict('remote-structure');
      continue;
    }
    if (
      local.deletion?.ids.includes(id) &&
      (remoteHash !== baseHash || base.type !== current.type)
    ) {
      conflict('remote-structure');
      continue;
    }
    if (localEdited && nodeKind(current, remote) !== node.kind) {
      conflict('remote-structure');
      continue;
    }
    if (!localEdited && !remoteEdited) continue;
    if (localHash === remoteHash) {
      plan.changes = plan.changes.filter((change) => change.key !== id);
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
    if (winner === 'remote') plan.incoming.push(id);
    else {
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
  plan.resolutions.sort((a, b) => a.id.localeCompare(b.id));
  for (const list of [plan.incoming, plan.converged, metadataChanged]) list.sort();
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
