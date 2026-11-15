import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { connectionConfigPath } from '../../remnote-cli/client/connection-config.js';
import { LocalState } from '../../remnote-cli/client/local-state.js';
import {
  allFiles,
  assertFileSize,
  isContentMarkdown,
  MAX_METADATA_BYTES,
  OFFICIAL_MANIFEST,
  readPrivate,
  STATE,
  writePrivate,
} from './files.js';
import { FrozenFiles } from './frozen-files.js';
import { stageSnapshot } from './publication.js';
import {
  documentMetadata,
  bindPreparedDocument,
  nodeKind,
  parsePreparedDocument,
  prepareDocument,
  preparedTitle,
  pathSegment,
  renderDocument,
  renderParsedDocument,
  titleOf,
  type PreparedDocument,
} from './markdown.js';
import {
  blockSchema,
  idSchema,
  keySchema,
  IDENTITY,
  identitySchema,
  shortBlockId,
  workspaceIdentity,
  originalPath,
  recordPath,
} from './identity.js';
import { remoteVersion } from './versions.js';
import { cardMetadataSchema, nativeDetailsSchema, nativeSchema } from './metadata.js';
import { mapReads } from './read-pool.js';
import { pathKey, WorkspaceLinks } from './links.js';
import {
  hash,
  type Diagnostic,
  type ParsedDocument,
  type ParsedOutline,
  type WorkspaceRem,
  type WorkspaceState,
} from './types.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const contentVersionSchema = z
  .object({
    contentHash: digest,
    timestamp: z.number().nullable(),
    source: z.enum(['cli-save', 'rem-updated-at']),
  })
  .strict();
const remSchema = z
  .object({
    id: idSchema,
    parent: idSchema.nullable(),
    children: z.array(idSchema),
    type: z.union([z.number().int(), z.string()]).nullable(),
    text: z.unknown(),
    backText: z.unknown(),
    document: z.boolean().nullable(),
    folder: z.boolean().nullable(),
    cardItem: z.boolean().nullable(),
    practice: z.enum(['forward', 'backward', 'both', 'none']).nullable(),
    enablePractice: z.boolean().nullable(),
    unsupported: z.string().optional(),
    public: z.record(z.string(), z.unknown()).optional(),
    tags: z.array(idSchema).nullable().optional(),
    references: z.array(idSchema).nullable().optional(),
    powerups: nativeSchema.shape.powerups.optional(),
    propertyValues: nativeSchema.shape.propertyValues.optional(),
    portal: z
      .object({ type: z.json().nullable(), directlyIncludedRemIds: z.array(idSchema).nullable() })
      .strict()
      .nullable()
      .optional(),
    cards: z.array(cardMetadataSchema).nullable().optional(),
    facts: nativeDetailsSchema.partial().optional(),
    collected: z.array(z.string()).optional(),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    directory: z.string(),
    kbId: z.string().min(1),
    snapshotAt: z.string(),
    complete: z.boolean(),
    scope: z.enum(['library', 'subtree']),
    rootIds: z.array(idSchema),
    globalDiscoveryComplete: z.boolean(),
    official: z
      .object({
        archiveSha256: digest,
        exportDate: z.string(),
        manifestPath: z.literal(OFFICIAL_MANIFEST),
        manifestHash: digest,
        remCount: z.number().int(),
        cardCount: z.number().int(),
      })
      .strict()
      .optional(),
    errors: z.array(z.string()),
    entries: z.record(
      idSchema,
      z
        .object({
          path: z.string(),
          blockId: blockSchema,
          rawPath: z.string(),
          rawHash: digest,
          nativeHash: digest,
          editable: z.boolean(),
          publicHash: digest.optional(),
          originalHash: digest.optional(),
        })
        .strict()
    ),
    documents: z.record(
      z.string(),
      z.object({ rootId: idSchema, fileHash: digest, nodeIds: z.array(idSchema) }).strict()
    ),
    localVersions: z
      .record(keySchema, contentVersionSchema.extend({ source: z.literal('cli-save') }))
      .optional(),
    remoteVersions: z
      .record(
        idSchema,
        contentVersionSchema.extend({
          source: z.literal('rem-updated-at'),
          sinceBaseline: z.literal(true).optional(),
        })
      )
      .optional(),
    pending: z.object({ planHash: digest, journalKey: z.string() }).strict().optional(),
  })
  .strict();

