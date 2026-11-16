import { insertBaselineTags } from './baseline-tags.js';
import { insertBaselineChildren, verifyNewChildren } from './baseline-children.js';
import { nativeSourceChanges, readNativeSourceClosure } from './baseline-source.js';
import { preserveSourceHeader } from './baseline-source-header.js';
import { readPrivate, withWorkspaceLock, workspaceDirectory } from './files.js';
import {
  IDENTITY,
  idSchema,
  originalPath,
  recordPath,
  shortBlockId,
  workspaceIdentity,
} from './identity.js';
import { inspectLocal, loadState, type LocalContext } from './local.js';
import { WorkspaceLinks } from './links.js';
import {
  bindPreparedDocument,
  documentMetadata,
  parsePreparedDocument,
  prepareDocument,
  nodeKind,
  renderDocument,
  titleOf,
} from './markdown.js';
import { knownPowerupCodes, nativeProof } from './outline.js';
import { requireNoPublication, stageSnapshot } from './publication.js';
import { mapReads } from './read-pool.js';
import { selectFiles } from './selection.js';
import { cardIdentities, contentProjection, immutableProjection } from './snapshots.js';
import { registerTagIds, renderTags, tagSet } from './tags.js';
import { hash, type OutlineNode, type WorkspaceBackend, type WorkspaceRem } from './types.js';

function sourceProjection(rem: WorkspaceRem) {
  const { facts: _facts, cards: _cards, ...structure } = immutableProjection(rem);
  return {
    ...structure,
    children: rem.children,
    references: rem.references ?? null,
    ...contentProjection(rem),
  };
}

/** Preserve the sealed record verbatim except for the explicitly missing observations. */
function alignRecord(before: WorkspaceRem, current: WorkspaceRem): WorkspaceRem {
  const next = structuredClone(before);
  if (!Array.isArray(current.tags)) throw new Error(`Unknown native tags: ${before.id}`);
  if (before.tags == null) next.tags = tagSet(current.tags);
  else if (hash(tagSet(before.tags)) !== hash(tagSet(current.tags)))
    throw new Error(`Known native tags drifted: ${before.id}`);
  if (before.portal && current.portal)
    for (const field of ['query', 'filter'] as const)
      if (before.portal[field] === undefined) {
        if (current.portal[field] !== null)
          throw new Error(`Missing portal ${field} is not verified null: ${before.id}`);
        next.portal![field] = null;
      }
  if (hash(sourceProjection(next)) !== hash(sourceProjection(current)))
    throw new Error(`Known native content or structure drifted: ${before.id}`);
  if (before.cards != null && hash(cardIdentities(before)) !== hash(cardIdentities(current)))
    throw new Error(`Known native Card identities drifted: ${before.id}`);
  for (const code of knownPowerupCodes(new Map([[before.id, before]]))[before.id]!) {
    const present = before.powerupPresence?.[code] ?? before.powerups?.some((p) => p.code === code);
    if (current.powerupPresence?.[code] !== present)
      throw new Error(`Known native Powerup was not verified: ${before.id}/${code}`);
  }
  return next;
}

async function readExact(backend: WorkspaceBackend, ids: string[], context: LocalContext) {
  const powerupCodes = knownPowerupCodes(context.native);
  const batches = Array.from({ length: Math.ceil(ids.length / 50) }, (_, index) =>
    ids.slice(index * 50, index * 50 + 50)
  );
  const reads = await mapReads(batches, 2, async (batch) => {
    const values = await backend.read(batch, {
      tags: true,
      powerupCodes,
    });
    if (
      values.length !== batch.length ||
      new Set(values.map((rem) => rem.id)).size !== batch.length ||
      values.some((rem) => !batch.includes(rem.id))
    )
      throw new Error('Incomplete or unexpected exact native read');
    return values;
  });
  return new Map(reads.flat().map((rem) => [rem.id, rem]));
}

function authored(node: OutlineNode) {
  const {
    tags: _tags,
    readonlyHash: _readonlyHash,
    contentHash: _contentHash,
    line: _line,
    ...rest
  } = node;
  return rest;
}

