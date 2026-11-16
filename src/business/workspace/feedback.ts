import { z } from 'zod';
import { idSchema, IDENTITY, workspaceIdentity } from './identity.js';
import { withWorkspaceLock, workspaceDirectory } from './files.js';
import { inspectLocal, localStore, prepareSnapshot } from './local.js';
import { requireNoPublication, stageSnapshot } from './publication.js';
import { feedbackRolesSchema, feedbackRevision, readAttachment } from './feedback-partition.js';
import { hash, type FeedbackRoles, type WorkspaceBackend, type WorkspaceRem } from './types.js';
import {
  finalProofHash,
  guardedBinding,
  publishedBaselineHash,
  publisherCursor,
  requireFinalProof,
  type Journal,
} from './resume.js';
import { nativeProof } from './outline.js';
import { publicationRevisionHash, withNativeSnapshot } from './snapshots.js';
import { registerTagIds } from './tags.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const captureSchema = z
  .object({
    kbId: z.string().min(1),
    directory: z.string(),
    id: idSchema,
    parentId: idSchema,
    revision: digest,
    roles: feedbackRolesSchema,
    targets: z.array(idSchema).min(1),
    path: z.string(),
    inputHash: digest,
    baselineHash: digest,
    executionCursor: z.number().int().nonnegative().safe(),
    evidence: z.array(
      z
        .object({
          id: idSchema,
          parent: idSchema,
          children: z.array(idSchema),
          text: z.array(z.json()),
        })
        .strict()
    ),
  })
  .strict();
const receiptSchema = z
  .object({
    version: z.literal(1),
    capture: captureSchema,
    captureHash: digest,
    steps: z
      .object({
        checkbox: z.enum(['started', 'verified', 'unknown']).optional(),
        done: z.enum(['started', 'verified', 'unknown']).optional(),
        todo: z.enum(['started', 'verified', 'unknown']).optional(),
      })
      .strict(),
    publication: z
      .object({ planHash: digest, proofHash: digest, fileHash: digest })
      .strict()
      .optional(),
    complete: z.boolean(),
  })
  .strict();
type Receipt = z.infer<typeof receiptSchema>;
type Factory = () => Promise<WorkspaceBackend>;

async function exact(backend: WorkspaceBackend, ids: string[]) {
  const values: WorkspaceRem[] = [];
  for (let offset = 0; offset < ids.length; offset += 50)
    values.push(...(await backend.read(ids.slice(offset, offset + 50), { tags: true })));
  if (
    values.length !== ids.length ||
    new Set(values.map((rem) => rem.id)).size !== ids.length ||
    values.some((rem) => !ids.includes(rem.id))
  )
    throw new Error('Incomplete exact feedback read');
  return new Map(values.map((rem) => [rem.id, rem]));
}
function rolesOf(value: FeedbackRoles | undefined): FeedbackRoles {
  if (!value) throw new Error('Explicit sync feedback bind is required');
  return feedbackRolesSchema.parse(value);
}

/** Explicit clean-source role alignment. Never imports absent native metadata or changes native tags. */
export async function bindFeedbackRoles(
  directory: string,
  backendFactory: Factory,
  roles: FeedbackRoles
) {
  roles = feedbackRolesSchema.parse(roles);
  const root = await workspaceDirectory(directory);
  return withWorkspaceLock(root, async () => {
    await requireNoPublication(root);
    const context = await inspectLocal(root),
      state = context.state;
    if (context.diagnostics.length || context.dirty.length || state.pending || !state.complete)
      throw new Error(
        'Feedback binding requires a clean complete sealed source with no pending writes'
      );
    if (state.feedbackRoles) {
      if (hash(state.feedbackRoles) !== hash(roles))
        throw new Error('Feedback roles are already bound to different IDs');
      return { status: 'bound', roles, remoteWrites: 0 };
    }
    if ([...context.native.values()].some((rem) => !Array.isArray(rem.tags)))
      throw new Error(
        'Missing initial direct-tag evidence; feedback binding cannot initialize native baselines'
      );
    const roleIds = [roles.todoTagId, roles.doneTagId];
    if (roleIds.some((id) => !context.native.has(id)))
      throw new Error('Roles require existing exact sealed native IDs');
    const tagIds = registerTagIds(context.native, roleIds, state.tagIds);
    const unaligned = [...context.parsed].filter(([, source]) =>
      source.nodes.some((node) => node.tags?.some((id) => roleIds.includes(id)))
    );
    if (unaligned.length)
      throw new Error(
        `Feedback role tokens require explicit source alignment before binding: ${unaligned.map(([path]) => path).join(', ')}`
      );
    const frozen = await context.inputs.freeze(),
      backend = await backendFactory();
    if ((await backend.identity()).kbId !== state.kbId) throw new Error('Feedback KB mismatch');
    const verified = await exact(backend, roleIds);
    for (const id of roleIds)
      if (
        publicationRevisionHash(withNativeSnapshot(context.native.get(id)!, verified.get(id)!)) !==
        publicationRevisionHash(context.native.get(id)!)
      )
        throw new Error('Feedback role identity changed since the sealed baseline');
    const native = [...context.native.values()].map((rem) => ({
      ...rem,
      feedback: { roles, attachmentIds: [] },
    }));
    const prepared = await prepareSnapshot(
      root,
      state.kbId,
      native,
      state,
      state,
      frozen,
      undefined,
      undefined,
      [],
      context.parsed
    );
    prepared.state.feedbackRoles = roles;
    prepared.state.tagIds = tagIds;
    for (const [path, doc] of Object.entries(state.documents)) {
      if (prepared.state.documents[path]?.fileHash !== doc.fileHash)
        throw new Error(
          `Feedback binding would change source bytes: ${path}; explicit source alignment required`
        );
      prepared.writes.delete(path);
    }
    prepared.writes.set(
      IDENTITY,
      JSON.stringify(workspaceIdentity(prepared.state), null, 2) + '\n'
    );
    await stageSnapshot(root, prepared.state, state, prepared.writes, frozen);
    const after = await inspectLocal(root);
    if (after.diagnostics.length || after.dirty.length)
      throw new Error('Feedback binding local readback failed');
    return { status: 'bound', roles, contentAuthority: 'local', remoteWrites: 0 };
  });
}