export function localStore(kbId: string): LocalState {
  return new LocalState(
    join(dirname(connectionConfigPath()), 'state', createHash('sha256').update(kbId).digest('hex'))
  );
}

export function publicationStore(): LocalState {
  return new LocalState(
    join(dirname(connectionConfigPath()), 'sync-publications'),
    MAX_METADATA_BYTES
  );
}

function manifestStore(): LocalState {
  return new LocalState(
    join(dirname(connectionConfigPath()), 'sync-manifests'),
    MAX_METADATA_BYTES
  );
}
export async function authoritativeState(root: string): Promise<WorkspaceState> {
  const value = await manifestStore().getLocal<WorkspaceState>(`manifest:${hash(root)}`);
  if (!value)
    throw Object.assign(new Error('No sync manifest for this directory'), { code: 'ENOENT' });
  const state = stateSchema.parse(value) as WorkspaceState;
  if (state.directory !== root) throw new Error('Workspace directory binding changed');
  return state;
}

export async function loadState(root: string): Promise<WorkspaceState> {
  const state = await authoritativeState(root);
  if (hash(JSON.parse(await readPrivate(root, STATE))) !== hash(state))
    throw new Error(
      'Workspace metadata mirror integrity mismatch; sync recover restores its authoritative CLI metadata'
    );
  return state;
}

export function serializeState(state: WorkspaceState): string {
  stateSchema.parse(state);
  const content = JSON.stringify(state, null, 2) + '\n';
  assertFileSize(STATE, content);
  return content;
}

export async function saveState(root: string, state: WorkspaceState): Promise<void> {
  const content = serializeState(state);
  // One atomic private record is authoritative. The in-directory mirror is never a second authority.
  await manifestStore().setLocal(`manifest:${hash(root)}`, state);
  await writePrivate(root, STATE, content);
}

export function validateGraph(rems: WorkspaceRem[], rootIds: string[] = []): string[] {
  rems.forEach((rem) => remSchema.parse(rem));
  const byId = new Map(rems.map((rem) => [rem.id, rem])),
    errors: string[] = [];
  if (byId.size !== rems.length) errors.push('Duplicate native IDs');
  for (const id of rootIds) {
    if (!byId.has(id)) errors.push(`Missing scope root ${id}`);
    else if (byId.get(id)!.parent && byId.has(byId.get(id)!.parent!))
      errors.push(`Scope roots must not overlap: ${id}`);
  }
  for (const rem of rems) {
    if (new Set(rem.children).size !== rem.children.length)
      errors.push(`Duplicate child IDs on ${rem.id}`);
    if (rem.parent !== null && !byId.has(rem.parent) && !rootIds.includes(rem.id))
      errors.push(`Missing parent ${rem.parent} for ${rem.id}`);
    if (rootIds.length && rem.parent === null && !rootIds.includes(rem.id))
      errors.push(`Unexpected root outside declared scope: ${rem.id}`);
    for (const child of rem.children)
      if (!byId.has(child) || byId.get(child)!.parent !== rem.id)
        errors.push(`Missing/disagreeing child ${rem.id}/${child}`);
    if (
      rem.parent !== null &&
      byId.has(rem.parent) &&
      !byId.get(rem.parent)!.children.includes(rem.id)
    )
      errors.push(`Parent omits child ${rem.id}`);
    const seen = new Set<string>();
    let current: WorkspaceRem | undefined = rem;
    while (current) {
      if (seen.has(current.id)) {
        errors.push(`Parent cycle at ${current.id}`);
        break;
      }
      seen.add(current.id);
      current = current.parent ? byId.get(current.parent) : undefined;
    }
  }
  return [...new Set(errors)];
}

