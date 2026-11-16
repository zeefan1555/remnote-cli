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
} from './types.js';
import { selectPlan, publicVerificationIds, type SelectionOptions } from './selection.js';
import { readRemote, reconcile, checkPublicRevision } from './reconcile.js';
import {
  cardIdentities,
  publicationRevisionHash,
  revisionHash,
  withNativeSnapshot,
  withPublicSnapshot,
} from './snapshots.js';
import { recordPath } from './identity.js';
import { partitionRemote } from './feedback-partition.js';
import { nodeContent } from './versions.js';
import { mapReads } from './read-pool.js';
import { planDeletion, type DeleteOptions } from './deletion.js';
import { FrozenFiles } from './frozen-files.js';
import {
  foldResume,
  requireLocalAuthority,
  guardedBinding,
  verifyResumeReadback,
  finalProofHash,
  requireFinalProof,
  publishedBaselineHash,
  startPublisherExecution,
  type Journal,
} from './resume.js';
import { readOfficialExport, type OfficialBootstrap } from './official-export.js';
import {
  knownPowerupCodes,
  nativeOutline,
  nativeProof,
  outlineIds,
  workspaceOutline,
} from './outline.js';
import {
  readPublication,
  requireNoPublication,
  recoverWorkspace as recoverPublication,
  stageSnapshot,
} from './publication.js';

async function requirePreviewOnly(state: WorkspaceState): Promise<void> {
  if (!state.pending) return;
  const old = await localStore(state.kbId).getLocal<Journal>(state.pending.journalKey);
  if (old) requireLocalAuthority(old, state.pending.journalKey);
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
      contentAuthority: 'local' as const,
      status: 'read',
      kbId: local.state.kbId,
      path,
      content,
      fileHash: hash(content),
      outline: workspaceOutline(local, path),
      remoteWrites: 0,
    };
  });
}

