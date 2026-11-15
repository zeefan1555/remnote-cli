import {
  allFiles,
  readPrivate,
  STATE,
  withWorkspaceLock,
  workspaceDirectory,
  writePrivate,
  writePrivateOnce,
  assertFileSize,
} from './files.js';
import {
  inspectLocal,
  authoritativeState,
  loadState,
  localStore,
  saveState,
  serializeState,
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
  type ContentVersion,
  type SyncSelection,
} from './types.js';
import { selectPlan, type SelectionOptions } from './selection.js';
import { readRemote, reconcile, checkPublicRevision } from './reconcile.js';
import {
  contentProjection,
  cardIdentities,
  publicationRevisionHash,
  revisionHash,
  withNativeSnapshot,
} from './snapshots.js';
import { nodeContent } from './versions.js';
import { mapReads } from './read-pool.js';
import { planDeletion, type DeleteOptions } from './deletion.js';
import { FrozenFiles } from './frozen-files.js';
import { foldResume, verifyResumeReadback, type Journal } from './resume.js';
import { readOfficialExport, type OfficialBootstrap } from './official-export.js';
import {
  readPublication,
  requireNoPublication,
  recoverWorkspace as recoverPublication,
  stageSnapshot,
} from './publication.js';

async function requirePreviewOnly(state: WorkspaceState): Promise<void> {
  if (!state.pending) return;
  const old = await localStore(state.kbId).getLocal<Journal>(state.pending.journalKey);
  if (
    !old ||
    old.version !== 2 ||
    old.planHash !== state.pending.planHash ||
    old.state !== 'preview' ||
    Object.keys(old.steps).length
  )
    throw new Error(
      'Prior write outcome requires exact-ID reconciliation; never change its key or auto-replay it'
    );
}

/** Return source and its guard from the same read, without opening a native connection. */
export async function readWorkspace(directory: string, path: string) {
  const root = await workspaceDirectory(directory);
  return withWorkspaceLock(root, async () => {
    await requireNoPublication(root);
    const local = await inspectLocal(root);
    if (!local.parsed.has(path)) throw new Error('Read requires an exact tracked Markdown path');
    const content = await local.inputs.read(path);
    return {
      status: 'read',
      kbId: local.state.kbId,
      path,
      content,
      fileHash: hash(content),
      remoteWrites: 0,
    };
  });
}

/** One offline publication binds the edited source and per-Rem clocks; the native baseline stays put. */
export async function saveWorkspace(
  directory: string,
  path: string,
  content: string,
  expectedFileHash: string
) {
  const root = await workspaceDirectory(directory);
  return withWorkspaceLock(root, async () => {
    await requireNoPublication(root);
    const before = await inspectLocal(root),
      frozen = await before.inputs.freeze();
    await requirePreviewOnly(before.state);
    const original = before.parsed.get(path);
    if (
      !original ||
      !/^[a-f0-9]{64}$/.test(expectedFileHash) ||
      original.fileHash !== expectedFileHash
    )
      throw new Error(
        'Save requires the current fileHash from sync read for this exact Markdown path'
      );
    assertFileSize(path, content);
    const after = await inspectLocal(root, before.state, new Map([[path, content]]), before.inputs);
    planLocal(after);
    await frozen.check();
    if (hash(content) === expectedFileHash)
      return {
        status: 'unchanged',
        path,
        fileHash: expectedFileHash,
        changed: [],
        remoteWrites: 0,
      };
    const localVersions: Record<string, ContentVersion> = { ...before.state.localVersions };
    // A previously stamped Rem edited outside this entrypoint loses that stamp, not its content.
    for (const document of after.parsed.values())
      for (const node of document.nodes) {
        if (node.kind === 'mount') continue;
        if (
          localVersions[node.key]?.contentHash !==
          hash(nodeContent(node, before.native.get(node.key)))
        )
          delete localVersions[node.key];
      }
    const previousNodes = new Map(original.nodes.map((node) => [node.key, node]));
    const changed: string[] = [],
      timestamp = Date.now();
    for (const node of after.parsed.get(path)!.nodes) {
      if (node.kind === 'mount' || node.kind === 'opaque') continue;
      const previous = previousNodes.get(node.key),
        base = before.native.get(node.key);
      const contentHash = hash(nodeContent(node, base));
      if (previous && hash(nodeContent(previous, base)) === contentHash) continue;
      const priorTime = before.state.localVersions?.[node.key]?.timestamp;
      localVersions[node.key] = {
        contentHash,
        source: 'cli-save',
        timestamp:
          priorTime !== null && priorTime !== undefined && timestamp < priorTime ? null : timestamp,
      };
      changed.push(node.key);
    }
    const next = { ...before.state, localVersions };
    delete next.pending;
    await stageSnapshot(root, next, before.state, new Map([[path, content]]), frozen);
    return {
      status: 'saved',
      path,
      fileHash: hash(content),
      changed: changed.sort(),
      remoteWrites: 0,
    };
  });
}

