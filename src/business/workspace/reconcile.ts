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
  type ContentVersion,
} from './types.js';
import { remoteVersion, usableVersion } from './versions.js';
import { mapReads } from './read-pool.js';
import { verificationClosure } from './selection.js';
import { mergeTags, nativeTagToken, registerTagIds, registerTags, tagSet } from './tags.js';
import { readIncoming } from './incoming.js';

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
          hash(before.tags) === hash(tags) &&
          (!context.state.remoteVersions?.[id] ||
            context.state.remoteVersions[id]!.contentHash === hash(contentProjection(before)))
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
  const knownTagIds = new Set(Object.values(context.state.tagIds ?? {}));
  const newRemoteTags = [...result.values()].flatMap((rem) =>
    (rem.tags ?? []).filter((id) => !knownTagIds.has(id))
  );
  const dependencyPlan = {
    ...local,
    changes: [
      ...local.changes,
      ...newRemoteTags.map((id) => ({
        key: id,
        path: '',
        parent: null,
        position: 0,
        kind: 'text' as const,
        cardItem: false,
        fields: {},
        tags: { before: [], after: [id] },
      })),
    ],
  };
  const dependencies = verificationClosure(context, dependencyPlan, [...full]);
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
  const addedIds = await readIncoming(context, local, result, backend, new Set(created.keys()));
  if (addedIds.length) {
    if (local.selection) local.selection.addedIds = addedIds;
    const graph = new Map([...context.native, ...result]);
    const additions = addedIds.map((id) => {
      const rem = result.get(id)!;
      for (const tag of rem.tags ?? [])
        if (!context.native.has(tag))
          throw new Error(`Incoming tag requires an existing sealed native ancestor path: ${tag}`);
      return {
        key: id,
        path: '',
        parent: rem.parent,
        position: 0,
        kind: 'text' as const,
        cardItem: false,
        fields: {},
        tags: { before: [], after: rem.tags ?? [] },
      };
    });
    const closure = verificationClosure(
      { ...context, native: graph },
      { ...local, changes: [...local.changes, ...additions] },
      addedIds
    );
    const extra = closure.filter(
      (id) => !full.has(id) && !addedIds.includes(id) && !created.has(id)
    );
    for (const batch of batches(extra)) {
      const probes = await backend.readProbe(batch, { powerupCodes });
      const rems = await backend.read(batch, { tags: true, powerupCodes });
      if (
        probes.length !== batch.length ||
        rems.length !== batch.length ||
        new Set(probes.map((probe) => probe.snapshot.id)).size !== batch.length ||
        new Set(rems.map((rem) => rem.id)).size !== batch.length
      )
        throw new Error('Incomplete incoming verification dependency read');
      for (const rem of rems) {
        if (!batch.includes(rem.id)) throw new Error('Unexpected incoming verification identity');
        const probe = probes.find((item) => item.snapshot.id === rem.id);
        if (
          !probe ||
          hash(publicRevision(rem)) !==
            hash(publicRevision(withPublicSnapshot(rem, probe.snapshot))) ||
          hash(rem.tags) !== hash(probe.tags)
        )
          throw new Error(`Concurrent incoming verification dependency change: ${rem.id}`);
        result.set(rem.id, withNativeSnapshot(context.native.get(rem.id)!, rem));
      }
    }
    if (local.selection)
      local.selection.verificationIds = tagSet([
        ...local.selection.verificationIds,
        ...closure.filter((id) => !local.selection!.reconcileIds.includes(id) && !created.has(id)),
      ]);
    // Child discovery is not an atomic SDK snapshot. Seal the complete observed frontier again.
    await checkPublicRevision(
      backend,
      new Map([...addedIds, ...closure].map((id) => [id, result.get(id)!]))
    );
  }
  // Reject unprojectable incoming tag IDs before a mixed batch can perform any writes.
  registerTags(new Map([...context.native, ...result]), context.state.tagIds);
  // New names are bound to already sealed native paths, never to an unselected remote rename.
  const registered = registerTagIds(
    context.native,
    tagSet([...result.values()].flatMap((rem) => rem.tags ?? [])),
    { ...context.state.tagIds, ...local.tagIds }
  );
  const tagIds = Object.fromEntries(
    Object.entries(registered).filter(
      ([token]) => !Object.hasOwn(context.state.tagIds ?? {}, token)
    )
  );
  if (Object.keys(tagIds).length) local.tagIds = tagIds;
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
    incoming: [...(local.selection?.addedIds ?? [])],
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
  const addedIds = new Set(local.selection?.addedIds ?? []);
  for (const [token, id] of Object.entries(local.tagIds ?? {})) {
    if (nativeTagToken(remote, id) !== token)
      throw new Error(`New tag binding changed remotely: ${token}/${id}`);
  }
  // Dependency reads are validation only: they do not become incoming changes or advance clocks.
  for (const id of local.selection?.verificationIds ?? []) {
    const base = context.native.get(id)!,
      current = remote.get(id);
    if (!current) throw new Error(`Missing verification dependency ${id}`);
    if (
      hash([base.parent, base.children, base.type]) !==
        hash([current.parent, current.children, current.type]) ||
      (base.unsupported !== 'unverified-native-flags' &&
        hash(immutableProjection(base)) !== hash(immutableProjection(current)))
    )
      throw new Error(`Verification dependency structure changed: ${id}`);
  }
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
    // Only fully observed additions extend children; existing structure and relative order stay fixed.
    if (
      hash([base.parent, base.children, base.type]) !==
        hash([
          current.parent,
          current.children.filter((child) => !addedIds.has(child)),
          current.type,
        ]) ||
      (base.document !== null && base.document !== current.document) ||
      (base.folder !== null && base.folder !== current.folder) ||
      (hash(base.children) !== hash(current.children) &&
        local.changes.some((change) => change.key.startsWith('new:') && change.parent === id))
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
    if (localEdited && nodeKind(current, graph) !== node.kind) {
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
  // Tags are a set of independent native relationships, not part of the body's LWW clock.
  for (const id of local.selection?.reconcileIds ?? context.native.keys()) {
    const base = context.native.get(id)!,
      current = remote.get(id),
      target = nodes.get(id);
    if (!current || !target || !Array.isArray(current.tags)) continue;
    const { node, path } = target;
    if (node.kind === 'mount') continue;
    const desired = node.tags === undefined ? current.tags : node.tags;
    const merged = Array.isArray(base.tags)
      ? mergeTags(base.tags, desired, current.tags)
      : current.tags;
    let change = plan.changes.find((item) => item.key === id);
    if (change) delete change.tags;
    if (hash(tagSet(merged)) !== hash(tagSet(current.tags))) {
      if (node.kind === 'opaque')
        throw new Error(`Tags on opaque native Rem ${id} remain read only`);
      if (!change) {
        change = {
          key: id,
          path,
          parent: base.parent,
          position: 0,
          kind: node.kind,
          cardItem: base.cardItem === true,
          beforeHash: hash(base),
          fields: {},
        };
        plan.changes.push(change);
      }
      change.tags = { before: tagSet(current.tags), after: tagSet(merged) };
    }
    if (hash(tagSet(merged)) !== hash(tagSet(node.tags ?? []))) plan.incoming.push(id);
    if (change && !Object.keys(change.fields).length && !change.tags)
      plan.changes = plan.changes.filter((item) => item !== change);
  }
  for (const [id, rem] of remote) plan.remoteHashes[id] = publicationRevisionHash(rem);
  if (plan.selection)
    plan.selection = {
      ...plan.selection,
      outgoingKeys: plan.changes.map((change) => change.key).sort(),
    };
  plan.resolutions.sort((a, b) => a.id.localeCompare(b.id));
  plan.incoming = tagSet(plan.incoming);
  for (const list of [plan.incoming, plan.converged, metadataChanged]) list.sort();
  return { plan, metadataChanged, remoteVersions };
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