/** One offline publication binds edited source bytes; the native baseline stays put. */
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
    const previousNodes = new Map(original.nodes.map((node) => [node.key, node]));
    const changed: string[] = [];
    for (const node of after.parsed.get(path)!.nodes) {
      if (node.kind === 'mount' || node.kind === 'opaque') continue;
      const previous = previousNodes.get(node.key),
        base = before.native.get(node.key);
      const contentHash = hash(nodeContent(node, base));
      if (previous && hash(nodeContent(previous, base)) === contentHash) continue;
      changed.push(node.key);
    }
    const next = { ...before.state };
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
  if (!context.state.tagIds)
    throw new Error(
      'Tag projection is not initialized; run explicit sync format on a clean sealed vault before syncing'
    );
  if (context.diagnostics.length)
    throw new Error(
      context.diagnostics.map((d) => `${d.path}:${d.line} / ${d.code} / ${d.message}`).join('\n')
    );
  const plan: WorkspacePlan = {
    contentAuthority: 'local',
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
      if (
        context.state.feedbackRoles &&
        node.tags?.some(
          (id) =>
            id === context.state.feedbackRoles!.todoTagId ||
            id === context.state.feedbackRoles!.doneTagId
        )
      )
        throw new Error('Feedback role tags are native lifecycle, not authored content tags');
      const before = baseline.get(node.key),
        native = context.native.get(node.key),
        parent = node.parent ? nodes.get(node.parent) : undefined;
      const fields: WorkspaceChange['fields'] = {};
      const beforeTags = before?.tags;
      const tags =
        node.tags && hash(beforeTags ?? []) !== hash(node.tags)
          ? { before: beforeTags ?? [], after: node.tags }
          : undefined;
      if (tags && native && !Array.isArray(native.tags))
        throw new Error(
          `${path}:${node.line} / TAG_BASELINE / Native direct tags have not been collected`
        );
      if (!before || hash(before.text) !== hash(node.text)) fields.text = node.text;
      if (node.kind === 'basic' && (!before || hash(before.backText) !== hash(node.backText)))
        fields.backText = node.backText;
      if (!Object.keys(fields).length && !tags) continue;
      plan.changes.push({
        key: node.key,
        path,
        parent: node.parent ?? native?.parent ?? null,
        position: parent ? parent.children.indexOf(node.key) : 0,
        kind: node.kind,
        cardItem: before ? native!.cardItem === true : parent?.kind === 'multiline',
        ...(node.cardCluster ? { cardCluster: true } : {}),
        ...(native ? { beforeHash: hash(native) } : {}),
        fields,
        ...(tags ? { tags } : {}),
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
    contentAuthority: 'local',
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
  options?: Parameters<WorkspaceBackend['read']>[1]
): Promise<Map<string, WorkspaceRem>> {
  const result = new Map<string, WorkspaceRem>();
  for (let start = 0; start < ids.length; start += 50) {
    const batch = ids.slice(start, start + 50),
      rems = await backend.read(batch, { tags: true, ...options });
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

function affectedIds(
  plan: SyncPlan,
  native: Map<string, WorkspaceRem>,
  metadataIds: string[] = []
): string[] {
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
  for (const id of plan.converged) {
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
    ...(plan.selection?.scope === 'all' ? plan.selection.reconcileIds : metadataIds),
    ...(plan.selection?.verificationIds ?? []),
  ])
    if (native.has(id) && native.get(id)!.unsupported !== 'unverified-native-flags') ids.add(id);
  return [...ids].sort();
}

/** Only candidates and actual structural mutations advance the shared native baseline. */
function publicationRems(
  context: LocalContext,
  remote: Map<string, WorkspaceRem>,
  publicationIds: string[],
  deleted: string[],
  structuralIds: string[]
) {
  const result = new Map(context.native);
  for (const id of publicationIds) if (remote.has(id)) result.set(id, remote.get(id)!);
  for (const id of structuralIds) {
    if (publicationIds.includes(id) || deleted.includes(id) || !result.has(id)) continue;
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

function publicationIds(
  plan: SyncPlan,
  metadataIds: string[],
  assigned: Record<string, string> = {}
): string[] {
  const deleted = new Set(plan.deletion?.ids ?? []);
  return [
    ...new Set([
      ...(plan.selection!.scope === 'changed' && !plan.guarded
        ? [
            ...plan.converged,
            ...metadataIds,
            ...plan.changes
              .filter((change) => !change.key.startsWith('new:'))
              .map((change) => change.key),
          ]
        : plan.selection!.reconcileIds),
      ...Object.values(assigned),
    ]),
  ]
    .filter((id) => !deleted.has(id))
    .sort();
}

/** Refresh only the explicitly verified identities; S minus G remains the first observation. */
async function checkPublicScope(
  backend: WorkspaceBackend,
  remote: Map<string, WorkspaceRem>,
  ids: string[]
) {
  const exact = new Map(
    ids.map((id) => {
      if (!remote.has(id)) throw new Error(`Missing public verification dependency: ${id}`);
      return [id, remote.get(id)!] as const;
    })
  );
  await checkPublicRevision(backend, exact, knownPowerupCodes(exact));
  for (const [id, rem] of exact) remote.set(id, rem);
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
  options: DeleteOptions &
    SelectionOptions & { apply?: boolean; planHash?: string; expectedFileHash?: string } = {}
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
  const key = `workspace-v2:${state.kbId}:${hash(root)}:${planHash}`;
  const journal = await localStore(state.kbId).getLocal<Journal>(key);
  if (journal) requireLocalAuthority(journal, key);
  if (journal?.state === 'verified' && journal.final) {
    requireFinalProof(journal);
    const binding = guardedBinding(journal);
    if (state.pending?.planHash === planHash || (await readPublication(root))) {
      const result = await recoverWorkspace(root, backendFactory);
      if (!binding) return result;
    }
    if (binding)
      return withWorkspaceLock(root, async () => {
        await requireNoPublication(root);
        const context = await inspectLocal(root);
        if (
          context.diagnostics.length ||
          context.dirty.length ||
          context.state.pending ||
          publishedBaselineHash(journal, context.native) !== journal.final!.publishedBaselineHash
        )
          throw new Error(
            'Guarded resume receipt requires the unchanged successfully published baseline'
          );
        const frozen = await context.inputs.freeze(),
          backend = await backendFactory();
        if ((await backend.identity()).kbId !== context.state.kbId)
          throw new Error('Resume receipt KB mismatch');
        const remote = await readExact(backend, Object.keys(journal.final!.hashes), {
          powerupCodes: knownPowerupCodes(context.native),
        });
        for (const [id, rem] of remote) {
          const baseline = context.native.get(id);
          const current = baseline ? withNativeSnapshot(baseline, rem) : rem;
          if (
            !baseline ||
            publicationRevisionHash(current) !== journal.final!.hashes[id] ||
            Object.entries(baseline.powerupPresence ?? {}).some(
              ([code, present]) => rem.powerupPresence?.[code] !== present
            )
          )
            throw new Error(`Native state changed after guarded publication: ${id}`);
          remote.set(id, current);
        }
        await frozen.check();
        return {
          contentAuthority: 'local',
          status: 'verified',
          complete: true,
          resumed: true,
          existingCardsPreserved: true,
          planHash,
          ids: journal.ids,
          remoteWrites: 0,
          verification: {
            fileHash: binding.fileHash,
            planHash,
            nativeBefore: journal.proof!.nativeBefore,
            nativeAfter: Object.fromEntries([...remote].map(([id, rem]) => [id, nativeProof(rem)])),
            observedHashes: Object.fromEntries(
              [...remote].map(([id, rem]) => [
                id,
                nativeOutline(rem, new Map([...context.native, ...remote])).revisionHash,
              ])
            ),
          },
          outline: workspaceOutline(
            { ...context, native: new Map([...context.native, ...remote]) },
            binding.path
          ),
        };
      });
  }
  return synchronizeWorkspace(root, backendFactory, { apply: true, planHash }, planHash);
}

async function synchronizeWorkspace(
  directory: string,
  backendFactory: () => Promise<WorkspaceBackend>,
  options: DeleteOptions &
    SelectionOptions & { apply?: boolean; planHash?: string; expectedFileHash?: string },
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
      requireLocalAuthority(resuming, key);
      if (
        !state.pending &&
        !context.diagnostics.length &&
        resuming.state === 'verified' &&
        resuming.final &&
        requireFinalProof(resuming) &&
        publishedBaselineHash(resuming, context.native) === resuming.final.publishedBaselineHash &&
        resuming.final.deleted.every((id) => !context.native.has(id))
      )
        return {
          status: 'already-complete',
          contentAuthority: 'local',
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
        ...(guardedBinding(resuming)
          ? { expectedFileHash: guardedBinding(resuming)!.fileHash }
          : {}),
      };
    }
    const proofPath = options.expectedFileHash === undefined ? undefined : options.paths?.[0];
    if (options.expectedFileHash !== undefined) {
      if (
        !options.apply ||
        options.deleteId ||
        options.scopeRoot ||
        options.paths?.length !== 1 ||
        !proofPath ||
        !/^[a-f0-9]{64}$/.test(options.expectedFileHash) ||
        context.parsed.get(proofPath)?.fileHash !== options.expectedFileHash
      )
        throw new Error(
          'Guarded apply requires one exact --path and its current --expected-file-hash from sync read; no native calls were made'
        );
      options = { ...options, scope: 'all' };
    }
    const localPlan = await selectPlan(context, planLocal(context, options), options);
    if (resuming?.proof) localPlan.guarded = guardedBinding(resuming);
    if (proofPath)
      localPlan.selection.verificationIds = [
        ...new Set([
          ...localPlan.selection.verificationIds,
          ...outlineIds(context, proofPath).filter(
            (id) => !localPlan.selection.reconcileIds.includes(id)
          ),
        ]),
      ].sort();
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
      contentAuthority: 'local' as const,
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
        outgoing: [],
        converged: [],
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
    const resumeBaseline = new Map(
      checkedIds.map((id) => [
        id,
        { ...context.native.get(id)!, ...resuming?.physicalBaseline?.[id] },
      ])
    );
    const reconstructed = resuming ? reconcile(context, localPlan, resumeBaseline) : undefined;
    if (
      reconstructed &&
      (hash(reconstructed.plan) !== resumeHash ||
        hash(reconstructed.plan.selection) !== hash(resuming!.selection))
    )
      throw new Error(
        'Resume cannot reconstruct the exact original frozen plan from local content and baseline'
      );
    // Validate journal prefix and identities offline, before opening a native connection.
    const rebuiltRemote = reconstructed ? resumeBaseline : undefined;
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
    const remote =
      rebuiltRemote ??
      (await readRemote(context, localPlan, backend, knownPowerupCodes(context.native)));
    const nativeBefore = proofPath
      ? (resuming?.proof?.nativeBefore ??
        Object.fromEntries([...remote].map(([id, rem]) => [id, nativeProof(rem)])))
      : undefined;
    if (proofPath && !resuming)
      localPlan.guarded = {
        path: proofPath,
        fileHash: options.expectedFileHash!,
        beforeHash: hash(nativeBefore),
      };
    const { plan, metadataChanged } = reconstructed ?? reconcile(context, localPlan, remote),
      planHash = hash(plan);
    const selection = plan.selection!;
    const removesTags = plan.changes.some((change) =>
      change.tags?.before.some((tag) => !change.tags!.after.includes(tag))
    );
    if (options.apply && removesTags && !identity.destructive)
      throw new Error(
        'Removing native tag associations requires explicit --allow-destructive and the existing plugin replace gate; no writes were started. Properties and Rem entities are never deleted by tag sync'
      );
    coverage.selection = selection;
    coverage.checkedIds = [
      ...new Set([...selection.reconcileIds, ...selection.verificationIds]),
    ].sort();
    coverage.checkedCount = coverage.checkedIds.length;
    if (
      options.planHash !== undefined &&
      (state.pending!.planHash !== planHash || options.planHash !== planHash)
    )
      throw new Error(
        'Apply requires the exact frozen --plan-hash; files and remote content must match preview'
      );
    await frozen.check();
    const stateBeforeObservations = hash(state);
    if (state.pending && state.pending.planHash !== planHash) {
      delete state.pending;
    }
    if (hash(state) !== stateBeforeObservations) await persistState();
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
          JSON.stringify(
            {
              ...nodeContent(node, context.native.get(conflict.id)),
              tags: node.tags ?? context.native.get(conflict.id)?.tags ?? null,
            },
            null,
            2
          ) + '\n'
        );
        conflicts.push({ ...conflict, localSnapshot, remoteSnapshot });
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
      !plan.converged.length &&
      !metadataChanged.length &&
      !proofPath &&
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
    let existingIds = affectedIds(plan, remote, metadataChanged);
    const publishing = publicationIds(plan, metadataChanged);
    let verificationIds = publicVerificationIds(context, plan, remote, publishing, existingIds);
    const missingProof = verificationIds.filter((id) => !remote.has(id));
    for (let start = 0; start < missingProof.length;) {
      const batch = missingProof.slice(start, start + 50),
        probes = await backend.readProbe(batch, {
          powerupCodes: knownPowerupCodes(context.native),
        });
      if (
        probes.length !== batch.length ||
        new Set(probes.map((probe) => probe.snapshot.id)).size !== batch.length
      )
        throw new Error('Missing exact public verification dependency');
      for (const probe of probes) {
        const id = probe.snapshot.id;
        if (typeof id !== 'string' || !batch.includes(id) || !context.native.has(id))
          throw new Error('Unexpected public verification dependency');
        const before = context.native.get(id)!;
        // Absent/null memberships were never collected, not an observed empty set. Complete
        // that fact for this proof only; keep every previously known semantic field guarded.
        const expected = before.tags == null ? { ...before, tags: probe.tags } : before;
        if (
          publicationRevisionHash({
            ...withPublicSnapshot(before, probe.snapshot),
            tags: probe.tags,
          }) !== publicationRevisionHash(expected)
        )
          throw new Error(`Unobserved verification dependency changed: ${id}`);
        for (const tag of probe.tags)
          if (!context.native.has(tag))
            throw new Error(`Verification dependency tag has no sealed native baseline: ${tag}`);
        for (const code of knownPowerupCodes(context.native)[id] ?? []) {
          const expected =
            before.powerupPresence?.[code] ??
            before.powerups?.some((powerup) => powerup.code === code);
          if (
            typeof probe.powerupPresence?.[code] !== 'boolean' ||
            probe.powerupPresence[code] !== expected
          )
            throw new Error(`Verification dependency Powerup changed: ${id}/${code}`);
        }
        remote.set(id, {
          ...withPublicSnapshot(before, probe.snapshot),
          tags: probe.tags,
          ...(probe.powerupPresence ? { powerupPresence: probe.powerupPresence } : {}),
        });
      }
      // A newly collected tag set can introduce further proof dependencies. Close G before
      // either public boundary, without adding merge candidates to S or publications to P.
      verificationIds = publicVerificationIds(context, plan, remote, publishing, existingIds);
      for (const id of verificationIds)
        if (!remote.has(id) && !missingProof.includes(id)) missingProof.push(id);
      start += batch.length;
    }
    if (selection.scope === 'changed') {
      const extra = verificationIds.filter(
        (id) =>
          !existingIds.includes(id) && remote.get(id)?.unsupported !== 'unverified-native-flags'
      );
      for (const [id, rem] of await readExact(backend, extra, {
        tags: true,
        powerupCodes: knownPowerupCodes(context.native),
      })) {
        const before = remote.get(id)!;
        if (
          publicationRevisionHash(withNativeSnapshot(before, rem)) !==
          publicationRevisionHash(before)
        )
          throw new Error(`Verification dependency changed: ${id}`);
        remote.set(id, withNativeSnapshot(before, rem));
      }
      existingIds = [...new Set([...existingIds, ...extra])].sort();
    }
    // Only outgoing creations may acquire new cards.
    const observedNativeIds = new Set(context.native.keys());
    let expected = folded?.expected ?? new Map(existingIds.map((id) => [id, remote.get(id)!]));
    if (folded)
      for (const id of existingIds) if (!expected.has(id)) expected.set(id, remote.get(id)!);
    const protectedIds = existingIds.filter((id) => !plan.deletion?.ids.includes(id));
    const guardHash = await backend.guard(protectedIds);
    if (journal && journal.guardHash !== guardHash)
      throw new Error('Native card identity or immutable flags changed since preview');
    if (folded) {
      const fresh = await readExact(backend, existingIds, {
        powerupCodes: knownPowerupCodes(expected),
      });
      const createdIds = Object.values(resuming!.ids);
      for (const [id, rem] of await readExact(backend, createdIds, {
        tags: true,
        powerupCodes: knownPowerupCodes(expected),
      }))
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
      contentAuthority: 'local',
      planHash,
      guardHash,
      state: 'preview',
      steps: {},
      ids: {},
      selection,
      ...(plan.physicalBaseline
        ? { physicalBaseline: structuredClone(plan.physicalBaseline) }
        : {}),
      ...(nativeBefore ? { proof: { plan: structuredClone(plan), nativeBefore } } : {}),
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
        converged: plan.converged,
        outgoing: plan.changes.map((change) => change.key),
        metadataRefresh: metadataChanged,
        deletion: plan.deletion,
        tagChanges: plan.changes
          .filter((change) => change.tags)
          .map((change) => ({ key: change.key, ...change.tags! })),
        requiredPermissions: removesTags
          ? ['allow-destructive', 'plugin.acceptReplaceOperation']
          : [],
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
    if (writesRemote && journal.executionSequence === undefined)
      journal.executionSequence = await startPublisherExecution(store, root);
    journal.state = 'applying';
    await store.setLocal(key, journal);
    let active: string | undefined;
    const structuralIds = folded?.structuralIds ?? new Set<string>();
    let remoteWrites = 0;
    let checkedWriteBoundary = false;
    function boundaryIds(step?: string): string[] {
      if (!step) return [...expected.keys()];
      const change = plan.changes.find((item) => step.startsWith(`${item.key}:`));
      if (!change) return [...expected.keys()];
      const id = journal!.ids[change.key] ?? change.key,
        ids = new Set<string>();
      const include = (key: string | null | undefined) => {
        if (!key || !expected.has(key)) return;
        const rem = expected.get(key)!;
        ids.add(key);
        if (rem.cardItem && rem.parent) ids.add(rem.parent);
        if (Array.isArray(rem.backText))
          for (const child of rem.children) if (expected.has(child)) ids.add(child);
      };
      include(id);
      for (const tag of change.tags?.after ?? []) {
        for (
          let ancestor: string | null = tag;
          ancestor && expected.has(ancestor);
          ancestor = expected.get(ancestor)!.parent
        )
          include(ancestor);
      }
      if (change.key.startsWith('new:'))
        include(change.parent?.startsWith('new:') ? journal!.ids[change.parent] : change.parent);
      return [...ids];
    }
    async function preflight(step?: string): Promise<void> {
      await checkFiles(root, plan);
      const createdIds = resuming ? new Set(Object.values(journal!.ids)) : new Set<string>();
      const scopedIds = boundaryIds(step);
      const fresh = await readExact(
        backend,
        scopedIds.filter((id) => !createdIds.has(id)),
        { powerupCodes: knownPowerupCodes(expected) }
      );
      if (resuming) {
        for (const [id, rem] of await readExact(
          backend,
          scopedIds.filter((id) => createdIds.has(id)),
          { tags: true, powerupCodes: knownPowerupCodes(expected) }
        ))
          fresh.set(id, rem);
      }
      await partitionRemote(
        fresh,
        new Set([...context.native.keys(), ...Object.values(journal!.ids)]),
        state.feedbackRoles,
        backend
      );
      for (const id of scopedIds) {
        const rem = expected.get(id)!;
        const current = withNativeSnapshot(rem, fresh.get(id)!);
        if (revisionHash(current) !== revisionHash(rem))
          throw new Error(`Concurrent remote change on ${id}`);
        if (
          Object.keys(rem.powerupPresence ?? {}).some(
            (code) => fresh.get(id)!.powerupPresence?.[code] !== rem.powerupPresence![code]
          )
        )
          throw new Error(`Concurrent native Powerup change on ${id}`);
        if (
          !plan.deletion?.ids.includes(id) &&
          (observedNativeIds.has(id) || (createdIds.has(id) && rem.cards?.length)) &&
          hash(cardIdentities(current)) !== hash(cardIdentities(rem))
        )
          throw new Error(`Native card identity changed after observed readback: ${id}`);
        fresh.set(id, current);
      }
      if (!step && (await backend.guard(protectedIds)) !== guardHash)
        throw new Error('Existing card identity or immutable flags changed');
      const identity = await backend.identity();
      if (
        identity.kbId !== state.kbId ||
        (writesRemote && !identity.writable) ||
        ((plan.deletion || removesTags) && !identity.destructive)
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
      for (const [id, rem] of fresh) {
        expected.set(id, rem);
        // Track only accepted native readbacks, never synthesized after-mutation expectations.
      }
    }
    async function mutate<T>(
      step: string,
      fn: () => Promise<T>,
      after: (value: T) => Promise<void>
    ): Promise<void> {
      if (resuming && journal!.steps[step] === 'verified') return;
      await preflight(step);
      active = step;
      journal!.steps[step] = 'started';
      await store.setLocal(key, journal);
      remoteWrites++;
      const value = await fn();
      await after(value);
      await preflight(step);
      journal!.steps[step] = 'verified';
      await store.setLocal(key, journal);
      active = undefined;
    }
    try {
      await preflight();
      await checkPublicScope(backend, remote, verificationIds);
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
                await readExact(backend, [created], {
                  tags: true,
                  ...(change.cardCluster ? { powerupCodes: { [created]: ['cc'] } } : {}),
                })
              ).get(created)!;
              if (
                rem.parent !== null ||
                rem.children.length ||
                rem.document ||
                rem.folder ||
                rem.type !== null ||
                rem.unsupported ||
                (change.cardCluster && rem.powerupPresence?.cc !== false) ||
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
        if (change.tags) {
          for (const [operation, tags] of [
            ['remove', change.tags.before.filter((tag) => !change.tags!.after.includes(tag))],
            ['add', change.tags.after.filter((tag) => !change.tags!.before.includes(tag))],
          ] as const) {
            for (const tag of tags)
              await mutate(
                `${change.key}:tag:${operation}:${tag}`,
                () => (operation === 'add' ? backend.addTag(id, tag) : backend.removeTag(id, tag)),
                async () => {
                  const current = expected.get(id)!;
                  if (!Array.isArray(current.tags))
                    throw new Error('Native tags must be known before a relationship write');
                  expected.set(id, {
                    ...current,
                    tags:
                      operation === 'add'
                        ? [...new Set([...current.tags, tag])].sort()
                        : current.tags.filter((value) => value !== tag),
                  });
                }
              );
          }
        }
        if (isNew) {
          if (change.cardCluster)
            await mutate(
              `${change.key}:cardCluster`,
              () => backend.setCardCluster(id),
              async () => {
                const rem = expected.get(id)!;
                expected.set(id, { ...rem, powerupPresence: { ...rem.powerupPresence, cc: true } });
              }
            );
          const parent = change.parent?.startsWith('new:')
            ? journal.ids[change.parent]
            : change.parent;
          if (!parent || !expected.has(parent))
            throw new Error('Missing explicit creation parent binding');
          await mutate(
            `${change.key}:parent`,
            () => backend.setParent(id, parent, change.physicalPosition ?? change.position),
            async () => {
              expected.set(id, { ...expected.get(id)!, parent });
              const p = expected.get(parent)!;
              structuralIds.add(parent);
              const children = [...p.children];
              children.splice(change.physicalPosition ?? change.position, 0, id);
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
      const finalIds = [...new Set([...verificationIds, ...Object.values(journal.ids)])]
        .filter((id) => !plan.deletion?.ids.includes(id))
        .sort();
      await checkPublicScope(backend, remote, finalIds);
      const publishedIds = publicationIds(plan, metadataChanged, journal.ids);
      const projected = publicationRems(context, remote, publishedIds, plan.deletion?.ids ?? [], [
        ...structuralIds,
      ]);
      journal.final = {
        hashes: Object.fromEntries(
          finalIds.map((id) => [id, publicationRevisionHash(remote.get(id)!)])
        ),
        inputHash: plan.inputHash!,
        deleted: plan.deletion?.ids ?? [],
        structuralIds: [...structuralIds].sort(),
        publicationIds: publishedIds,
        publishedBaselineHash: '',
        proofHash: '',
      };
      journal.final.publishedBaselineHash = publishedBaselineHash(
        journal,
        new Map(projected.map((rem) => [rem.id, rem]))
      );
      journal.final.proofHash = finalProofHash(journal);
      requireFinalProof(journal);
      journal.state = 'verified';
      await store.setLocal(key, journal);
      await writeSnapshot(
        root,
        state.kbId,
        projected,
        state,
        { ...state, globalDiscoveryComplete: false },
        frozen,
        undefined,
        undefined,
        plan.deletion?.ids,
        context.parsed,
        journal.ids,
        selection,
        { kind: 'sync', journalKey: key, planHash, proofHash: journal.final.proofHash }
      );
      const verification = proofPath
        ? {
            fileHash: options.expectedFileHash!,
            planHash,
            nativeBefore,
            nativeAfter: Object.fromEntries([...remote].map(([id, rem]) => [id, nativeProof(rem)])),
            observedHashes: Object.fromEntries(
              [...remote].map(([id, rem]) => [
                id,
                nativeOutline(rem, new Map([...context.native, ...remote])).revisionHash,
              ])
            ),
          }
        : undefined;
      const outline = proofPath
        ? workspaceOutline(
            { ...(await inspectLocal(root)), native: new Map([...context.native, ...remote]) },
            proofPath
          )
        : undefined;
      return {
        status: 'verified',
        complete: true,
        planHash,
        ids: journal.ids,
        ...(verification ? { verification, outline } : {}),
        updated: plan.changes
          .filter((change) => !change.key.startsWith('new:'))
          .map((change) => change.key),
        converged: plan.converged,
        outgoing: plan.changes.map((change) => journal.ids[change.key] ?? change.key),
        metadataRefresh: metadataChanged,
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
  if (await readPublication(root)) {
    const result = await recoverPublication(directory, async (publication, before, after) => {
      const binding = publication.recovery;
      if (binding.kind !== 'sync') throw new Error('Unexpected local publication verifier');
      const journal = await localStore(publication.next.kbId).getLocal<Journal>(binding.journalKey);
      if (journal) requireLocalAuthority(journal, binding.journalKey);
      if (
        !journal ||
        journal.state !== 'verified' ||
        journal.planHash !== binding.planHash ||
        binding.journalKey !==
          `workspace-v2:${publication.next.kbId}:${hash(root)}:${binding.planHash}` ||
        requireFinalProof(journal).proofHash !== binding.proofHash
      )
        throw new Error('Sync publication journal binding changed');
      const final = requireFinalProof(journal);
      if (hash(publication.baseline) !== final.inputHash)
        throw new Error('Sync publication input binding changed');
      const oldNative = new Map<string, WorkspaceRem>(),
        nextNative = new Map<string, WorkspaceRem>();
      const paths = [
        ...new Set([
          ...Object.keys(publication.baseline),
          ...publication.writes.map((write) => write.path),
        ]),
      ];
      for (const path of paths.filter((path) => path.startsWith('.remnote/records/'))) {
        for (const [reader, target] of [
          [before, oldNative],
          [after, nextNative],
        ] as const) {
          const bytes = reader(path);
          if (bytes === null) continue;
          const rem = JSON.parse(bytes) as WorkspaceRem;
          if (recordPath(rem.id) !== path || target.has(rem.id))
            throw new Error('Invalid staged native identity');
          target.set(rem.id, rem);
        }
      }
      if (
        publishedBaselineHash(journal, nextNative) !== final.publishedBaselineHash ||
        hash([...nextNative.keys()].sort()) !== hash(Object.keys(publication.next.entries).sort())
      )
        throw new Error('Projected publication baseline changed');
      for (const [id, rem] of nextNative) {
        const entry = publication.next.entries[id]!;
        if (entry.nativeHash !== hash(rem) || entry.rawHash !== hash(after(entry.rawPath)))
          throw new Error('Staged native manifest changed');
      }
      const backend = await backendFactory();
      if ((await backend.identity()).kbId !== publication.next.kbId)
        throw new Error('Recovery KB mismatch');
      const rems = await readFrozenProof(backend, journal, new Map([...oldNative, ...nextNative]));
      const projected = publicationRems(
        { native: oldNative } as LocalContext,
        rems,
        final.publicationIds,
        final.deleted,
        final.structuralIds
      );
      if (
        publishedBaselineHash(journal, new Map(projected.map((rem) => [rem.id, rem]))) !==
        final.publishedBaselineHash
      )
        throw new Error('Projected publication baseline changed');
    });
    return { ...(result as Record<string, unknown>), contentAuthority: 'local' };
  }
  return withWorkspaceLock(root, async () => {
    // A writer may have published a ledger after the unlocked routing lookup.
    // Refuse under this lock; retrying recovery must choose the staged path explicitly.
    await requireNoPublication(root);
    const state = await authoritativeState(root);
    if (state.pending) {
      const pending = await localStore(state.kbId).getLocal<Journal>(state.pending.journalKey);
      if (pending) requireLocalAuthority(pending, state.pending.journalKey);
    }
    let repaired = false;
    try {
      await loadState(root);
    } catch {
      await writePrivate(root, STATE, serializeState(state));
      repaired = true;
    }
    if (!state.pending)
      return {
        contentAuthority: 'local',
        status: 'nothing-to-recover',
        complete: true,
        remoteWrites: 0,
      };
    const journal = await localStore(state.kbId).getLocal<Journal>(state.pending.journalKey);
    if (repaired && journal?.state === 'preview')
      return {
        status: 'state-mirror-repaired',
        contentAuthority: 'local',
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
    const final = requireFinalProof(journal);
    const local = await inspectLocal(root);
    if (local.diagnostics.length)
      throw new Error('Local content changed or failed lint; reconcile before recovery');
    const frozen = await local.inputs.freeze();
    if (hash(frozen.hashes()) !== journal.final.inputHash)
      throw new Error('Local workspace changed since verified sync');
    const backend = await backendFactory();
    if ((await backend.identity()).kbId !== state.kbId) throw new Error('Recovery KB mismatch');
    const rems = await readFrozenProof(backend, journal, local.native);
    const projected = publicationRems(
      local,
      rems,
      final.publicationIds,
      final.deleted,
      final.structuralIds
    );
    if (
      publishedBaselineHash(journal, new Map(projected.map((rem) => [rem.id, rem]))) !==
      final.publishedBaselineHash
    )
      throw new Error('Projected publication baseline changed');
    await frozen.check();
    await writeSnapshot(
      root,
      state.kbId,
      projected,
      state,
      { ...state, globalDiscoveryComplete: false },
      frozen,
      undefined,
      undefined,
      journal.final.deleted,
      local.parsed,
      journal.ids,
      journal.selection,
      {
        kind: 'sync',
        journalKey: state.pending.journalKey,
        planHash: journal.planHash,
        proofHash: final.proofHash,
      }
    );
    return {
      contentAuthority: 'local',
      status: 'recovered',
      complete: true,
      remoteWrites: 0,
      ids: journal.ids,
    };
  });
}

/** Recovery reads the frozen exact G, never re-runs discovery or native mutations. */
async function readFrozenProof(
  backend: WorkspaceBackend,
  journal: Journal,
  baseline: Map<string, WorkspaceRem>
) {
  const final = requireFinalProof(journal),
    ids = Object.keys(final.hashes).sort();
  const unknown = ids.filter((id) => baseline.get(id)?.unsupported === 'unverified-native-flags');
  const codes = knownPowerupCodes(baseline);
  for (const [key, id] of Object.entries(journal.ids))
    if (journal.steps[`${key}:cardCluster`] === 'verified') codes[id] = ['cc'];
  const rems = await readExact(
    backend,
    ids.filter((id) => !unknown.includes(id)),
    { tags: true, powerupCodes: codes }
  );
  for (let start = 0; start < unknown.length; start += 50) {
    const batch = unknown.slice(start, start + 50),
      probes = await backend.readProbe(batch, { powerupCodes: codes });
    if (
      probes.length !== batch.length ||
      new Set(probes.map((probe) => probe.snapshot.id)).size !== batch.length
    )
      throw new Error('Remote ID set changed after verified sync');
    for (const probe of probes) {
      const id = probe.snapshot.id;
      if (typeof id !== 'string' || !batch.includes(id))
        throw new Error('Unexpected recovery identity');
      for (const code of codes[id] ?? []) {
        const expected =
          baseline.get(id)!.powerupPresence?.[code] ??
          baseline.get(id)!.powerups?.some((powerup) => powerup.code === code);
        if (
          typeof probe.powerupPresence?.[code] !== 'boolean' ||
          probe.powerupPresence[code] !== expected
        )
          throw new Error(`Remote changed after verified sync: ${id}/${code}`);
      }
      rems.set(id, {
        ...withPublicSnapshot(baseline.get(id)!, probe.snapshot),
        tags: probe.tags,
        ...(probe.powerupPresence ? { powerupPresence: probe.powerupPresence } : {}),
      });
    }
  }
  for (const [id, rem] of rems) {
    const current =
      baseline.has(id) && !unknown.includes(id) ? withNativeSnapshot(baseline.get(id)!, rem) : rem;
    if (
      publicationRevisionHash(current) !== final.hashes[id] ||
      (codes[id] ?? []).some(
        (code) =>
          rem.powerupPresence?.[code] !==
          (baseline.get(id)?.powerupPresence?.[code] ??
            baseline.get(id)?.powerups?.some((powerup) => powerup.code === code) ??
            (Object.values(journal.ids).includes(id) && code === 'cc'))
      )
    )
      throw new Error(`Remote changed after verified sync: ${id}`);
    rems.set(id, current);
  }
  const roles = Object.values(journal.physicalBaseline ?? {}).find((value) => value.feedback)
    ?.feedback?.roles;
  await partitionRemote(
    rems,
    new Set([...baseline.keys(), ...Object.values(journal.ids)]),
    roles,
    backend
  );
  if (final.deleted.length && (await backend.existingIds(final.deleted)).length)
    throw new Error('Verified deletion no longer matches native state');
  return rems;
}
