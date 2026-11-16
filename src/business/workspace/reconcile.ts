import type { LocalContext } from './local.js';
import { nodeKind } from './markdown.js';
import {
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
} from './types.js';
import { mapReads } from './read-pool.js';
import { verificationClosure } from './selection.js';
import { nativeTagToken, tagSet } from './tags.js';
import { contentChildren, contentTags, partitionRemote } from './feedback-partition.js';
import { deletionPath } from './deletion.js';

function batches(ids: string[]): string[][] {
  return Array.from({ length: Math.ceil(ids.length / 50) }, (_, index) =>
    ids.slice(index * 50, index * 50 + 50)
  );
}

/** Exact-ID public reads are bounded; this does not claim to discover new roots in the KB. */
export async function readRemote(
  context: LocalContext,
  local: WorkspacePlan,
  backend: WorkspaceBackend,
  powerupCodes?: Record<string, string[]>,
  created: Map<string, WorkspaceRem> = new Map()
): Promise<Map<string, WorkspaceRem>> {
  const result = new Map(created),
    ids = local.selection
      ? [...local.selection.reconcileIds, ...local.selection.verificationIds].sort()
      : [...context.native.keys()].sort();
  const publicReads = await mapReads(batches(ids), 4, async (batch) => {
    const seen = new Map<string, WorkspaceRem>();
    for (const { snapshot, tags, powerupPresence } of await backend.readProbe(batch, {
      powerupCodes,
    })) {
      const id = snapshot.id;
      if (typeof id !== 'string' || !batch.includes(id) || seen.has(id))
        throw new Error('Malformed exact public snapshot batch');
      const before = context.native.get(id)!,
        current = {
          ...withPublicSnapshot(before, snapshot),
          tags,
          ...(powerupPresence ? { powerupPresence } : {}),
        };
      for (const code of powerupCodes?.[id] ?? []) {
        const expected =
          before.powerupPresence?.[code] ??
          before.powerups?.some((powerup) => powerup.code === code);
        if (typeof powerupPresence?.[code] !== 'boolean' || powerupPresence[code] !== expected)
          throw new Error(`Native Powerup changed or was not verified: ${id}/${code}`);
      }
      seen.set(
        id,
        hash(publicRevision(before)) === hash(publicRevision(current)) &&
          hash(before.tags) === hash(tags)
          ? before
          : current
      );
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
      (local.selection?.scope === 'all' ||
        hash(publicRevision(before)) !== hash(publicRevision(current)) ||
        hash(before.tags) !== hash(current.tags))
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
  const dependencies = verificationClosure(context, local, [...full]);
  const missingProbes = dependencies.filter((id) => !ids.includes(id));
  for (const batch of batches(missingProbes)) {
    const probes = await backend.readProbe(batch, { powerupCodes });
    if (
      probes.length !== batch.length ||
      new Set(probes.map(({ snapshot }) => snapshot.id)).size !== batch.length
    )
      throw new Error('Missing dynamically discovered verification dependency');
    for (const { snapshot, tags } of probes) {
      const id = snapshot.id;
      if (typeof id !== 'string' || !batch.includes(id))
        throw new Error('Malformed verification dependency probe');
      result.set(id, { ...withPublicSnapshot(context.native.get(id)!, snapshot), tags });
    }
  }
  if (local.selection)
    local.selection.verificationIds = tagSet([
      ...local.selection.verificationIds,
      ...dependencies.filter((id) => !local.selection!.reconcileIds.includes(id)),
    ]);
  for (const id of dependencies) if (result.has(id)) full.add(id);
  for (const id of local.selection?.verificationIds ?? [])
    if (result.has(id) && context.native.get(id)!.unsupported !== 'unverified-native-flags')
      full.add(id);
  const fullIds = [...full].sort();
  // Two batches x four Rems x four atomic reads = the 32-outstanding transport budget.
  const nativeReads = await mapReads(batches(fullIds), 2, async (batch) => {
    const rems = await backend.read(batch, {
      tags: true,
      ...(powerupCodes ? { powerupCodes } : {}),
    });
    if (
      rems.length !== batch.length ||
      new Set(rems.map((rem) => rem.id)).size !== batch.length ||
      rems.some((rem) => !batch.includes(rem.id))
    )
      throw new Error('Incomplete exact native reconciliation read');
    for (const rem of rems) {
      if (powerupCodes?.[rem.id]?.length) {
        const baseline = context.native.get(rem.id)!;
        for (const code of powerupCodes[rem.id]) {
          const before =
            baseline.powerupPresence?.[code] ??
            baseline.powerups?.some((powerup) => powerup.code === code);
          if (
            typeof rem.powerupPresence?.[code] !== 'boolean' ||
            rem.powerupPresence[code] !== before
          )
            throw new Error(`Native Powerup changed or was not verified: ${rem.id}/${code}`);
        }
      }
      if (
        hash(publicRevision(rem)) !== hash(publicRevision(result.get(rem.id)!)) ||
        hash(rem.tags) !== hash(result.get(rem.id)!.tags)
      )
        throw new Error(`Concurrent remote change while reading ${rem.id}`);
    }
    const byId = new Map(rems.map((rem) => [rem.id, rem]));
    return batch.map((id) =>
      context.native.get(id)!.unsupported === 'unverified-native-flags'
        ? result.get(id)!
        : withNativeSnapshot(context.native.get(id)!, byId.get(id)!)
    );
  });
  for (const rem of nativeReads.flat()) result.set(rem.id, rem);
  await partitionRemote(
    result,
    new Set(context.native.keys()),
    context.state.feedbackRoles,
    backend
  );
  return result;
}

/** Local source is desired content; native content drift is never an incoming edit. */
export function reconcile(
  context: LocalContext,
  local: WorkspacePlan,
  remote: Map<string, WorkspaceRem>
): { plan: SyncPlan; metadataChanged: string[] } {
  const plan: SyncPlan = {
    ...local,
    changes: [...local.changes],
    remoteHashes: {},
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
  for (const [token, id] of Object.entries(local.tagIds ?? {})) {
    if (nativeTagToken(remote, id) !== token)
      throw new Error(`New tag binding changed remotely: ${token}/${id}`);
  }
  // Verification dependencies never become source candidates or advance their baseline.
  for (const id of local.selection?.verificationIds ?? []) {
    const base = context.native.get(id)!,
      current = remote.get(id);
    if (!current) throw new Error(`Missing verification dependency ${id}`);
    if (
      hash([base.parent, contentChildren(base), base.type]) !==
        hash([current.parent, contentChildren(current), current.type]) ||
      (base.unsupported !== 'unverified-native-flags' &&
        hash(immutableProjection(base)) !== hash(immutableProjection(current)))
    )
      throw new Error(`Verification dependency structure changed: ${id}`);
  }
  const graph = new Map([...context.native, ...remote]);
  for (const id of local.selection?.reconcileIds ?? context.native.keys()) {
    const base = context.native.get(id)!,
      located = nodes.get(id),
      deleting = local.deletion?.ids.includes(id) === true,
      path = located?.path ?? deletionPath(context, id),
      node = located?.node,
      current = remote.get(id);
    if (!deleting && !node) throw new Error(`Missing selected local node: ${id}`);
    const desired =
      deleting || node!.kind === 'opaque'
        ? base
        : {
            ...base,
            text: node!.text,
            ...(node!.kind === 'basic' ? { backText: node!.backText } : {}),
            ...(node!.tags === undefined ? {} : { tags: node!.tags }),
          };
    const content = (rem: WorkspaceRem) => ({
      ...contentProjection(rem),
      tags: Array.isArray(rem.tags) ? tagSet(contentTags(rem, context.state.feedbackRoles)!) : null,
    });
    const baseHash = hash(content(base)),
      localHash = hash(content(desired)),
      remoteHash = current ? hash(content(current)) : null;
    const conflict = (reason: SyncPlan['conflicts'][number]['reason']) =>
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
    if (
      hash([base.parent, contentChildren(base), base.type]) !==
        hash([current.parent, contentChildren(current), current.type]) ||
      (base.document !== null && base.document !== current.document) ||
      (base.folder !== null && base.folder !== current.folder) ||
      (!deleting && nodeKind(current, graph) !== node!.kind) ||
      hash(sourceStructure(base)) !== hash(sourceStructure(current))
    ) {
      conflict('remote-structure');
      continue;
    }
    // Unknown direct-tag evidence is not an empty set and cannot authorize an overwrite.
    if (remoteHash !== baseHash && localHash !== remoteHash) {
      conflict('remote-content-drift');
      continue;
    }
    if (deleting) continue;
    if (hash(base) !== hash(current)) metadataChanged.push(id);
    if (localHash === remoteHash && localHash !== baseHash) {
      plan.changes = plan.changes.filter((change) => change.key !== id);
      plan.converged.push(id);
    }
  }
  for (const [id, rem] of remote) plan.remoteHashes[id] = publicationRevisionHash(rem);
  if (context.state.feedbackRoles) {
    plan.physicalBaseline = Object.fromEntries(
      [...remote].map(([id, rem]) => [
        id,
        { children: rem.children, tags: rem.tags, feedback: rem.feedback },
      ])
    );
    const physical = new Map([...remote].map(([id, rem]) => [id, [...rem.children]]));
    for (const change of plan.changes) {
      if (!change.key.startsWith('new:') || !change.parent) continue;
      const children = physical.get(change.parent) ?? [];
      const parent =
        nodes.get(change.parent)?.node ??
        context.parsed.get(change.path)?.nodes.find((node) => node.key === change.parent);
      if (!parent) throw new Error('Missing canonical insertion parent');
      const successor = parent.children
        .slice(change.position + 1)
        .find((id) => children.includes(id));
      change.physicalPosition = successor ? children.indexOf(successor) : children.length;
      children.splice(change.physicalPosition, 0, change.key);
      physical.set(change.parent, children);
      physical.set(change.key, []);
    }
  }
  if (plan.selection)
    plan.selection = {
      ...plan.selection,
      outgoingKeys: plan.changes.map((change) => change.key).sort(),
    };
  plan.converged.sort();
  metadataChanged.sort();
  return { plan, metadataChanged };
}

/** Native review/TODO facts and card runtime stay in sidecars, not authored content.
 * Portal targets, Powerups and property layout can change visible readonly projection. */
function sourceStructure(rem: WorkspaceRem): unknown {
  const { facts: _facts, cards: _cards, ...structure } = immutableProjection(rem);
  return { ...structure, references: rem.references ?? null };
}

/** Client-side optimistic readback over the bound content set. SDK setters have no conditional version argument. */
export async function checkPublicRevision(
  backend: WorkspaceBackend,
  expected: Map<string, WorkspaceRem>,
  powerupCodes?: Record<string, string[]>
): Promise<void> {
  const ids = [...expected.keys()].sort();
  const checked = await mapReads(batches(ids), 4, async (batch) => {
    const probes = await backend.readProbe(batch, powerupCodes ? { powerupCodes } : undefined),
      snapshots = probes.map((probe) => probe.snapshot);
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
        current = {
          ...withPublicSnapshot(before, snapshot),
          tags: probes.find((probe) => probe.snapshot.id === id)!.tags,
        };
      for (const code of powerupCodes?.[id] ?? []) {
        const presence = probes.find((probe) => probe.snapshot.id === id)!.powerupPresence?.[code];
        if (
          typeof presence !== 'boolean' ||
          presence !==
            (before.powerupPresence?.[code] ??
              before.powerups?.some((powerup) => powerup.code === code))
        )
          throw new Error(`Concurrent native Powerup change on ${id}/${code}`);
      }
      if (
        hash(publicRevision(before)) !== hash(publicRevision(current)) ||
        (Array.isArray(before.tags) && hash(before.tags) !== hash(current.tags))
      )
        throw new Error(`Concurrent remote change on ${id}`);
      updated.set(id, current);
    }
    return batch.map((id) => updated.get(id)!);
  });
  for (const rem of checked.flat()) expected.set(rem.id, rem);
}