export function documentPaths(
  rems: WorkspaceRem[],
  previous?: WorkspaceState,
  rootIds: string[] = []
): Map<string, string> {
  const byId = new Map(rems.map((rem) => [rem.id, rem])),
    boundaries = new Set(
      rems
        .filter(
          (rem) => rootIds.includes(rem.id) || rem.parent === null || rem.document || rem.folder
        )
        .map((rem) => rem.id)
    );
  const result = new Map<string, string>(),
    used = new Set<string>();
  for (const [path, document] of Object.entries(previous?.documents ?? {}))
    if (boundaries.has(document.rootId)) {
      result.set(document.rootId, path);
      used.add(pathKey(path));
    }
  function pathFor(id: string): string {
    if (result.has(id)) return result.get(id)!;
    const rem = byId.get(id)!;
    let parent = rem.parent ? byId.get(rem.parent) : undefined;
    while (parent && !boundaries.has(parent.id))
      parent = parent.parent ? byId.get(parent.parent) : undefined;
    const parentPath = parent ? pathFor(parent.id) : '';
    const base = parent
      ? `${parent.folder ? dirname(parentPath) : parentPath.replace(/\.md$/i, '')}/`
      : '';
    const name = pathSegment(rem).replace(/\.md$/i, '') || 'Untitled';
    const layout = (stem: string) =>
      rem.folder ? `${base}${stem}/${stem}.md` : `${base}${stem}.md`;
    let path = layout(name);
    if (used.has(pathKey(path))) path = layout(`${name}~${Buffer.from(id).toString('hex')}`);
    if (path.length > 2000) throw new Error('Native document path exceeds safe filesystem bounds');
    used.add(pathKey(path));
    result.set(id, path);
    return path;
  }
  [...boundaries].sort().forEach(pathFor);
  return result;
}

