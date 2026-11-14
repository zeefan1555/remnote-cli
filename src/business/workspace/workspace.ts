import {
  allFiles,
  readPrivate,
  withWorkspaceLock,
  workspaceDirectory,
  writePrivate,
} from './files.js';
import {
  inspectLocal,
  authoritativeState,
  loadState,
  localStore,
  saveState,
  STATE,
  validateGraph,
  writeSnapshot,
  type LocalContext,
} from './local.js';
import {
  hash,
  type WorkspaceBackend,
  type WorkspaceChange,
  type WorkspacePlan,
  type WorkspaceRem,
  type WorkspaceState,
  type SyncPlan,
} from './types.js';
import { readRemote, reconcile, checkPublicRevision } from './reconcile.js';
import { publicationRevisionHash, revisionHash, withNativeSnapshot } from './snapshots.js';
import { planDeletion, type DeleteOptions } from './deletion.js';
import { FrozenFiles } from './frozen-files.js';
import { readOfficialExport, type OfficialBootstrap } from './official-export.js';
import {
  readPublication,
  requireNoPublication,
  recoverWorkspace as recoverPublication,
} from './publication.js';

interface Journal {
  version: 1;
  planHash: string;
  guardHash: string;
  state: 'preview' | 'applying' | 'verified' | 'unknown' | 'conflict';
  steps: Record<string, 'started' | 'verified' | 'unknown'>;
  ids: Record<string, string>;
  final?: { hashes: Record<string, string>; files: Record<string, string>; deleted: string[] };
}