export async function captureFeedback(
  directory: string,
  backendFactory: Factory,
  id: string,
  targetIds: string[]
) {
  idSchema.parse(id);
  const targets = [...new Set(targetIds.map((target) => idSchema.parse(target)))].sort();
  if (!targets.length) throw new Error('Capture requires exact canonical targets');
  const root = await workspaceDirectory(directory);
  return withWorkspaceLock(root, async () => {
    await requireNoPublication(root);
    const context = await inspectLocal(root),
      state = context.state,
      roles = rolesOf(state.feedbackRoles);
    if (context.diagnostics.length || context.dirty.length || state.pending || !state.complete)
      throw new Error('Capture requires clean valid source and no pending publication');
    if (context.native.has(id))
      throw new Error(
        'Capture supports separate feedback attachments only; canonical TODO remains content'
      );
    if (targets.some((target) => !state.entries[target]))
      throw new Error('Targets must be bound canonical IDs');
    const paths = new Set(targets.map((target) => state.entries[target]!.path));
    if (paths.size !== 1)
      throw new Error('Targets must be bound canonical IDs in one exact local file');
    const path = [...paths][0]!,
      backend = await backendFactory();
    if ((await backend.identity()).kbId !== state.kbId) throw new Error('Feedback KB mismatch');
    const candidate = (await exact(backend, [id])).get(id)!;
    if (!candidate.parent || !context.native.has(candidate.parent))
      throw new Error('Feedback requires a direct bound canonical parent');
    const parent = (await exact(backend, [candidate.parent])).get(candidate.parent)!;
    if (
      parent.children.filter((child) => child === id).length !== 1 ||
      state.entries[parent.id]!.path !== path
    )
      throw new Error('Feedback parent/child or target-file ownership mismatch');
    const rems = await readAttachment(
      backend,
      id,
      parent.id,
      roles,
      new Set(context.native.keys())
    );
    if (!backend.feedbackFacts) throw new Error('Native feedback facts are unavailable');
    const facts = await backend.feedbackFacts(id);
    if (
      !facts.isTodo ||
      facts.status !== 'Unfinished' ||
      !rems[0]!.tags!.includes(roles.todoTagId) ||
      rems[0]!.tags!.includes(roles.doneTagId)
    )
      throw new Error(
        'Capture requires an observed unfinished native TODO with only the TODO lifecycle role'
      );
    for (const target of targets) {
      const targetFacts = await backend.feedbackFacts(target);
      if (
        !(facts.references.includes(target) && targetFacts.backlinks.includes(id)) &&
        !(targetFacts.references.includes(id) && facts.backlinks.includes(target))
      )
        throw new Error(
          'Capture requires an existing exact native reference and reciprocal backlink; a parent edge is not a reference'
        );
    }
    const capture = captureSchema.parse({
      kbId: state.kbId,
      directory: root,
      id,
      parentId: parent.id,
      revision: feedbackRevision(rems, roles),
      roles,
      targets,
      path,
      inputHash: context.parsed.get(path)!.fileHash,
      baselineHash: hash({ entries: state.entries, documents: state.documents }),
      executionCursor: await publisherCursor(localStore(state.kbId), root),
      evidence: rems.map((rem) => ({
        id: rem.id,
        parent: rem.parent,
        children: rem.children,
        text: rem.text,
      })),
    });
    const receipt = hash({ kbId: state.kbId, directory: root, id, revision: capture.revision });
    const store = localStore(state.kbId),
      key = `feedback:${receipt}`,
      prior = await store.getLocal<Receipt>(key);
    if (prior) {
      const saved = receiptSchema.parse(prior);
      if (
        saved.captureHash !== hash(saved.capture) ||
        hash(saved.capture.targets) !== hash(targets) ||
        saved.capture.path !== path
      )
        throw new Error(
          'Existing exact feedback revision has a different binding; preserve its receipt'
        );
      return {
        status: 'captured',
        receipt,
        revision: saved.capture.revision,
        feedback: saved.capture.evidence,
        remoteWrites: 0,
      };
    }
    await store.setLocal(key, {
      version: 1,
      capture,
      captureHash: hash(capture),
      steps: {},
      complete: false,
    } satisfies Receipt);
    return {
      status: 'captured',
      receipt,
      revision: capture.revision,
      feedback: capture.evidence,
      remoteWrites: 0,
    };
  });
}

