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
} from './types.js';

/** Exact-ID public reads are bounded; this does not claim to discover new roots in the KB. */
export async function readRemote(
  context: LocalContext,
  local: WorkspacePlan,
  backend: WorkspaceBackend
): Promise<Map<string, WorkspaceRem>> {
  const result = new Map<string, WorkspaceRem>(),
    ids = [...context.native.keys()].sort();
  for (let start = 0; start < ids.length; start += 50) {
    const batch = ids.slice(start, start + 50);
    const seen = new Set<string>();
    for (const snapshot of await backend.readPublic(batch)) {
      const id = snapshot.id;
      if (typeof id !== 'string' || !batch.includes(id) || seen.has(id))
        throw new Error('Malformed exact public snapshot batch');
      seen.add(id);
      result.set(id, withPublicSnapshot(context.native.get(id)!, snapshot));
    }
  }
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
  for (let start = 0; start < fullIds.length; start += 50) {
    const batch = fullIds.slice(start, start + 50),
      rems = await backend.read(batch);
    if (
      rems.length !== batch.length ||
      new Set(rems.map((rem) => rem.id)).size !== batch.length ||
      rems.some((rem) => !batch.includes(rem.id))
    )
      throw new Error('Incomplete exact native reconciliation read');
    for (const rem of rems) {
      if (hash(publicRevision(rem)) !== hash(publicRevision(result.get(rem.id)!)))
        throw new Error(`Concurrent remote change while reading ${rem.id}`);
      result.set(rem.id, withNativeSnapshot(context.native.get(rem.id)!, rem));
    }
  }
  return result;
}

export function reconcile(
  context: LocalContext,
  local: WorkspacePlan,
  remote: Map<string, WorkspaceRem>
): { plan: SyncPlan; metadataChanged: string[] } {
  const plan: SyncPlan = {
    ...local,
    changes: [...local.changes],
    remoteHashes: {},
    incoming: [],
    converged: [],
    conflicts: [],
  };
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
    if (localHash !== baseHash && nodeKind(current, remote) !== node.kind) {
      conflict('remote-structure');
      continue;
    }
    if (remoteHash === baseHash) continue;
    if (localHash === baseHash) {
      plan.incoming.push(id);
      continue;
    }
    plan.changes = plan.changes.filter((change) => change.key !== id);
    if (localHash === remoteHash) plan.converged.push(id);
    else {
      // No local editor supplies a trustworthy per-Rem edit timestamp. mtime/first observation cannot establish LWW.
      conflict('untrusted-edit-order');
    }
  }
  for (const list of [plan.incoming, plan.converged, metadataChanged]) list.sort();
  return { plan, metadataChanged };
}

/** Client-side optimistic readback over the bound content set. SDK setters have no conditional version argument. */
export async function checkPublicRevision(
  backend: WorkspaceBackend,
  expected: Map<string, WorkspaceRem>
): Promise<void> {
  const ids = [...expected.keys()].sort();
  for (let start = 0; start < ids.length; start += 50) {
    const batch = ids.slice(start, start + 50),
      snapshots = await backend.readPublic(batch);
    if (
      snapshots.length !== batch.length ||
      new Set(snapshots.map((snapshot) => snapshot.id)).size !== batch.length
    )
      throw new Error('Concurrent remote ID-set change');
    for (const snapshot of snapshots) {
      const id = snapshot.id;
      if (typeof id !== 'string' || !batch.includes(id))
        throw new Error('Unexpected public revision-check identity');
      const before = expected.get(id)!,
        current = withPublicSnapshot(before, snapshot);
      if (hash(publicRevision(before)) !== hash(publicRevision(current)))
        throw new Error(`Concurrent remote change on ${id}`);
      expected.set(id, current);
    }
  }
}