export async function importWorkspace(
  directory: string,
  kbId: string,
  backendFactory: () => Promise<WorkspaceBackend>,
  options: { rootId?: string; export?: string; snapshot?: string; editableRootId?: string } = {}
): Promise<unknown> {
  if (!kbId.trim()) throw new Error('Import requires explicit --kb-id');
  if (
    (options.snapshot && !options.export) ||
    (options.rootId && (options.export || options.editableRootId))
  )
    throw new Error(
      '--snapshot requires --export; --root-id is an independent scope, not an editable-root modifier'
    );
  const root = await workspaceDirectory(directory, true);
  return withWorkspaceLock(root, async () => {
    await requireNoPublication(root);
    let previous: WorkspaceState | undefined;
    try {
      previous = await authoritativeState(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (previous) {
      if (previous.kbId !== kbId) throw new Error('Workspace is bound to another KB');
      throw new Error(
        'Import refuses an initialized workspace; use sync to reconcile the existing baseline'
      );
    }
    if ((await allFiles(root)).some((file) => file !== '.gitignore'))
      throw new Error(
        'Initial import requires an empty dedicated directory (an independent .git is allowed)'
      );
    if (options.editableRootId && !options.export)
      throw new Error('--editable-root-id requires an official export');
    const files = await allFiles(root);
    if (!files.includes('.gitignore'))
      await writePrivate(root, '.gitignore', '/.sync/\n/.obsidian/\n/.trash/\n.DS_Store\n');
    else {
      const ignored = new Set(
        (await readPrivate(root, '.gitignore')).split('\n').map((line) => line.trim())
      );
      if (
        ['.sync', '.obsidian', '.trash'].some(
          (name) => !ignored.has(`/${name}/`) && !ignored.has(`${name}/`)
        ) ||
        !ignored.has('.DS_Store')
      )
        throw new Error(
          'Local Git must ignore /.sync/, /.obsidian/, /.trash/ and .DS_Store before content is downloaded'
        );
    }
    const frozen = await FrozenFiles.capture(root);
    let rems: WorkspaceRem[];
    let official: OfficialBootstrap | undefined;
    const coverage: Pick<WorkspaceState, 'scope' | 'rootIds' | 'globalDiscoveryComplete'> =
      options.rootId
        ? { scope: 'subtree', rootIds: [options.rootId], globalDiscoveryComplete: false }
        : { scope: 'library', rootIds: [], globalDiscoveryComplete: true };
    try {
      if (options.export) {
        official = await readOfficialExport(
          options.export,
          options.snapshot,
          kbId,
          backendFactory,
          options.editableRootId
        );
        rems = official.rems;
      } else {
        const backend = await backendFactory(),
          identity = await backend.identity();
        if (identity.kbId !== kbId) throw new Error('Connected KB differs from explicit --kb-id');
        rems =
          coverage.scope === 'library'
            ? await backend.enumerate()
            : await backend.subtree(coverage.rootIds);
      }
      const errors = validateGraph(rems, coverage.rootIds);
      if (errors.length)
        throw new Error(`Incomplete native graph: ${errors.slice(0, 10).join('; ')}`);
    } catch (error) {
      await saveState(root, {
        version: 1,
        directory: root,
        kbId,
        snapshotAt: new Date().toISOString(),
        complete: false,
        ...coverage,
        errors: ['Requested discovery failed; no implicit search or scope fallback was used'],
        entries: {},
        documents: {},
      });
      return {
        status: 'incomplete',
        complete: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (coverage.scope === 'library')
      coverage.rootIds = rems.filter((rem) => rem.parent === null).map((rem) => rem.id);
    await frozen.check();
    const state = await writeSnapshot(
      root,
      kbId,
      rems,
      undefined,
      coverage,
      frozen,
      official?.originals,
      official?.source
    );
    return {
      status: 'imported',
      complete: true,
      scope: state.scope,
      rootIds: state.rootIds,
      globalDiscoveryComplete: state.globalDiscoveryComplete,
      kbId,
      rems: rems.length,
      documents: Object.keys(state.documents).length,
      opaque: Object.values(state.entries).filter((entry) => !entry.editable).length,
      git: 'unchanged',
    };
  });
}

export async function lintWorkspace(directory: string): Promise<unknown> {
  const root = await workspaceDirectory(directory),
    context = await inspectLocal(root);
  return {
    ok: context.diagnostics.length === 0,
    complete: context.state.complete,
    diagnostics: context.diagnostics,
  };
}

export async function statusWorkspace(directory: string): Promise<unknown> {
  const root = await workspaceDirectory(directory),
    publication = await readPublication(root);
  if (publication)
    return {
      status: 'publication-incomplete',
      complete: false,
      kbId: publication.next.kbId,
      pending: publication.next.pending ?? null,
      recovery: 'sync recover',
      remoteReplay: false,
    };
  const local = await inspectLocal(root);
  return {
    kbId: local.state.kbId,
    complete: local.state.complete,
    scope: local.state.scope,
    rootIds: local.state.rootIds,
    globalDiscoveryComplete: local.state.globalDiscoveryComplete,
    rems: Object.keys(local.state.entries).length,
    documents: Object.keys(local.state.documents).length,
    opaque: Object.values(local.state.entries).filter((entry) => !entry.editable).length,
    dirty: local.dirty,
    missing: local.missing,
    pending: local.state.pending ?? null,
    diagnostics: local.diagnostics,
    errors: local.state.errors,
  };
}

export function planLocal(context: LocalContext, options: DeleteOptions = {}): WorkspacePlan {
  if (!context.state.complete)
    throw new Error('Workspace is incomplete; its declared scope must be reconciled before sync');
  if (context.diagnostics.length)
    throw new Error(
      context.diagnostics.map((d) => `${d.path}:${d.line} / ${d.code} / ${d.message}`).join('\n')
    );
  const plan: WorkspacePlan = {
    version: 1,
    directory: context.state.directory,
    kbId: context.state.kbId,
    baseHash: hash({ entries: context.state.entries, documents: context.state.documents }),
    files: {},
    changes: [],
  };
  for (const [path, doc] of context.parsed) {
    plan.files[path] = doc.fileHash;
    const baseline = new Map(context.baseline.get(path)!.nodes.map((node) => [node.key, node]));
    const nodes = new Map(doc.nodes.map((node) => [node.key, node]));
    for (const node of doc.nodes) {
      if (node.kind === 'opaque' || node.kind === 'mount') continue;
      const before = baseline.get(node.key),
        native = context.native.get(node.key),
        parent = node.parent ? nodes.get(node.parent) : undefined;
      const fields: WorkspaceChange['fields'] = {};
      if (!before || hash(before.text) !== hash(node.text)) fields.text = node.text;
      if (node.kind === 'basic' && (!before || hash(before.backText) !== hash(node.backText)))
        fields.backText = node.backText;
      if (!Object.keys(fields).length) continue;
      plan.changes.push({
        key: node.key,
        path,
        parent: node.parent ?? native?.parent ?? null,
        position: parent ? parent.children.indexOf(node.key) : 0,
        kind: node.kind,
        cardItem: before ? native!.cardItem === true : parent?.kind === 'multiline',
        ...(native ? { beforeHash: hash(native) } : {}),
        fields,
      });
    }
  }
  if (plan.changes.length > 100)
    throw new Error(
      'One sync is limited to 100 changed/new nodes; split edits into reviewed batches'
    );
  const deletion = planDeletion(context, options);
  if (deletion) {
    if (plan.changes.length)
      throw new Error('Keep an explicit deletion separate from content edits and creates');
    plan.deletion = deletion;
  }
  return plan;
}

export async function diffWorkspace(
  directory: string,
  options: DeleteOptions = {}
): Promise<unknown> {
  const root = await workspaceDirectory(directory),
    plan = planLocal(await inspectLocal(root), options);
  return {
    kbId: plan.kbId,
    remoteChecked: false,
    planHash: hash(plan),
    changes: plan.changes.map((change) => ({
      id: change.key,
      path: change.path,
      operation: change.key.startsWith('new:') ? 'create' : 'update',
      fields: Object.keys(change.fields),
      kind: change.kind,
    })),
    deletes: plan.deletion?.ids.length ?? 0,
    deletion: plan.deletion,
    moves: 0,
  };
}

async function readExact(
  backend: WorkspaceBackend,
  ids: string[]
): Promise<Map<string, WorkspaceRem>> {
  const result = new Map<string, WorkspaceRem>();
  for (let start = 0; start < ids.length; start += 50) {
    const batch = ids.slice(start, start + 50),
      rems = await backend.read(batch);
    if (rems.length !== batch.length) throw new Error('Incomplete exact-ID native read');
    for (const rem of rems) {
      if (!batch.includes(rem.id) || result.has(rem.id))
        throw new Error('Malformed exact-ID native read');
      result.set(rem.id, rem);
    }
  }
  if (ids.some((id) => !result.has(id))) throw new Error('Missing native Rem');
  return result;
}

function affectedIds(plan: SyncPlan, native: Map<string, WorkspaceRem>): string[] {
  const ids = new Set<string>();
  if (plan.deletion) {
    for (const id of plan.deletion.ids) ids.add(id);
    let ancestor = native.get(plan.deletion.rootId)?.parent;
    while (
      ancestor &&
      native.has(ancestor) &&
      native.get(ancestor)!.unsupported !== 'unverified-native-flags'
    ) {
      ids.add(ancestor);
      ancestor = native.get(ancestor)?.parent;
    }
  }
  for (const id of [...plan.incoming, ...plan.converged]) {
    ids.add(id);
    let ancestor = native.get(id)?.parent;
    while (
      ancestor &&
      native.has(ancestor) &&
      native.get(ancestor)!.unsupported !== 'unverified-native-flags'
    ) {
      ids.add(ancestor);
      ancestor = native.get(ancestor)?.parent;
    }
  }
  for (const change of plan.changes)
    for (const start of [change.key, change.parent]) {
      let current = start ? native.get(start) : undefined;
      while (current && !ids.has(current.id) && current.unsupported !== 'unverified-native-flags') {
        ids.add(current.id);
        current = current.parent ? native.get(current.parent) : undefined;
      }
    }
  return [...ids].sort();
}

async function checkFiles(root: string, plan: WorkspacePlan): Promise<void> {
  for (const [path, digest] of Object.entries(plan.files))
    if (hash(await readPrivate(root, path)) !== digest)
      throw new Error('Local Markdown changed after plan was frozen');
}

/** Offline lint completes before backendFactory, so lint failures cause zero remote calls. */
export async function pushWorkspace(
  directory: string,
  backendFactory: () => Promise<WorkspaceBackend>,
  options: DeleteOptions & { apply?: boolean; planHash?: string } = {}
): Promise<unknown> {
  const root = await workspaceDirectory(directory);
  return withWorkspaceLock(root, async () => {
    await requireNoPublication(root);
    const context = await inspectLocal(root),
      state = context.state,
      localPlan = planLocal(context, options);
    const frozen = await FrozenFiles.capture(root);
    const store = localStore(state.kbId);
    if (state.pending) {
      const old = await store.getLocal<Journal>(state.pending.journalKey);
      if (
        !old ||
        old.version !== 1 ||
        old.planHash !== state.pending.planHash ||
        old.state !== 'preview' ||
        Object.keys(old.steps).length
      )
        throw new Error(
          'Prior write outcome requires exact-ID reconciliation; never change its key or auto-replay it'
        );
    }
    if (options.apply && (!state.pending || options.planHash !== state.pending.planHash))
      throw new Error(
        'Apply requires the exact frozen --plan-hash; files and remote content must match preview'
      );
    const backend = await backendFactory(),
      identity = await backend.identity();
    if (identity.kbId !== state.kbId)
      throw new Error('Connected KB does not match workspace binding');
    const remote = await readRemote(context, localPlan, backend),
      { plan, metadataChanged } = reconcile(context, localPlan, remote),
      planHash = hash(plan);
    const coverage = {
      discoveryScope: 'bound-ids',
      globalDiscoveryComplete: false,
      remoteChecked: true,
    };
    if (options.apply && (state.pending!.planHash !== planHash || options.planHash !== planHash))
      throw new Error(
        'Apply requires the exact frozen --plan-hash; files and remote content must match preview'
      );
    await frozen.check();
    if (state.pending && state.pending.planHash !== planHash) {
      delete state.pending;
      await saveState(root, state);
    }
    if (plan.conflicts.length) {
      const conflicts = [];
      for (const conflict of plan.conflicts) {
        const rem = remote.get(conflict.id);
        const remoteSnapshot = rem
          ? `.sync/conflicts/${planHash}/${conflict.id}-${hash(rem)}.json`
          : null;
        if (remoteSnapshot)
          await writePrivate(root, remoteSnapshot, JSON.stringify(rem, null, 2) + '\n');
        conflicts.push({ ...conflict, remoteSnapshot });
      }
      return {
        status: 'conflict',
        complete: false,
        planHash,
        conflicts,
        remoteWrites: 0,
        ...coverage,
      };
    }
    if (
      !plan.changes.length &&
      !plan.deletion &&
      !plan.incoming.length &&
      !plan.converged.length &&
      !metadataChanged.length &&
      !context.dirty.length
    )
      return { status: 'unchanged', complete: true, changes: 0, remoteWrites: 0, ...coverage };
    const key = `workspace-v1:${state.kbId}:${hash(root)}:${planHash}`;
    let journal = await store.getLocal<Journal>(key);
    if (
      journal &&
      (journal.version !== 1 ||
        journal.planHash !== planHash ||
        journal.state !== 'preview' ||
        Object.keys(journal.steps).length)
    )
      throw new Error(
        'Prior write outcome requires exact-ID reconciliation; automatic replay is forbidden'
      );
    const existingIds = affectedIds(plan, remote),
      expected = new Map(existingIds.map((id) => [id, remote.get(id)!]));
    const protectedIds = existingIds.filter((id) => !plan.deletion?.ids.includes(id));
    const guardHash = await backend.guard(protectedIds);
    if (journal && journal.guardHash !== guardHash)
      throw new Error('Native card identity or immutable flags changed since preview');
    journal ??= { version: 1, planHash, guardHash, state: 'preview', steps: {}, ids: {} };
    await store.setLocal(key, journal);
    state.pending = { planHash, journalKey: key };
    await saveState(root, state);
    if (!options.apply)
      return {
        status: 'preview',
        complete: true,
        planHash,
        creates: plan.changes.filter((change) => change.key.startsWith('new:')).length,
        updates: plan.changes.filter((change) => !change.key.startsWith('new:')).length,
        incoming: plan.incoming,
        converged: plan.converged,
        outgoing: plan.changes.map((change) => change.key),
        metadataRefresh: metadataChanged,
        deletion: plan.deletion,
        atomic: false,
        remoteWrites: 0,
        ...coverage,
      };
    const writesRemote = plan.changes.length > 0 || Boolean(plan.deletion);
    if (writesRemote && !identity.writable) throw new Error('Live write gate is disabled');
    if (plan.deletion && !identity.destructive)
      throw new Error(
        'Explicit deletion requires --allow-destructive and both live plugin write gates'
      );
    journal.state = 'applying';
    await store.setLocal(key, journal);
    let active: string | undefined;
    async function preflight(): Promise<void> {
      await checkFiles(root, plan);
      const fresh = await readExact(backend, [...expected.keys()]);
      for (const [id, rem] of expected) {
        const current = withNativeSnapshot(rem, fresh.get(id)!);
        if (revisionHash(current) !== revisionHash(rem))
          throw new Error(`Concurrent remote change on ${id}`);
        fresh.set(id, current);
      }
      if ((await backend.guard(protectedIds)) !== guardHash)
        throw new Error('Existing card identity or immutable flags changed');
      const identity = await backend.identity();
      if (
        identity.kbId !== state.kbId ||
        (writesRemote && !identity.writable) ||
        (plan.deletion && !identity.destructive)
      )
        throw new Error('Live KB/write permission changed');
      // Refresh remote-owned review metadata only after the semantic revision and identities pass.
      for (const [id, rem] of fresh) expected.set(id, rem);
    }
    async function mutate<T>(
      step: string,
      fn: () => Promise<T>,
      after: (value: T) => Promise<void>
    ): Promise<void> {
      await preflight();
      active = step;
      journal!.steps[step] = 'started';
      await store.setLocal(key, journal);
      const value = await fn();
      await after(value);
      await preflight();
      journal!.steps[step] = 'verified';
      await store.setLocal(key, journal);
      active = undefined;
    }
    try {
      await checkPublicRevision(backend, remote);
      for (const id of plan.deletion?.ids ?? []) {
        await mutate(
          `${id}:delete`,
          () => backend.remove(id),
          async () => {
            if ((await backend.existingIds([id])).length)
              throw new Error('Deleted Rem is still present');
            const rem = expected.get(id)!;
            if (rem.parent) {
              const parent = expected.get(rem.parent)!;
              expected.set(rem.parent, {
                ...parent,
                children: parent.children.filter((child) => child !== id),
              });
            }
            expected.delete(id);
          }
        );
      }
      for (const change of plan.changes) {
        const isNew = change.key.startsWith('new:');
        let id = change.key;
        if (isNew) {
          await mutate(
            `${change.key}:create`,
            () =>
              backend.create(change.kind === 'multiline' ? 'Workspace question ===' : undefined),
            async (created) => {
              if (
                !created ||
                context.native.has(created) ||
                Object.values(journal!.ids).includes(created)
              )
                throw new Error('Creation returned an invalid/duplicate identity');
              // Save the returned ID before any subsequent read can fail.
              journal!.ids[change.key] = created;
              await store.setLocal(key, journal);
              const rem = (await readExact(backend, [created])).get(created)!;
              if (
                rem.parent !== null ||
                rem.children.length ||
                rem.document ||
                rem.folder ||
                rem.type !== null ||
                rem.unsupported ||
                (Array.isArray(rem.text) &&
                  rem.text.some(
                    (part) => part && typeof part === 'object' && 'i' in part && part.i === 's'
                  )) ||
                (change.kind === 'multiline' &&
                  (!Array.isArray(rem.backText) || rem.backText.length !== 0 || rem.cardItem))
              )
                throw new Error('Unexpected new Rem shape');
              expected.set(created, rem);
            }
          );
          id = journal.ids[change.key]!;
        }
        for (const field of ['text', 'backText'] as const) {
          const value = change.fields[field];
          if (value === undefined) continue;
          await mutate(
            `${change.key}:${field}`,
            () => backend.writeField(id, field, value),
            async () => {
              expected.set(id, { ...expected.get(id)!, [field]: value });
            }
          );
        }
        if (isNew) {
          const parent = change.parent?.startsWith('new:')
            ? journal.ids[change.parent]
            : change.parent;
          if (!parent || !expected.has(parent))
            throw new Error('Missing explicit creation parent binding');
          await mutate(
            `${change.key}:parent`,
            () => backend.setParent(id, parent, change.position),
            async () => {
              expected.set(id, { ...expected.get(id)!, parent });
              const p = expected.get(parent)!;
              const children = [...p.children];
              children.splice(change.position, 0, id);
              expected.set(parent, { ...p, children });
            }
          );
          if (expected.get(id)!.cardItem !== change.cardItem)
            await mutate(
              `${change.key}:cardItem`,
              () => backend.setCardItem(id, change.cardItem),
              async () => {
                expected.set(id, { ...expected.get(id)!, cardItem: change.cardItem });
              }
            );
        }
      }
      await preflight();
      const newCards: Record<string, Array<{ id: string; hash: string }>> = {};
      for (const change of plan.changes.filter(
        (change) => change.key.startsWith('new:') && change.kind === 'multiline'
      )) {
        const id = journal.ids[change.key]!,
          cards = await backend.cardFacts(id);
        if (!cards.length) throw new Error('New multiline card did not produce native cards');
        newCards[id] = cards;
      }
      for (const [id, cards] of Object.entries(newCards))
        if (hash(await backend.cardFacts(id)) !== hash(cards))
          throw new Error('New card identity changed during verification');
      await checkFiles(root, plan);
      if (plan.deletion && (await backend.existingIds(plan.deletion.ids)).length)
        throw new Error('Final deleted-ID absence check failed');
      for (const id of plan.deletion?.ids ?? []) remote.delete(id);
      for (const [id, rem] of expected) remote.set(id, rem);
      await checkPublicRevision(backend, remote);
      journal.final = {
        hashes: Object.fromEntries(
          [...remote].map(([id, rem]) => [id, publicationRevisionHash(rem)])
        ),
        files: plan.files,
        deleted: plan.deletion?.ids ?? [],
      };
      journal.state = 'verified';
      await store.setLocal(key, journal);
      await writeSnapshot(
        root,
        state.kbId,
        [...remote.values()],
        state,
        { ...state, globalDiscoveryComplete: false },
        frozen,
        undefined,
        undefined,
        plan.deletion?.ids,
        context.parsed,
        journal.ids
      );
      return {
        status: 'verified',
        complete: true,
        planHash,
        ids: journal.ids,
        updated: plan.changes
          .filter((change) => !change.key.startsWith('new:'))
          .map((change) => change.key),
        incoming: plan.incoming,
        converged: plan.converged,
        outgoing: plan.changes.map((change) => journal.ids[change.key] ?? change.key),
        metadataRefresh: metadataChanged,
        deleted: plan.deletion?.ids ?? [],
        nativeCards: newCards,
        cardsPreserved: true,
        remoteWrites: Object.keys(journal.steps).length,
        atomic: false,
        ...coverage,
      };
    } catch (error) {
      if (active) journal.steps[active] = 'unknown';
      if (journal.state !== 'verified') journal.state = active ? 'unknown' : 'conflict';
      await store.setLocal(key, journal);
      return {
        status: journal.state === 'verified' ? 'publication-incomplete' : journal.state,
        complete: false,
        planHash,
        journalKey: key,
        ids: journal.ids,
        steps: journal.steps,
        error: error instanceof Error ? error.message : String(error),
        atomic: false,
        ...coverage,
      };
    }
  });
}

/** Resume local publication only. A verified-remote journal may authorize exact-ID reads, never mutations. */
export async function recoverWorkspace(
  directory: string,
  backendFactory: () => Promise<WorkspaceBackend>
): Promise<unknown> {
  const root = await workspaceDirectory(directory);
  if (await readPublication(root)) return recoverPublication(directory);
  return withWorkspaceLock(root, async () => {
    const state = await authoritativeState(root);
    let repaired = false;
    try {
      await loadState(root);
    } catch {
      await writePrivate(root, STATE, JSON.stringify(state, null, 2) + '\n');
      repaired = true;
    }
    if (!state.pending) return { status: 'nothing-to-recover', complete: true, remoteWrites: 0 };
    const journal = await localStore(state.kbId).getLocal<Journal>(state.pending.journalKey);
    if (repaired && journal?.state === 'preview')
      return {
        status: 'state-mirror-repaired',
        complete: true,
        remoteWrites: 0,
        pending: state.pending,
      };
    if (!journal || journal.state !== 'verified' || !journal.final)
      throw new Error(
        'Remote outcome is not verified; preserve the original journal and known IDs, never retry mutations'
      );
    const local = await inspectLocal(root);
    if (local.diagnostics.length)
      throw new Error('Local content changed or failed lint; reconcile before recovery');
    for (const [path, digest] of Object.entries(journal.final.files))
      if (hash(await readPrivate(root, path)) !== digest)
        throw new Error('Local Markdown changed since verified sync');
    const frozen = await FrozenFiles.capture(root),
      backend = await backendFactory();
    if ((await backend.identity()).kbId !== state.kbId) throw new Error('Recovery KB mismatch');
    // Reuse the same full/public read policy as the verified pass, without turning unknown
    // native flags into assumed values or re-executing any operation from the journal.
    const rems = await readRemote(local, planLocal(local), backend);
    for (const [id, rem] of await readExact(backend, Object.values(journal.ids))) rems.set(id, rem);
    if (rems.size !== Object.keys(journal.final.hashes).length)
      throw new Error('Remote ID set changed after verified sync');
    for (const [id, rem] of rems)
      if (publicationRevisionHash(rem) !== journal.final.hashes[id])
        throw new Error(`Remote changed after verified sync: ${id}`);
    if (journal.final.deleted.length && (await backend.existingIds(journal.final.deleted)).length)
      throw new Error('Verified deletion no longer matches native state');
    await frozen.check();
    await writeSnapshot(
      root,
      state.kbId,
      [...rems.values()],
      state,
      { ...state, globalDiscoveryComplete: false },
      frozen,
      undefined,
      undefined,
      journal.final.deleted,
      local.parsed,
      journal.ids
    );
    return { status: 'recovered', complete: true, remoteWrites: 0, ids: journal.ids };
  });
}