/** Only caller-checked clean files may be replaced. Raw objects are retained separately, never rendered lossily. */
export async function writeSnapshot(
  root: string,
  kbId: string,
  rems: WorkspaceRem[],
  previous?: WorkspaceState,
  coverage: Pick<WorkspaceState, 'scope' | 'rootIds' | 'globalDiscoveryComplete'> = previous ?? {
    scope: 'library',
    rootIds: [],
    globalDiscoveryComplete: true,
  },
  frozen?: FrozenFiles,
  originals: Map<string, string> = new Map(),
  official: WorkspaceState['official'] = previous?.official,
  removedIds: string[] = [],
  sources: Map<string, ParsedDocument> = new Map(),
  assignedIds: Record<string, string> = {}
): Promise<WorkspaceState> {
  const errors = validateGraph(rems, coverage.rootIds);
  if (errors.length) throw new Error(`Incomplete native graph: ${errors.slice(0, 10).join('; ')}`);
  const byId = new Map(rems.map((rem) => [rem.id, rem]));
  const renamed = previous ? { ...previous, documents: { ...previous.documents } } : undefined;
  for (const [path, source] of sources) {
    const old = Object.entries(renamed?.documents ?? {}).find(
      ([, doc]) => doc.rootId === source.metadata?.root
    );
    if (old && old[0] !== path) {
      delete renamed!.documents[old[0]];
      renamed!.documents[path] = old[1];
    }
  }
  const paths = documentPaths(rems, renamed, coverage.rootIds);
  const blocks = new Map(
    Object.entries(previous?.entries ?? {}).map(([id, entry]) => [id, entry.blockId])
  );
  for (const source of sources.values())
    for (const node of source.nodes)
      if (node.kind !== 'mount') blocks.set(assignedIds[node.key] ?? node.key, node.blockId);
  const usedBlocks = new Set(blocks.values());
  for (const id of byId.keys())
    if (!blocks.has(id)) {
      const block = shortBlockId(id, usedBlocks);
      blocks.set(id, block);
      usedBlocks.add(block);
    }
  const originalIds = new Set(
    Object.entries(previous?.entries ?? {})
      .filter(([, entry]) => entry.originalHash)
      .map(([id]) => id)
  );
  for (const id of byId.keys()) if (originals.has(originalPath('rems', id))) originalIds.add(id);
  const displays = new Map(
    [...sources.values()]
      .filter((source) => source.metadata)
      .map((source) => {
        const { root, title, aliases, tags } = source.metadata!;
        return [root, { ...(title === undefined ? {} : { title }), aliases, tags }];
      })
  );
  const attributes = new Map(
    [...sources.values()]
      .filter((source) => source.metadata)
      .map((source) => [source.metadata!.root, source.attributes ?? {}])
  );
  const links = new WorkspaceLinks(
    [...paths].map(([id, path]) => ({
      path,
      title: titleOf(byId.get(id)!),
      metadata: documentMetadata(id, byId, paths, {
        blocks,
        display: displays.get(id),
        originalIds,
      }),
    }))
  );
  const files = frozen ?? (await FrozenFiles.capture(root));
  await files.check();
  const state: WorkspaceState = {
    version: 1,
    directory: root,
    kbId,
    snapshotAt: new Date().toISOString(),
    complete: false,
    scope: coverage.scope,
    rootIds: coverage.rootIds,
    globalDiscoveryComplete: coverage.globalDiscoveryComplete,
    ...(official ? { official } : {}),
    errors: ['Snapshot write in progress'],
    entries: {},
    documents: {},
    localVersions: {},
    remoteVersions: Object.fromEntries(
      rems.map((rem) => [rem.id, remoteVersion(rem, previous?.remoteVersions?.[rem.id])])
    ),
  };
  const writes = new Map<string, string | null>(originals);
  for (const [id, path] of paths) {
    const options = {
      blocks,
      display: displays.get(id),
      attributes: attributes.get(id),
      originalIds,
      links,
    };
    const parsed = renderParsedDocument(id, path, byId, paths, options);
    if (parsed.diagnostics.length)
      throw new Error(`Generated outline failed its own lint: ${parsed.diagnostics[0]!.code}`);
    const current = sources.get(path);
    const semantic = (document: ParsedOutline) =>
      hash({
        metadata: document.metadata,
        nodes: document.nodes.map((node) => ({
          key: node.key,
          block: node.blockId,
          kind: node.kind,
          parent: node.parent,
          children: node.children,
          text: node.text,
          backText: node.backText,
          ...(node.kind === 'opaque' ? { projection: node.contentHash } : {}),
        })),
      });
    const content =
      current && semantic(current) === semantic(parsed.document)
        ? await readPrivate(root, path)
        : renderDocument(id, path, byId, paths, options);
    state.documents[path] = {
      rootId: id,
      fileHash: hash(content),
      nodeIds: parsed.document.nodes
        .filter((node) => node.kind !== 'mount')
        .map((node) => node.key),
    };
    for (const key of state.documents[path]!.nodeIds) {
      const rem = byId.get(key)!;
      const rawPath = recordPath(key),
        raw = JSON.stringify(rem, null, 2) + '\n';
      writes.set(rawPath, raw);
      state.entries[key] = {
        path,
        blockId: blocks.get(key)!,
        rawPath,
        rawHash: hash(raw),
        nativeHash: hash(rem),
        editable: nodeKind(rem, byId) !== 'opaque',
      };
      if (rem.public) {
        const publicPath = originalPath('public', key);
        const oldHash = previous?.entries[key]?.publicHash;
        const publicText = oldHash
          ? undefined
          : (originals.get(publicPath) ?? JSON.stringify(rem.public, null, 2) + '\n');
        if (publicText !== undefined) writes.set(publicPath, publicText);
        state.entries[key]!.publicHash = oldHash ?? hash(publicText!);
      }
      if (originalIds.has(key))
        state.entries[key]!.originalHash =
          previous?.entries[key]?.originalHash ?? hash(originals.get(originalPath('rems', key))!);
    }
    writes.set(path, content);
  }
  if (Object.keys(state.entries).length !== rems.length)
    throw new Error('Outline did not cover every enumerated Rem');
  state.complete = true;
  state.errors = [];
  writes.set(IDENTITY, JSON.stringify(workspaceIdentity(state), null, 2) + '\n');
  for (const id of removedIds)
    if (previous?.entries[id]) writes.set(previous.entries[id]!.rawPath, null);
  const frozenHashes = files.hashes();
  for (const [path, content] of writes)
    if (content !== null && frozenHashes[path] === hash(content)) writes.delete(path);
  await stageSnapshot(root, state, previous, writes, files);
  return state;
}

export interface LocalContext {
  inputs: InspectionInputs;
  state: WorkspaceState;
  native: Map<string, WorkspaceRem>;
  parsed: Map<string, ParsedDocument>;
  baseline: Map<string, ParsedOutline>;
  diagnostics: Diagnostic[];
  dirty: string[];
  missing: string[];
}