async function archiveResolutions(
  root: string,
  context: LocalContext,
  plan: SyncPlan,
  remote: Map<string, WorkspaceRem>
) {
  const histories = [];
  for (const decision of plan.resolutions) {
    const node = context.parsed.get(decision.path)!.nodes.find((node) => node.key === decision.id)!;
    const local = nodeContent(node, context.native.get(decision.id)),
      native = contentProjection(remote.get(decision.id)!);
    if (hash(local) !== decision.local.contentHash || hash(native) !== decision.remote.contentHash)
      throw new Error('LWW history does not match its frozen content versions');
    const record = {
      version: 1,
      kbId: plan.kbId,
      directoryHash: hash(root),
      decision,
      local,
      remote: native,
    };
    const historyPath = `.sync/conflicts/${hash({ kbId: plan.kbId, directoryHash: hash(root), decision })}/${decision.id}.json`;
    await writePrivateOnce(root, historyPath, JSON.stringify(record, null, 2) + '\n');
    histories.push({ ...decision, historyPath, historyHash: hash(record) });
  }
  return histories;
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
      if (
        !Object.keys(fields).length &&
        context.state.localVersions?.[node.key]?.contentHash !== hash(nodeContent(node, native))
      )
        continue;
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
  options: { paths?: string[] } = {}
): Promise<unknown> {
  const root = await workspaceDirectory(directory),
    context = await inspectLocal(root),
    plan = await selectPlan(context, planLocal(context), options),
    frozen = await context.inputs.freeze();
  plan.inputHash = hash(frozen.hashes());
  await frozen.check();
  return {
    kbId: plan.kbId,
    remoteChecked: false,
    planHash: hash(plan),
    selection: plan.selection,
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
  ids: string[],
  options?: { tags?: boolean }
): Promise<Map<string, WorkspaceRem>> {
  const result = new Map<string, WorkspaceRem>();
  for (let start = 0; start < ids.length; start += 50) {
    const batch = ids.slice(start, start + 50),
      rems = options ? await backend.read(batch, options) : await backend.read(batch);
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
  for (const id of [
    ...(plan.selection?.reconcileIds ?? []),
    ...(plan.selection?.verificationIds ?? []),
  ])
    if (native.has(id) && native.get(id)!.unsupported !== 'unverified-native-flags') ids.add(id);
  return [...ids].sort();
}

/** Only candidates and actual structural mutations advance the shared native baseline. */
function publicationRems(
  context: LocalContext,
  remote: Map<string, WorkspaceRem>,
  selection: SyncSelection,
  assigned: Record<string, string>,
  deleted: string[],
  structuralIds: string[]
) {
  const result = new Map(context.native);
  for (const id of [...selection.reconcileIds, ...Object.values(assigned)])
    if (remote.has(id)) result.set(id, remote.get(id)!);
  for (const id of structuralIds) {
    if (selection.reconcileIds.includes(id) || !result.has(id)) continue;
    const base = result.get(id)!,
      current = remote.get(id)!;
    result.set(id, {
      ...base,
      children: [...current.children],
      ...(base.public ? { public: { ...base.public, children: [...current.children] } } : {}),
    });
  }
  for (const id of deleted) result.delete(id);
  return [...result.values()];
}

async function checkFiles(root: string, plan: WorkspacePlan): Promise<void> {
  await mapReads(Object.entries(plan.files), 16, async ([path, digest]) => {
    if (hash(await readPrivate(root, path)) !== digest)
      throw new Error('Local Markdown changed after plan was frozen');
  });
}

/** Offline lint completes before backendFactory, so lint failures cause zero remote calls. */
export async function pushWorkspace(
  directory: string,
  backendFactory: () => Promise<WorkspaceBackend>,
  options: DeleteOptions & SelectionOptions & { apply?: boolean; planHash?: string } = {}
): Promise<unknown> {
  return synchronizeWorkspace(directory, backendFactory, options);
}

/** Explicit continuation of a frozen write, never an automatic retry by ordinary apply. */
export async function resumeWorkspace(
  directory: string,
  backendFactory: () => Promise<WorkspaceBackend>,
  planHash: string
): Promise<unknown> {
  if (!/^[a-f0-9]{64}$/.test(planHash))
    throw new Error('Resume requires the exact original --plan-hash');
  const root = await workspaceDirectory(directory),
    state = await authoritativeState(root);
  if (state.pending?.planHash === planHash) {
    const journal = await localStore(state.kbId).getLocal<Journal>(state.pending.journalKey);
    if (journal?.state === 'verified' && journal.final)
      return recoverWorkspace(root, backendFactory);
  }
  return synchronizeWorkspace(root, backendFactory, { apply: true, planHash }, planHash);
}

async function synchronizeWorkspace(
  directory: string,
  backendFactory: () => Promise<WorkspaceBackend>,
  options: DeleteOptions & SelectionOptions & { apply?: boolean; planHash?: string },
  resumeHash?: string
): Promise<unknown> {
  if (options.deleteId || options.scopeRoot) {
    if (options.scope !== undefined || options.paths !== undefined)
      throw new Error('Explicit deletion does not accept --scope or --path');
    if (options.apply && !options.planHash)
      throw new Error('Explicit deletion apply requires the exact --plan-hash');
  }
  const root = await workspaceDirectory(directory);
  return withWorkspaceLock(root, async () => {
    await requireNoPublication(root);
    const context = await inspectLocal(root),
      state = context.state;
    let resuming: Journal | undefined;
    if (resumeHash) {
      const key = `workspace-v2:${state.kbId}:${hash(root)}:${resumeHash}`;
      resuming = await localStore(state.kbId).getLocal<Journal>(key);
      if (!resuming || resuming.version !== 2 || resuming.planHash !== resumeHash)
        throw new Error('Resume cannot find the exact original journal for this vault and KB');
      if (
        !state.pending &&
        resuming.state === 'verified' &&
        resuming.final &&
        Object.entries(resuming.final.hashes).every(
          ([id, digest]) =>
            context.native.has(id) && publicationRevisionHash(context.native.get(id)!) === digest
        ) &&
        resuming.final.deleted.every((id) => !context.native.has(id))
      )
        return {
          status: 'already-complete',
          complete: true,
          planHash: resumeHash,
          ids: resuming.ids,
          remoteWrites: 0,
        };
      if (
        state.pending?.planHash !== resumeHash ||
        state.pending.journalKey !== key ||
        !['applying', 'unknown', 'conflict'].includes(resuming.state) ||
        !resuming.selection ||
        resuming.selection.scope === 'delete'
      )
        throw new Error(
          "Resume requires this vault's exact pending outgoing journal; use sync recover for verified publication"
        );
      options = {
        apply: true,
        planHash: resumeHash,
        scope: resuming.selection.scope,
        paths: resuming.selection.paths,
      };
    }
    const localPlan = await selectPlan(context, planLocal(context, options), options);
    if (localPlan.changes.length > 100)
      throw new Error('One sync is limited to 100 changed/new nodes; narrow --path or split edits');
    let stateHash = hash(state);
    async function persistState(): Promise<void> {
      // Check before replacing either authority or mirror; a post-save check could hide tampering.
      if (hash(await loadState(root)) !== stateHash)
        throw new Error('Local sync metadata changed after plan was frozen');
      await saveState(root, state);
      stateHash = hash(state);
    }
    const frozen = await context.inputs.freeze();
    localPlan.inputHash = hash(frozen.hashes());
    const store = localStore(state.kbId);
    if (!resuming) await requirePreviewOnly(state);
    if (
      options.planHash !== undefined &&
      (!options.apply || !/^[a-f0-9]{64}$/.test(options.planHash))
    )
      throw new Error(
        'Apply requires the exact frozen --plan-hash; files and remote content must match preview'
      );
    const requestedSelection = localPlan.selection;
    const checkedIds = [
      ...requestedSelection.reconcileIds,
      ...requestedSelection.verificationIds,
    ].sort();
    const coverage = {
      discoveryScope: 'bound-ids',
      globalDiscoveryComplete: false,
      remoteChecked: checkedIds.length > 0,
      checkedIds,
      checkedCount: checkedIds.length,
      partial: requestedSelection.reconcileIds.length < context.native.size,
      selection: requestedSelection,
    };
    if (!checkedIds.length) {
      // Every selected Rem already equals its native baseline; only local layout may publish.
      const layoutChanged = context.dirty.some((path) => requestedSelection.files.includes(path));
      const planHash = hash(localPlan);
      if (options.planHash !== undefined && (!layoutChanged || options.planHash !== planHash))
        throw new Error('Apply requires the exact frozen --plan-hash; selected layout changed');
      await frozen.check();
      if (!layoutChanged)
        return {
          status: 'unchanged',
          complete: true,
          changes: 0,
          localPublished: false,
          remoteWrites: 0,
          ...coverage,
        };
      if (options.apply)
        await writeSnapshot(
          root,
          state.kbId,
          [...context.native.values()],
          state,
          state,
          frozen,
          undefined,
          undefined,
          [],
          context.parsed,
          {},
          requestedSelection
        );
      return {
        status: options.apply ? 'verified' : 'preview',
        complete: true,
        planHash,
        creates: 0,
        updates: 0,
        incoming: [],
        outgoing: [],
        converged: [],
        resolutions: [],
        localPublished: options.apply === true,
        remoteWrites: 0,
        ...coverage,
      };
    }
    if (
      options.planHash !== undefined &&
      (!state.pending || options.planHash !== state.pending.planHash)
    )
      throw new Error(
        'Apply requires the exact frozen --plan-hash; files and remote content must match preview'
      );
    const reconstructed = resuming
      ? reconcile(
          context,
          localPlan,
          new Map(checkedIds.map((id) => [id, context.native.get(id)!]))
        )
      : undefined;
    if (
      reconstructed &&
      (hash(reconstructed.plan) !== resumeHash ||
        hash(reconstructed.plan.selection) !== hash(resuming!.selection))
    )
      throw new Error(
        'Resume cannot reconstruct the exact original frozen plan from local content and baseline'
      );
    // Validate journal prefix and identities offline, before opening a native connection.
    const rebuiltRemote = reconstructed
      ? new Map(checkedIds.map((id) => [id, context.native.get(id)!]))
      : undefined;
    if (resuming && Object.values(resuming.ids).some((id) => context.native.has(id)))
      throw new Error('Resume creation identity belongs to an existing baseline Rem');
    const folded = reconstructed
      ? foldResume(
          reconstructed.plan,
          resuming!,
          new Map(
            affectedIds(reconstructed.plan, rebuiltRemote!).map((id) => [
              id,
              rebuiltRemote!.get(id)!,
            ])
          )
        )
      : undefined;
    const backend = await backendFactory(),
      identity = await backend.identity();
    if (identity.kbId !== state.kbId)
      throw new Error('Connected KB does not match workspace binding');
    const remote = rebuiltRemote ?? (await readRemote(context, localPlan, backend)),
      { plan, metadataChanged, remoteVersions } =
        reconstructed ?? reconcile(context, localPlan, remote),
      planHash = hash(plan);
    const selection = plan.selection!;
    coverage.selection = selection;
    if (
      options.planHash !== undefined &&
      (state.pending!.planHash !== planHash || options.planHash !== planHash)
    )
      throw new Error(
        'Apply requires the exact frozen --plan-hash; files and remote content must match preview'
      );
    await frozen.check();
    const stateBeforeObservations = hash(state);
    if (!resuming) state.remoteVersions = remoteVersions;
    if (state.pending && state.pending.planHash !== planHash) {
      delete state.pending;
    }
    if (hash(state) !== stateBeforeObservations) await persistState();
    const resolutions = await archiveResolutions(root, context, plan, remote);
    if (plan.conflicts.length) {
      const conflicts = [];
      for (const conflict of plan.conflicts) {
        const rem = remote.get(conflict.id);
        const remoteSnapshot = rem
          ? `.sync/conflicts/${planHash}/${conflict.id}-${hash(rem)}.json`
          : null;
        if (remoteSnapshot)
          await writePrivate(root, remoteSnapshot, JSON.stringify(rem, null, 2) + '\n');
        const node = context.parsed
          .get(conflict.path)!
          .nodes.find((node) => node.key === conflict.id)!;
        const localSnapshot = `.sync/conflicts/${planHash}/${conflict.id}-${conflict.localHash}.local.json`;
        await writePrivateOnce(
          root,
          localSnapshot,
          JSON.stringify(nodeContent(node, context.native.get(conflict.id)), null, 2) + '\n'
        );
        conflicts.push({ ...conflict, localSnapshot, remoteSnapshot });
      }
      return {
        status: 'conflict',
        complete: false,
        planHash,
        conflicts,
        resolutions,
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
      !context.dirty.some((path) => selection.files.includes(path))
    )
      return { status: 'unchanged', complete: true, changes: 0, remoteWrites: 0, ...coverage };
    const key = `workspace-v2:${state.kbId}:${hash(root)}:${planHash}`;
    let journal = resuming ?? (await store.getLocal<Journal>(key));
    if (
      journal &&
      !resuming &&
      (journal.version !== 2 ||
        journal.planHash !== planHash ||
        hash(journal.selection) !== hash(selection) ||
        journal.state !== 'preview' ||
        Object.keys(journal.steps).length)
    )
      throw new Error(
        'Prior write outcome requires exact-ID reconciliation; automatic replay is forbidden'
      );
    const existingIds = affectedIds(plan, remote);
    let expected = folded?.expected ?? new Map(existingIds.map((id) => [id, remote.get(id)!]));
    const protectedIds = existingIds.filter((id) => !plan.deletion?.ids.includes(id));
    const guardHash = await backend.guard(protectedIds);
    if (journal && journal.guardHash !== guardHash)
      throw new Error('Native card identity or immutable flags changed since preview');
    if (folded) {
      const fresh = await readExact(backend, existingIds);
      const createdIds = Object.values(resuming!.ids);
      for (const [id, rem] of await readExact(backend, createdIds, { tags: true }))
        fresh.set(id, rem);
      expected = verifyResumeReadback(expected, fresh, new Set(createdIds));
      // Only exact-after is recognized. Exact-before cannot rule out a delayed old SDK write.
      for (const step of folded.recognized) resuming!.steps[step] = 'verified';
      resuming!.resumed = true;
      for (const [id, rem] of expected) remote.set(id, rem);
      await frozen.check();
    }
    journal ??= {
      version: 2,
      planHash,
      guardHash,
      state: 'preview',
      steps: {},
      ids: {},
      selection,
    };
    await store.setLocal(key, journal);
    state.pending = { planHash, journalKey: key };
    await persistState();
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
        resolutions,
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
    const structuralIds = folded?.structuralIds ?? new Set<string>();
    let remoteWrites = 0;
    let checkedWriteBoundary = false;
    async function preflight(): Promise<void> {
      await checkFiles(root, plan);
      const createdIds = resuming ? new Set(Object.values(journal!.ids)) : new Set<string>();
      const fresh = await readExact(
        backend,
        [...expected.keys()].filter((id) => !createdIds.has(id))
      );
      if (resuming) {
        for (const [id, rem] of await readExact(backend, [...createdIds], { tags: true }))
          fresh.set(id, rem);
      }
      for (const [id, rem] of expected) {
        const current = withNativeSnapshot(rem, fresh.get(id)!);
        if (revisionHash(current) !== revisionHash(rem))
          throw new Error(`Concurrent remote change on ${id}`);
        if (
          createdIds.has(id) &&
          rem.cards?.length &&
          hash(cardIdentities(current)) !== hash(cardIdentities(rem))
        )
          throw new Error(`New card identity changed after resume readback: ${id}`);
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
      if (!checkedWriteBoundary) {
        // Expire inspection caches after the final native guard, before the first mutation.
        await frozen.check();
        if (hash(await loadState(root)) !== stateHash)
          throw new Error('Local sync metadata changed after plan was frozen');
        checkedWriteBoundary = true;
      }
      // Refresh remote-owned review metadata only after the semantic revision and identities pass.
      for (const [id, rem] of fresh) expected.set(id, rem);
    }
    async function mutate<T>(
      step: string,
      fn: () => Promise<T>,
      after: (value: T) => Promise<void>
    ): Promise<void> {
      if (resuming && journal!.steps[step] === 'verified') return;
      await preflight();
      active = step;
      journal!.steps[step] = 'started';
      await store.setLocal(key, journal);
      remoteWrites++;
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
              structuralIds.add(rem.parent);
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
              const rem = (
                await readExact(backend, [created], resuming ? { tags: true } : undefined)
              ).get(created)!;
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
              structuralIds.add(parent);
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
        const observed = expected
          .get(id)!
          .cards?.map(({ id, remId, type }) => ({
            id,
            hash: hash({ id, remId, type }),
          }))
          .sort((a, b) => a.id.localeCompare(b.id));
        if (hash(cards) !== hash(observed))
          throw new Error('New card identity changed after native snapshot verification');
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
        inputHash: plan.inputHash!,
        deleted: plan.deletion?.ids ?? [],
        structuralIds: [...structuralIds].sort(),
      };
      journal.state = 'verified';
      await store.setLocal(key, journal);
      await writeSnapshot(
        root,
        state.kbId,
        publicationRems(context, remote, selection, journal.ids, plan.deletion?.ids ?? [], [
          ...structuralIds,
        ]),
        state,
        { ...state, globalDiscoveryComplete: false },
        frozen,
        undefined,
        undefined,
        plan.deletion?.ids,
        context.parsed,
        journal.ids,
        selection
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
        resolutions,
        deleted: plan.deletion?.ids ?? [],
        nativeCards: newCards,
        ...(resuming ? { existingCardsPreserved: true } : { cardsPreserved: true }),
        remoteWrites,
        ...(resuming
          ? {
              resumed: true,
              recognizedSteps: folded!.recognized,
              newCardIdentityBaseline: 'resume-readback',
            }
          : {}),
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
        remoteWrites,
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
      await writePrivate(root, STATE, serializeState(state));
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
    if (
      !journal ||
      journal.version !== 2 ||
      journal.planHash !== state.pending.planHash ||
      !journal.selection ||
      journal.state !== 'verified' ||
      !journal.final
    )
      throw new Error(
        'Remote outcome is not verified; preserve the original journal and known IDs, never retry mutations'
      );
    const local = await inspectLocal(root);
    if (local.diagnostics.length)
      throw new Error('Local content changed or failed lint; reconcile before recovery');
    const frozen = await local.inputs.freeze();
    if (hash(frozen.hashes()) !== journal.final.inputHash)
      throw new Error('Local workspace changed since verified sync');
    const backend = await backendFactory();
    if ((await backend.identity()).kbId !== state.kbId) throw new Error('Recovery KB mismatch');
    // Reuse the same full/public read policy as the verified pass, without turning unknown
    // native flags into assumed values or re-executing any operation from the journal.
    const localPlan = planLocal(local);
    localPlan.changes = localPlan.changes.filter((change) =>
      journal.selection.outgoingKeys.includes(change.key)
    );
    localPlan.selection = journal.selection;
    const rems = await readRemote(local, localPlan, backend);
    for (const [id, rem] of await readExact(
      backend,
      Object.values(journal.ids),
      journal.resumed ? { tags: true } : undefined
    ))
      rems.set(id, rem);
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
      publicationRems(
        local,
        rems,
        journal.selection,
        journal.ids,
        journal.final.deleted,
        journal.final.structuralIds
      ),
      state,
      { ...state, globalDiscoveryComplete: false },
      frozen,
      undefined,
      undefined,
      journal.final.deleted,
      local.parsed,
      journal.ids,
      journal.selection
    );
    return { status: 'recovered', complete: true, remoteWrites: 0, ids: journal.ids };
  });
}