/** Only acknowledgment is recoverable here: publication is never called or replayed. */
export async function acknowledgeFeedback(
  directory: string,
  backendFactory: Factory,
  receiptId: string,
  planHash: string
) {
  digest.parse(receiptId);
  digest.parse(planHash);
  const root = await workspaceDirectory(directory);
  return withWorkspaceLock(root, async () => {
    await requireNoPublication(root);
    const context = await inspectLocal(root),
      state = context.state,
      roles = rolesOf(state.feedbackRoles);
    const store = localStore(state.kbId),
      key = `feedback:${receiptId}`;
    const receipt = receiptSchema.parse(await store.getLocal(key)),
      capture = receipt.capture;
    if (
      receipt.captureHash !== hash(capture) ||
      capture.directory !== root ||
      capture.kbId !== state.kbId ||
      hash(capture.roles) !== hash(roles) ||
      receiptId !==
        hash({ kbId: state.kbId, directory: root, id: capture.id, revision: capture.revision })
    )
      throw new Error('Feedback receipt binding mismatch');
    if (
      state.pending ||
      !state.complete ||
      context.diagnostics.length ||
      context.dirty.includes(capture.path)
    )
      throw new Error(
        'Acknowledgment requires completed local publication and unchanged selected source'
      );
    const journal = await store.getLocal<Journal>(
      `workspace-v2:${state.kbId}:${hash(root)}:${planHash}`
    );
    if (!journal || journal.state !== 'verified' || journal.planHash !== planHash)
      throw new Error('Missing verified exact publisher journal');
    const final = requireFinalProof(journal),
      binding = guardedBinding(journal);
    if (
      !binding ||
      binding.path !== capture.path ||
      binding.fileHash === capture.inputHash ||
      journal.proof!.plan.baseHash !== capture.baselineHash ||
      !Number.isSafeInteger(journal.executionSequence) ||
      journal.executionSequence! <= capture.executionCursor ||
      journal.executionSequence! > (await publisherCursor(store, root)) ||
      publishedBaselineHash(journal, context.native) !== final.publishedBaselineHash ||
      capture.targets.some(
        (id) => !journal.selection.reconcileIds.includes(id) || !Object.hasOwn(final.hashes, id)
      )
    )
      throw new Error('Publisher proof does not cover the changed captured target source');
    const plan = journal.proof!.plan;
    const affected = (id: string) => {
      for (
        let current: string | null = id;
        current;
        current = context.native.get(current)?.parent ?? null
      )
        if (capture.targets.includes(current)) return true;
      return false;
    };
    if (
      !plan.changes.some(
        (change) =>
          affected(journal.ids[change.key] ?? change.key) &&
          (['text', 'backText'] as const).some(
            (field) =>
              change.fields[field] !== undefined &&
              journal.steps[`${change.key}:${field}`] === 'verified'
          )
      )
    )
      throw new Error('Unrelated or no-op publication cannot acknowledge feedback');
    const publication = {
      planHash,
      proofHash: finalProofHash(journal),
      fileHash: context.parsed.get(capture.path)!.fileHash,
    };
    if (receipt.publication && hash(receipt.publication) !== hash(publication))
      throw new Error('Acknowledgment is bound to a different publication');
    const frozen = await context.inputs.freeze(),
      backend = await backendFactory();
    const permissions = async () => {
      const live = await backend.identity();
      if (live.kbId !== state.kbId || !live.writable || !live.destructive)
        throw new Error(
          'All acknowledgment writes require explicit destructive authorization and both live write gates before the first mutation'
        );
    };
    await permissions();
    if (!backend.feedbackFacts || !backend.finishTodo)
      throw new Error('Native acknowledgment capabilities are unavailable');
    const checkProof = async () => {
      await requireNoPublication(root);
      await frozen.check();
      await permissions();
      const proofIds = Object.keys(final.hashes).filter(
        (id) =>
          affected(id) ||
          capture.targets.some((target) => context.native.get(target)?.parent === id)
      );
      const fresh = await exact(backend, proofIds);
      for (const id of proofIds) {
        const rem = withNativeSnapshot(context.native.get(id)!, fresh.get(id)!);
        const before =
            journal.proof!.nativeBefore[id] ??
            (Object.values(journal.ids).includes(id)
              ? nativeProof(context.native.get(id)!)
              : undefined),
          after = nativeProof(rem);
        if (
          !before ||
          before.reviewHash === null ||
          after.reviewHash === null ||
          hash(before) !== hash(after) ||
          publicationRevisionHash(rem) !== final.hashes[id]
        )
          throw new Error(
            'Target native content/card identity/observable history proof is missing or changed'
          );
      }
      for (const id of capture.targets) {
        const targetFacts = await backend.feedbackFacts!(id);
        const feedbackFacts = await backend.feedbackFacts!(capture.id);
        if (
          !(feedbackFacts.references.includes(id) && targetFacts.backlinks.includes(capture.id)) &&
          !(targetFacts.references.includes(capture.id) && feedbackFacts.backlinks.includes(id))
        )
          throw new Error('Exact native reference and reciprocal backlink proof is missing');
      }
      const parent = (await exact(backend, [capture.parentId])).get(capture.parentId)!;
      if (parent.children.filter((id) => id === capture.id).length !== 1)
        throw new Error('Feedback ownership changed');
      const rems = await readAttachment(
        backend,
        capture.id,
        capture.parentId,
        roles,
        new Set(context.native.keys())
      );
      if (feedbackRevision(rems, roles) !== capture.revision)
        throw new Error('Feedback revision changed; old receipt cannot acknowledge it');
      const facts = await backend.feedbackFacts!(capture.id);
      if (!facts.isTodo || facts.status === null) throw new Error('Unknown native checkbox state');
      return {
        status: facts.status,
        todo: rems[0]!.tags!.includes(roles.todoTagId),
        done: rems[0]!.tags!.includes(roles.doneTagId),
      };
    };
    const steps = ['checkbox', 'done', 'todo'] as const;
    const expected = (count: number) => ({
      status: count > 0 ? 'Finished' : 'Unfinished',
      todo: count < 3,
      done: count > 1,
    });
    let writes = 0;
    receipt.publication = publication;
    await store.setLocal(key, receipt);
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index]!,
        observed = await checkProof(),
        status = receipt.steps[step];
      const later = steps.slice(index + 1).some((key) => receipt.steps[key] !== undefined);
      if (status === 'verified') {
        if (!later && hash(observed) !== hash(expected(index + 1)))
          throw new Error('Acknowledged state changed concurrently');
        continue;
      }
      if (later) throw new Error('Malformed acknowledgment step prefix');
      if (status) {
        if (hash(observed) !== hash(expected(index + 1)))
          throw new Error(
            'Unknown acknowledgment effect: preserve receipt, never replay the uncertain atom'
          );
        receipt.steps[step] = 'verified';
        await store.setLocal(key, receipt);
        continue;
      }
      if (hash(observed) !== hash(expected(index)))
        throw new Error('Feedback lifecycle changed outside this acknowledgment');
      receipt.steps[step] = 'started';
      await store.setLocal(key, receipt);
      try {
        writes++;
        if (step === 'checkbox') await backend.finishTodo(capture.id);
        else if (step === 'done') await backend.addTag(capture.id, roles.doneTagId);
        else await backend.removeTag(capture.id, roles.todoTagId);
        if (hash(await checkProof()) !== hash(expected(index + 1)))
          throw new Error('Acknowledgment readback did not match the exact after-state');
        receipt.steps[step] = 'verified';
        await store.setLocal(key, receipt);
      } catch (error) {
        receipt.steps[step] = 'unknown';
        await store.setLocal(key, receipt);
        throw error;
      }
    }
    if (hash(await checkProof()) !== hash(expected(3)))
      throw new Error('Final acknowledgment readback failed');
    receipt.complete = true;
    await store.setLocal(key, receipt);
    return {
      status: 'acknowledged',
      receipt: receiptId,
      id: capture.id,
      planHash,
      remoteWrites: writes,
      publicationWrites: 0,
    };
  });
}