/** One operation's bytes/ASTs only. Every write boundary still rereads through FrozenFiles. */
export class InspectionInputs {
  private readonly reads = new Map<string, Promise<string>>();
  private readonly documents = new Map<string, { source: string; prepared: PreparedDocument }>();
  private constructor(
    private readonly root: string,
    readonly paths: string[]
  ) {}
  static async scan(root: string): Promise<InspectionInputs> {
    return new InspectionInputs(root, await allFiles(root));
  }
  read = (path: string): Promise<string> => {
    if (!this.reads.has(path)) this.reads.set(path, readPrivate(this.root, path));
    return this.reads.get(path)!;
  };
  prepare(path: string, source: string): PreparedDocument {
    const before = this.documents.get(path);
    if (before?.source === source) return before.prepared;
    const prepared = prepareDocument(path, source);
    this.documents.set(path, { source, prepared });
    return prepared;
  }
  freeze(): Promise<FrozenFiles> {
    return FrozenFiles.capture(this.root, this.paths, this.read);
  }
}

/** One shared offline verification of every native/original record; format and sync use the same guards. */
export async function inspectNativeRecords(
  root: string,
  state: WorkspaceState,
  suppliedInputs?: InspectionInputs
) {
  const inputs = suppliedInputs ?? (await InspectionInputs.scan(root));
  const native = new Map<string, WorkspaceRem>(),
    diagnostics: Diagnostic[] = [];
  const fail = (path: string, line: number, code: string, message: string) =>
    diagnostics.push({ path, line, code, message });
  if (state.official) {
    try {
      const data = await inputs.read(state.official.manifestPath);
      if (hash(data) !== state.official.manifestHash)
        throw new Error('Official original manifest changed');
      const manifest = z
        .object({ files: z.record(z.string(), digest) })
        .passthrough()
        .parse(JSON.parse(data));
      await mapReads(Object.entries(manifest.files), 16, async ([path, digest]) => {
        if (!path.startsWith('.remnote/originals/') || hash(await inputs.read(path)) !== digest)
          throw new Error('Official original record changed or is missing');
      });
    } catch (error) {
      fail(
        state.official.manifestPath,
        1,
        'OFFICIAL_ORIGINAL',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  const records = await mapReads(Object.entries(state.entries), 16, async ([id, entry]) => {
    try {
      const raw = await inputs.read(entry.rawPath);
      if (hash(raw) !== entry.rawHash) throw new Error('Native baseline object was modified');
      const original: unknown = JSON.parse(raw);
      remSchema.parse(original);
      // Schema defaults belong to display metadata, never to the byte-preserved native baseline.
      const rem = original as WorkspaceRem;
      if (rem.id !== id || hash(rem) !== entry.nativeHash)
        throw new Error('Native baseline identity/hash mismatch');
      if (
        entry.publicHash &&
        hash(await inputs.read(originalPath('public', id))) !== entry.publicHash
      )
        throw new Error('Original public snapshot was modified');
      if (
        entry.originalHash &&
        hash(await inputs.read(originalPath('rems', id))) !== entry.originalHash
      )
        throw new Error('Official original object was modified');
      return { id, rem };
    } catch (error) {
      return {
        diagnostic: {
          path: entry.rawPath,
          line: 1,
          code: 'READONLY_METADATA',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
  for (const record of records) {
    if (record.rem) native.set(record.id, record.rem);
    else diagnostics.push(record.diagnostic!);
  }
  return { inputs, native, diagnostics };
}

export async function inspectLocal(
  root: string,
  suppliedState?: WorkspaceState,
  sources: ReadonlyMap<string, string> = new Map(),
  suppliedInputs?: InspectionInputs
): Promise<LocalContext> {
  const state = suppliedState ?? (await loadState(root));
  const { inputs, native, diagnostics } = await inspectNativeRecords(root, state, suppliedInputs);
  const files = inputs.paths,
    dirty: string[] = [],
    missing: string[] = [];
  const fail = (path: string, line: number, code: string, message: string) =>
    diagnostics.push({ path, line, code, message });
  try {
    const identity = identitySchema.parse(JSON.parse(await inputs.read(IDENTITY)));
    if (hash(identity) !== hash(workspaceIdentity(state)))
      throw new Error('Tracked identity map differs from the authoritative manifest');
  } catch (error) {
    const missingIdentity =
      error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
    fail(
      IDENTITY,
      1,
      'IDENTITY',
      missingIdentity
        ? 'Missing tracked identity; a clean sealed legacy vault requires explicit sync format DIR before normal sync'
        : error instanceof Error
          ? error.message
          : String(error)
    );
  }
  const parsed = new Map<string, ParsedDocument>(),
    baseline = new Map<string, ParsedOutline>(),
    allKeys = new Set<string>();
  const expectedRoots = new Map(
    Object.entries(state.documents).map(([path, doc]) => [doc.rootId, { path, doc }])
  );
  const rootsByKey = new Map(
    [...expectedRoots.keys()].map((id) => [state.entries[id]!.blockId, id])
  );
  const paths = new Map<string, string>();
  const currentFiles = new Map<string, { source: string; prepared: PreparedDocument }>();
  const foldedPaths = new Set<string>();
  for (const path of files.filter(isContentMarkdown)) {
    if (foldedPaths.has(pathKey(path)))
      fail(path, 1, 'AMBIGUOUS_PATH', 'Case/Unicode-colliding Markdown paths are unsupported');
    foldedPaths.add(pathKey(path));
    const source = sources.get(path) ?? (await inputs.read(path)),
      prepared = inputs.prepare(path, source),
      frontmatter = prepared.frontmatter;
    currentFiles.set(path, { source, prepared });
    diagnostics.push(...frontmatter.diagnostics);
    if (!frontmatter.documentKey || !frontmatter.attributes) continue;
    const rootId = rootsByKey.get(frontmatter.documentKey);
    if (!rootId) {
      fail(
        path,
        1,
        'UNTRACKED_FILE',
        'Hidden document key is not an imported native root; a filename does not create or move a native Rem'
      );
      continue;
    }
    if (paths.has(rootId))
      fail(path, 1, 'DUPLICATE_ROOT', 'One native root is claimed by multiple Markdown files');
    else paths.set(rootId, path);
  }
  for (const [id, { path }] of expectedRoots)
    if (!paths.has(id)) {
      missing.push(path);
      fail(path, 1, 'MISSING_FILE', 'Missing file is not a remote deletion');
    }
  const blocks = new Map(Object.entries(state.entries).map(([id, entry]) => [id, entry.blockId]));
  const originalIds = new Set(
    Object.entries(state.entries)
      .filter(([, entry]) => entry.originalHash)
      .map(([id]) => id)
  );
  if (native.size === Object.keys(state.entries).length)
    for (const [rootId, path] of paths) {
      const value = currentFiles.get(path)!;
      value.prepared = bindPreparedDocument(
        value.prepared,
        documentMetadata(rootId, native, paths, { blocks, originalIds })
      );
    }
  const links = new WorkspaceLinks(
    [...currentFiles]
      .filter(([, value]) => value.prepared.frontmatter.metadata)
      .map(([path, value]) => ({
        path,
        metadata: value.prepared.frontmatter.metadata!,
        title: preparedTitle(value.prepared),
      }))
  );
  for (const [rootId, path] of paths) {
    const doc = expectedRoots.get(rootId)!.doc;
    const { source, prepared } = currentFiles.get(path)!;
    const frontmatter = prepared.frontmatter;
    const current = parsePreparedDocument(prepared, links);
    parsed.set(path, current.document);
    diagnostics.push(...current.diagnostics);
    if (hash(source) !== doc.fileHash || expectedRoots.get(rootId)!.path !== path) dirty.push(path);
    if (native.size !== Object.keys(state.entries).length) continue;
    const { title, aliases, tags } = frontmatter.metadata!;
    const display = { ...(title === undefined ? {} : { title }), aliases, tags };
    const old = renderParsedDocument(doc.rootId, path, native, paths, {
      blocks,
      originalIds,
      display,
      links,
      attributes: frontmatter.attributes,
    }).document;
    baseline.set(path, old);
    if (current.document.nodes[0]?.key !== doc.rootId)
      fail(
        path,
        1,
        'ROOT_BINDING',
        'Document root ID is immutable; heading does not convert the native Rem type'
      );
    const oldNodes = new Map(old.nodes.map((node) => [node.key, node]));
    for (const node of current.document.nodes) {
      if (node.kind !== 'mount') {
        if (allKeys.has(node.key))
          fail(path, node.line, 'DUPLICATE_ID', 'Duplicate Rem ID/localKey across the workspace');
        allKeys.add(node.key);
      }
      const before = oldNodes.get(node.key);
      if (node.key.startsWith('new:')) {
        if (
          node.kind === 'mount' ||
          node.kind === 'opaque' ||
          node.kind === 'basic' ||
          node.parent === null
        )
          fail(
            path,
            node.line,
            'NEW_SHAPE',
            'New nodes must be text or explicitly declared multiline under an existing mapped root'
          );
        const parent = current.document.nodes.find((candidate) => candidate.key === node.parent);
        if (!parent || ['opaque', 'mount', 'basic'].includes(parent.kind))
          fail(
            path,
            node.line,
            'NESTING',
            'Cannot insert beneath an opaque, mount or basic-card node'
          );
        if (
          parent?.kind === 'multiline' &&
          (node.kind !== 'text' || node.children.length || !node.text.length)
        )
          fail(
            path,
            node.line,
            'ANSWER_SHAPE',
            'Multiline answers must be nonempty leaf text/code nodes'
          );
        if (parent?.kind === 'multiline' && !parent.key.startsWith('new:'))
          fail(
            path,
            node.line,
            'CARD_IDENTITY',
            'Adding answers to an existing card changes its shape; only new cards may gain answer nodes'
          );
      } else if (!before)
        fail(path, node.line, 'UNKNOWN_ID', 'Native ID does not belong to this mapped document');
      else {
        if (
          node.kind !== 'mount' &&
          hash(current.document.metadata?.rems[node.key]) !== hash(old.metadata?.rems[node.key])
        )
          fail(
            path,
            node.line,
            'READONLY_YAML',
            'Existing id/block/content/native/readOnly metadata is immutable'
          );
        if (node.parent !== before.parent || node.kind !== before.kind)
          fail(path, node.line, 'IMMUTABLE_STRUCTURE', 'Existing parent/card kind is immutable');
        if (['opaque', 'mount'].includes(before.kind) && node.contentHash !== before.contentHash)
          fail(
            path,
            node.line,
            'OPAQUE_EDIT',
            'Opaque native content and document mounts are read only'
          );
        if (hash(node.children.filter((id) => !id.startsWith('new:'))) !== hash(before.children))
          fail(
            path,
            node.line,
            'IMMUTABLE_ORDER',
            'Existing child IDs and their relative order must be preserved'
          );
        if (before.text.length && !node.text.length && !['opaque', 'mount'].includes(node.kind))
          fail(path, node.line, 'EMPTY_TEXT', 'Existing text/questions may not be erased');
      }
    }
    const currentKeys = new Set(current.document.nodes.map((node) => node.key));
    for (const node of old.nodes)
      if (!currentKeys.has(node.key))
        fail(path, 1, 'MISSING_ID', `Missing ${node.key} is not a remote deletion`);
    const unchangedReferences = new Map<string, number>();
    for (const node of old.nodes) {
      for (const part of [...node.text, ...node.backText]) {
        if (
          part &&
          typeof part === 'object' &&
          'i' in part &&
          part.i === 'q' &&
          '_id' in part &&
          typeof part._id === 'string'
        ) {
          const key = `${node.key}:${part._id}`;
          unchangedReferences.set(key, (unchangedReferences.get(key) ?? 0) + 1);
        }
      }
    }
    for (const reference of current.document.references) {
      const owner = [...current.document.nodes]
        .reverse()
        .find((node) => node.line <= reference.line);
      const key = `${owner?.key}:${reference.id}`,
        remaining = unchangedReferences.get(key) ?? 0;
      if (remaining) unchangedReferences.set(key, remaining - 1);
      if (!native.has(reference.id) && !remaining)
        fail(
          path,
          reference.line,
          'DANGLING_REFERENCE',
          `New/retargeted reference ${reference.id} is not present in the bound workspace; existing external references are retained`
        );
    }
  }
  return { inputs, state, native, parsed, baseline, diagnostics, dirty, missing };
}