export async function alignWorkspaceBaseline(
  directory: string,
  connect: () => Promise<WorkspaceBackend>,
  options: {
    paths?: string[];
    apply?: boolean;
    planHash?: string;
    acceptNewParent?: string[];
    acceptNewChild?: string[];
    acceptNativeSource?: boolean;
  } = {}
) {
  if (options.apply && !/^[a-f0-9]{64}$/.test(options.planHash ?? ''))
    throw new Error('baseline-align --apply requires an exact --plan-hash');
  let addedIds = options.acceptNewChild ?? [];
  const parents = options.acceptNewParent ?? [];
  if (options.acceptNativeSource && (!options.paths?.length || parents.length || addedIds.length))
    throw new Error(
      'Native source adoption requires explicit exact --path files and cannot mix acceptance modes'
    );
  if (parents.length || addedIds.length) {
    if (
      !parents.length ||
      parents.some((id) => !idSchema.safeParse(id).success) ||
      new Set(parents).size !== parents.length ||
      !addedIds.length ||
      addedIds.some((id) => !idSchema.safeParse(id).success) ||
      new Set(addedIds).size !== addedIds.length
    )
      throw new Error(
        'Exact child acceptance requires unique parents and a nonempty unique new-child ID list'
      );
  }
  const root = await workspaceDirectory(directory);
  return withWorkspaceLock(root, async () => {
    await requireNoPublication(root);
    const previous = await loadState(root);
    if (!previous.complete || previous.pending)
      throw new Error(
        'Baseline alignment requires a complete baseline with no pending native journal'
      );
    if (previous.feedbackRoles && (options.acceptNativeSource || parents.length || addedIds.length))
      throw new Error('Native source adoption requires completion before feedback roles are bound');
    const context = await inspectLocal(root, previous);
    if (context.diagnostics.length)
      throw new Error(`Baseline alignment refused: ${context.diagnostics[0]!.code}`);
    if (context.dirty.length || context.missing.length)
      throw new Error('Baseline alignment refuses unpublished local source edits');
    if (
      options.acceptNativeSource &&
      options.paths!.some((path) => !Object.hasOwn(previous.documents, path))
    )
      throw new Error('Native source adoption requires exact bound file paths, never directories');
    const selection = await selectFiles(context, options.paths);
    if (!selection.files.length) throw new Error('Baseline alignment selected no bound documents');
    const ids = tagSet(selection.files.flatMap((path) => previous.documents[path]!.nodeIds));
    if (parents.some((id) => !ids.includes(id)))
      throw new Error('Exact new-child parent must be bound in the selected documents');
    const rejectPortalParents = (records: Map<string, WorkspaceRem>) => {
      for (const parent of parents) {
        const rem = records.get(parent)!;
        if (rem.type === 6 || rem.portal)
          throw new Error(`Exact new-child acceptance cannot traverse a Portal: ${parent}`);
      }
    };
    rejectPortalParents(context.native);
    for (const id of addedIds)
      if (context.native.has(id) || previous.entries[id])
        throw new Error(`New child is already bound: ${id}`);
    const frozen = await context.inputs.freeze();
    // The old native projection, never the source itself, establishes an absent readonly seal.
    for (const path of selection.files) {
      const baseline = new Map(context.baseline.get(path)!.nodes.map((node) => [node.key, node]));
      for (const node of context.parsed.get(path)!.nodes.filter((node) => node.kind === 'opaque'))
        if (
          node.readonlyHash !==
          (previous.entries[node.key]?.readonlyHash ?? baseline.get(node.key)?.readonlyHash)
        )
          throw new Error(
            `Unsealed readonly source differs from its native baseline: ${path}/${node.key}`
          );
    }
    const backend = await connect();
    if ((await backend.identity()).kbId !== previous.kbId)
      throw new Error('Native KB binding changed');
    const observed = await readExact(backend, ids, context);
    rejectPortalParents(observed);
    for (const [id, rem] of await readExact(backend, addedIds, context)) observed.set(id, rem);
    if (options.acceptNativeSource)
      addedIds = await readNativeSourceClosure(context, selection.files, observed, (newIds) =>
        readExact(backend, newIds, context)
      );
    if (parents.length && addedIds.some((id) => !parents.includes(observed.get(id)!.parent ?? '')))
      throw new Error('Every exact new child must belong to a selected parent');
    for (const parent of parents) {
      const children = addedIds.filter((id) => observed.get(id)!.parent === parent);
      if (!children.length) throw new Error(`Exact parent has no selected child: ${parent}`);
      verifyNewChildren(context.native.get(parent)!, observed.get(parent)!, children, observed);
    }
    const neededTags = tagSet([...observed.values()].flatMap((rem) => rem.tags ?? []));
    const dependencies = new Set<string>();
    for (const tag of neededTags) {
      const seen = new Set<string>();
      for (let id: string | null = tag; id;) {
        if (seen.has(id) || !context.native.has(id))
          throw new Error(`Unbound or cyclic tag ancestor: ${id}`);
        seen.add(id);
        if (!observed.has(id)) dependencies.add(id);
        id = context.native.get(id)!.parent;
      }
    }
    for (const [id, rem] of await readExact(backend, [...dependencies].sort(), context))
      observed.set(id, rem);
    const nextNative = new Map(context.native);
    for (const [id, current] of observed) {
      if (addedIds.includes(id)) {
        nextNative.set(id, structuredClone(current));
        continue;
      }
      const before = context.native.get(id)!;
      // The SDK does not always collect this supplemental relationship list.
      // Preserve an old known observation when absent; inline references are in text/backText.
      const sourceCurrent =
        (options.acceptNativeSource || parents.length > 0) &&
        ids.includes(id) &&
        current.references == null
          ? { ...current, references: before.references }
          : current;
      const next = alignRecord(
        options.acceptNativeSource && ids.includes(id)
          ? {
              ...before,
              text: current.text,
              backText: current.backText,
              children: current.children,
              tags: current.tags,
              references: sourceCurrent.references,
            }
          : parents.includes(id)
            ? { ...before, children: current.children }
            : before,
        sourceCurrent
      );
      if (ids.includes(id)) nextNative.set(id, next);
    }
    for (const parent of parents)
      if (
        nodeKind(context.native.get(parent)!, context.native) !==
        nodeKind(nextNative.get(parent)!, nextNative)
      )
        throw new Error('Exact new children would change the existing parent content kind');
    if (options.acceptNativeSource)
      for (const id of ids)
        if (
          nodeKind(context.native.get(id)!, context.native) !==
          nodeKind(nextNative.get(id)!, nextNative)
        )
          throw new Error(`Native source adoption cannot change an existing content kind: ${id}`);
    const next = structuredClone(previous);
    next.tagIds = registerTagIds(nextNative, neededTags, previous.tagIds);
    const paths = new Map(
      Object.entries(previous.documents).map(([path, doc]) => [doc.rootId, path])
    );
    const blocks = new Map(
      Object.entries(previous.entries).map(([id, entry]) => [id, entry.blockId])
    );
    const usedBlocks = new Set(blocks.values());
    for (const id of addedIds) {
      const block = shortBlockId(id, usedBlocks);
      blocks.set(id, block);
      usedBlocks.add(block);
    }
    const originalIds = new Set(
      Object.entries(previous.entries)
        .filter(([, entry]) => entry.originalHash)
        .map(([id]) => id)
    );
    const metadata = (id: string) => {
      const { title, aliases, tags } = context.parsed.get(paths.get(id)!)!.metadata!;
      return documentMetadata(id, nextNative, paths, {
        blocks,
        originalIds,
        display: { title, aliases, tags },
      });
    };
    const links = new WorkspaceLinks(
      [...paths].map(([id, path]) => ({
        path,
        metadata: metadata(id),
        title: context.parsed.get(path)!.metadata!.title ?? titleOf(nextNative.get(id)!),
      }))
    );
    const oldLinks = new WorkspaceLinks(
      [...paths].map(([id, path]) => ({
        path,
        metadata: documentMetadata(id, context.native, paths, {
          blocks,
          originalIds,
          display: context.parsed.get(path)!.metadata!,
        }),
        title: context.parsed.get(path)!.metadata!.title ?? titleOf(context.native.get(id)!),
      }))
    );
    const writes = new Map<string, string | null>();
    let tagsAligned = 0,
      portalFieldsAligned = 0,
      sealsAligned = 0;
    for (const path of selection.files) {
      const before = context.parsed.get(path)!;
      const rootId = previous.documents[path]!.rootId;
      let rootTags: string[] = [];
      const blockTags = new Map<string, string[]>();
      for (const node of before.nodes.filter((node) => node.kind !== 'mount')) {
        const original = context.native.get(node.key)!;
        const rem = nextNative.get(node.key)!;
        if (original.tags == null) {
          tagsAligned++;
          if (
            !options.acceptNativeSource &&
            node.tags?.length &&
            hash(tagSet(node.tags)) !== hash(tagSet(rem.tags!))
          )
            throw new Error(
              `Existing local tags disagree with native observation: ${path}/${node.key}`
            );
          if (!node.tags?.length && rem.tags!.length) {
            const tags = renderTags(rem.tags, next.tagIds);
            if (node.key === rootId) rootTags = tags;
            else blockTags.set(node.blockId, tags);
          }
        }
        for (const field of ['query', 'filter'] as const)
          if (
            original.portal &&
            original.portal[field] === undefined &&
            rem.portal?.[field] === null
          )
            portalFieldsAligned++;
      }
      const source = await context.inputs.read(path);
      if (options.acceptNativeSource) {
        const oldRendered = renderDocument(rootId, path, context.native, paths, {
          blocks,
          tagIds: previous.tagIds,
          links: oldLinks,
          attributes: before.attributes,
          source: before,
        });
        if (preserveSourceHeader(path, source, oldRendered, before.metadata?.tags ?? []) !== source)
          throw new Error(
            `Cannot preserve existing local source bytes during native adoption: ${path}`
          );
      }
      let content = options.acceptNativeSource
        ? renderDocument(rootId, path, nextNative, paths, {
            blocks,
            tagIds: next.tagIds,
            links,
            attributes: before.attributes,
            source: before,
          })
        : insertBaselineTags(path, source, rootTags, blockTags);
      if (options.acceptNativeSource)
        content = preserveSourceHeader(
          path,
          source,
          content,
          renderTags(nextNative.get(rootId)!.tags ?? [], next.tagIds)
        );
      const pathParents = parents.filter((parent) => previous.entries[parent]!.path === path);
      const pathAdded = addedIds.filter((id) =>
        pathParents.includes(observed.get(id)!.parent ?? '')
      );
      const accepting = pathParents.length > 0;
      let renderedNodes = new Map<string, OutlineNode>();
      if (accepting) {
        const rendered = renderDocument(rootId, path, nextNative, paths, {
          blocks,
          tagIds: next.tagIds,
          links,
        });
        const canonical = parsePreparedDocument(
          bindPreparedDocument(prepareDocument(path, rendered), metadata(rootId)),
          links,
          next.tagIds,
          nextNative
        );
        if (canonical.diagnostics.length)
          throw new Error(`New children have no supported source projection: ${path}`);
        renderedNodes = new Map(canonical.document.nodes.map((node) => [node.key, node]));
        for (const parent of pathParents)
          content = insertBaselineChildren(
            path,
            content,
            rendered,
            { block: blocks.get(parent)!, root: parent === rootId },
            nextNative.get(parent)!.children.map((id) => blocks.get(id)!),
            new Set(pathAdded.map((id) => blocks.get(id)!))
          );
      }
      const parsed = parsePreparedDocument(
        bindPreparedDocument(prepareDocument(path, content), metadata(rootId)),
        links,
        next.tagIds,
        nextNative
      );
      if (options.acceptNativeSource) {
        const afterNodes = new Map(parsed.document.nodes.map((node) => [node.key, node]));
        for (const node of before.nodes) {
          const oldRem = context.native.get(node.key);
          const newRem = nextNative.get(node.key);
          const changed = oldRem && newRem && nativeSourceChanges(oldRem, newRem).fields;
          const ownChanged =
            changed?.some((field) => field !== 'children') ||
            (oldRem?.tags == null && newRem?.tags?.length);
          if (!ownChanged && node.contentHash !== afterNodes.get(node.key)?.contentHash)
            throw new Error(
              `Cannot preserve unchanged source content during native adoption: ${path}/${node.key}`
            );
        }
      }
      if (
        parsed.diagnostics.length ||
        (!options.acceptNativeSource &&
          hash(
            before.nodes.map((node) =>
              authored(
                parents.includes(node.key)
                  ? { ...node, children: nextNative.get(node.key)!.children }
                  : node
              )
            )
          ) !==
            hash(
              parsed.document.nodes.filter((node) => !addedIds.includes(node.key)).map(authored)
            )) ||
        (accepting &&
          pathAdded.some(
            (id) =>
              hash(authored(renderedNodes.get(id)!)) !==
              hash(authored(parsed.document.nodes.find((node) => node.key === id)!))
          ))
      )
        throw new Error(
          `Baseline alignment changed existing authored content or structure: ${path}`
        );
      const parsedNodes = new Map(
        parsed.document.nodes
          .filter((node) => node.kind !== 'mount')
          .map((node) => [node.key, node])
      );
      next.documents[path]!.nodeIds = parsed.document.nodes
        .filter((node) => node.kind !== 'mount')
        .map((node) => node.key);
      for (const id of next.documents[path]!.nodeIds) {
        const rem = nextNative.get(id)!;
        const node = parsedNodes.get(id)!;
        if (!node || hash(tagSet(node.tags ?? [])) !== hash(tagSet(rem.tags ?? [])))
          throw new Error(`Native tags have no exact source projection: ${path}/${id}`);
        if (addedIds.includes(id)) {
          const rawPath = recordPath(id);
          if (
            Object.hasOwn(frozen.hashes(), rawPath) ||
            Object.hasOwn(frozen.hashes(), originalPath('public', id))
          )
            throw new Error(`Unbound child would overwrite existing private evidence: ${id}`);
          const raw = JSON.stringify(rem, null, 2) + '\n';
          writes.set(rawPath, raw);
          next.entries[id] = {
            path,
            blockId: blocks.get(id)!,
            rawPath,
            rawHash: hash(raw),
            nativeHash: hash(rem),
            editable: node.kind !== 'opaque',
          };
          if (rem.public) {
            const publicText = JSON.stringify(rem.public, null, 2) + '\n';
            writes.set(originalPath('public', id), publicText);
            next.entries[id]!.publicHash = hash(publicText);
          }
        }
        const entry = next.entries[id]!;
        if (hash(rem) !== entry.nativeHash) {
          const raw = JSON.stringify(rem, null, 2) + '\n';
          writes.set(entry.rawPath, raw);
          entry.rawHash = hash(raw);
          entry.nativeHash = hash(rem);
        }
        if (node.kind === 'opaque') {
          if (entry.readonlyHash === undefined) sealsAligned++;
          entry.readonlyHash = node.readonlyHash!;
        }
      }
      if (source !== content) writes.set(path, content);
      next.documents[path]!.fileHash = hash(content);
    }
    if (hash(workspaceIdentity(previous)) !== hash(workspaceIdentity(next)))
      writes.set(IDENTITY, JSON.stringify(workspaceIdentity(next), null, 2) + '\n');
    const proof = (values: Map<string, WorkspaceRem>) =>
      Object.fromEntries(
        [...values]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, rem]) => [
            id,
            {
              source: sourceProjection(rem),
              tags: rem.tags,
              powerupPresence: rem.powerupPresence,
              ...nativeProof(rem),
              ...(addedIds.includes(id) || options.acceptNativeSource
                ? { acceptedRecordHash: hash(rem) }
                : {}),
            },
          ])
      );
    const nativeBefore = proof(observed);
    const sourceChanges = options.acceptNativeSource
      ? ids
          .map((id) => ({
            ...nativeSourceChanges(context.native.get(id)!, observed.get(id)!),
            path: previous.entries[id]!.path,
          }))
          .filter((change) => change.fields.length)
      : [];
    const planHash = hash({
      previous,
      files: frozen.hashes(),
      selection,
      acceptedChildren: { parents, ids: addedIds },
      acceptNativeSource: options.acceptNativeSource === true,
      nativeBefore,
      next,
      writes: [...writes],
    });
    const result = {
      ok: true,
      status: options.apply ? 'aligned' : 'preview',
      planHash,
      remoteWrites: 0,
      files: selection.files,
      boundIds: ids.length,
      verificationIds: observed.size,
      tagsAligned,
      portalFieldsAligned,
      sealsAligned,
      childrenAccepted: addedIds.length,
      sourceFilesAccepted: options.acceptNativeSource ? selection.files.length : 0,
      sourceChangedIds: sourceChanges.map((change) => change.id),
      sourceChanges,
      newIds: addedIds,
      localFilesChanged: writes.size,
      nativeProofHash: hash(nativeBefore),
      documentIdentityHash: hash(workspaceIdentity(next).documents),
      observedHistoryKnown: [...observed.values()].filter(
        (rem) => nativeProof(rem).reviewHash !== null
      ).length,
    };
    if (!options.apply) {
      await frozen.check();
      return result;
    }
    if (options.planHash !== planHash)
      throw new Error('Baseline alignment preview changed; review a fresh plan hash');
    const verified = await readExact(
      backend,
      [...observed.keys()].filter((id) => !parents.length || !addedIds.includes(id)).sort(),
      context
    );
    rejectPortalParents(verified);
    if (parents.length)
      for (const [id, rem] of await readExact(backend, addedIds, context)) verified.set(id, rem);
    if (hash(proof(verified)) !== hash(nativeBefore))
      throw new Error('Native observations changed before baseline publication');
    await frozen.check();
    if (hash(next) !== hash(previous) || writes.size)
      await stageSnapshot(root, next, previous, writes, frozen);
    const actual = await inspectLocal(root);
    if (actual.diagnostics.length || actual.dirty.length || hash(actual.state) !== hash(next))
      throw new Error('Baseline publication readback failed; preserve the local recovery ledger');
    for (const [path, content] of writes)
      if (hash(await readPrivate(root, path)) !== hash(content))
        throw new Error(`Baseline source readback failed: ${path}`);
    return result;
  });
}
