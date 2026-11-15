import { isContentMarkdown, readPrivate, withWorkspaceLock, workspaceDirectory } from './files.js';
import { IDENTITY, shortBlockId, workspaceIdentity } from './identity.js';
import { inspectLocal, inspectNativeRecords, loadState } from './local.js';
import { pathKey, WorkspaceLinks } from './links.js';
import {
  documentMetadata,
  nodeKind,
  renderDocument,
  renderParsedDocument,
  titleOf,
} from './markdown.js';
import {
  metadataSchema,
  readMetadataYaml,
  type DocumentAttributes,
  type WorkspaceMetadata,
} from './metadata.js';
import { requireNoPublication, stageSnapshot } from './publication.js';
import { hash, type WorkspaceState } from './types.js';

/** Explicit offline conversion of a sealed legacy publication. Daily sync has no legacy source fallback. */
export async function formatWorkspace(directory: string) {
  const root = await workspaceDirectory(directory);
  return withWorkspaceLock(root, async () => {
    await requireNoPublication(root);
    const previous = await loadState(root);
    if (!previous.complete || previous.pending)
      throw new Error(
        'Format requires a complete baseline with no pending remote journal; reconcile its exact outcome first'
      );
    const input = await inspectNativeRecords(root, previous);
    if (input.diagnostics.length) throw new Error(`Format refused: ${input.diagnostics[0]!.code}`);
    if (input.inputs.paths.includes(IDENTITY)) {
      const local = await inspectLocal(root, previous, new Map(), input.inputs);
      if (local.diagnostics.length)
        throw new Error(`Format refused: ${local.diagnostics[0]!.code}`);
      return {
        status: 'already-formatted',
        complete: true,
        remoteWrites: 0,
        documents: local.parsed.size,
      };
    }
    const frozen = await input.inputs.freeze();
    const expected = new Map(Object.values(previous.documents).map((doc) => [doc.rootId, doc]));
    const paths = new Map<string, string>(),
      attributes = new Map<string, DocumentAttributes>();
    const folded = new Set<string>();
    for (const path of input.inputs.paths.filter(isContentMarkdown)) {
      if (folded.has(pathKey(path)))
        throw new Error('Format refuses ambiguous case/Unicode document paths');
      folded.add(pathKey(path));
      const source = await input.inputs.read(path);
      const yaml = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
      if (!yaml) throw new Error(`Format requires a sealed legacy YAML document: ${path}`);
      const metadata = metadataSchema.parse(readMetadataYaml(yaml[1]!));
      const old = expected.get(metadata.root);
      if (!old || paths.has(metadata.root) || old.fileHash !== hash(source))
        throw new Error(
          `Format refuses untracked, duplicated or locally edited source: ${path}; preserve and reconcile edits first`
        );
      if (
        hash(Object.keys(metadata.rems).sort()) !== hash([...old.nodeIds].sort()) ||
        Object.entries(metadata.rems).some(
          ([id, entry]) => entry.id !== id || entry.block !== previous.entries[id]?.blockId
        )
      )
        throw new Error(`Format refuses an inconsistent legacy identity: ${path}`);
      paths.set(metadata.root, path);
      attributes.set(metadata.root, {
        ...(metadata.title === undefined ? {} : { title: metadata.title }),
        ...(metadata.aliases.length ? { aliases: metadata.aliases } : {}),
        ...(metadata.tags.length ? { tags: metadata.tags } : {}),
      });
    }
    if (paths.size !== expected.size) throw new Error('Format refuses missing legacy documents');
    const blocks = new Map<string, string>(),
      used = new Set<string>();
    for (const id of Object.keys(previous.entries).sort()) {
      const block = shortBlockId(id, used);
      blocks.set(id, block);
      used.add(block);
    }
    const originalIds = new Set(
      Object.entries(previous.entries)
        .filter(([, entry]) => entry.originalHash)
        .map(([id]) => id)
    );
    const display = (id: string): Pick<WorkspaceMetadata, 'title' | 'aliases' | 'tags'> => ({
      ...attributes.get(id),
      aliases: attributes.get(id)?.aliases ?? [],
      tags: attributes.get(id)?.tags ?? [],
    });
    const links = new WorkspaceLinks(
      [...paths].map(([id, path]) => ({
        path,
        title: titleOf(input.native.get(id)!),
        metadata: documentMetadata(id, input.native, paths, {
          blocks,
          originalIds,
          display: display(id),
        }),
      }))
    );
    const next: WorkspaceState = { ...structuredClone(previous), documents: {} };
    const writes = new Map<string, string | null>();
    for (const [id, path] of paths) {
      const options = {
        blocks,
        originalIds,
        links,
        display: display(id),
        attributes: attributes.get(id),
      };
      const result = renderParsedDocument(id, path, input.native, paths, options);
      if (result.diagnostics.length)
        throw new Error(`Converted outline failed lint: ${result.diagnostics[0]!.code}`);
      const source = renderDocument(id, path, input.native, paths, options);
      next.documents[path] = {
        rootId: id,
        fileHash: hash(source),
        nodeIds: result.document.nodes
          .filter((node) => node.kind !== 'mount')
          .map((node) => node.key),
      };
      for (const key of next.documents[path]!.nodeIds)
        next.entries[key] = {
          ...next.entries[key]!,
          path,
          blockId: blocks.get(key)!,
          editable: nodeKind(input.native.get(key)!, input.native) !== 'opaque',
        };
      writes.set(path, source);
    }
    writes.set(IDENTITY, JSON.stringify(workspaceIdentity(next), null, 2) + '\n');
    await stageSnapshot(root, next, previous, writes, frozen);
    const verified = await inspectLocal(root);
    if (verified.diagnostics.length)
      throw new Error(`Converted publication readback failed: ${verified.diagnostics[0]!.code}`);
    if (
      hash(await loadState(root)) !== hash(next) ||
      hash(JSON.parse(await readPrivate(root, IDENTITY))) !== hash(workspaceIdentity(next))
    )
      throw new Error('Converted identity readback mismatch');
    return {
      status: 'formatted',
      complete: true,
      remoteWrites: 0,
      documents: paths.size,
      rems: Object.keys(next.entries).length,
      identityPath: IDENTITY,
      previousManifestHash: hash(previous),
      manifestHash: hash(next),
      originals: 'unchanged',
      recovery: 'Prior source inodes retained in private .sync/staging displacement records',
    };
  });
}
