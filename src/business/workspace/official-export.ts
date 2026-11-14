import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { z } from 'zod';
import { idSchema } from './markdown.js';
import { nativeDetailsSchema, nativeSchema } from './metadata.js';
import { validateGraph } from './local.js';
import { hash, type WorkspaceRem, type WorkspaceState, type WorkspaceBackend } from './types.js';

const MAX_INPUT = 64 * 1024 * 1024;
const exported = z
  .object({
    knowledgebaseId: z.string().min(1),
    exportDate: z.string().min(1),
    exportVersion: z.literal(1),
    docs: z.array(z.record(z.string(), z.unknown())).max(100000),
  })
  .passthrough();
const flagsSchema = z
  .object({
    document: z.boolean().nullable().optional(),
    folder: z.boolean().nullable().optional(),
    cardItem: z.boolean().nullable().optional(),
    practice: z.enum(['forward', 'backward', 'both', 'none']).nullable().optional(),
    enablePractice: z.boolean().nullable().optional(),
    unsupported: z.string().optional(),
    tags: nativeSchema.shape.tags.optional(),
    references: nativeSchema.shape.references.optional(),
    powerups: nativeSchema.shape.powerups.optional(),
    propertyValues: nativeSchema.shape.propertyValues.optional(),
    cards: nativeSchema.shape.cards.optional(),
    facts: nativeDetailsSchema.partial().optional(),
    collected: z
      .array(z.string().refine((key) => key !== 'collected' && key in nativeSchema.shape))
      .refine((keys) => new Set(keys).size === keys.length)
      .optional(),
    portal: z
      .object({ type: z.json().nullable(), directlyIncludedRemIds: z.array(idSchema).nullable() })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    knowledgeBaseId: z.string(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    exportDate: z.string(),
    snapshots: z.array(z.record(z.string(), z.unknown())).max(100000),
    flags: z.record(idSchema, flagsSchema),
  })
  .strict();

const supplementalFields = [
  'tags',
  'references',
  'powerups',
  'propertyValues',
  'portal',
  'cards',
  'facts',
  'collected',
] as const;
function supplemental(rem: Partial<WorkspaceRem>): Partial<WorkspaceRem> {
  return Object.fromEntries(
    supplementalFields.flatMap((key) => (rem[key] === undefined ? [] : [[key, rem[key]]]))
  );
}

async function input(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_INPUT || (stat.mode & 0o077) !== 0)
      throw new Error('Bootstrap inputs must be private regular files at most 64 MiB');
    return await file.readFile();
  } finally {
    await file.close();
  }
}

/** Public serializer may encode undefined values; never decode compressed backup field names. */
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  if (object.$type === 'undefined' && Object.keys(object).length === 1) return undefined;
  return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, decode(child)]));
}

export interface OfficialBootstrap {
  rems: WorkspaceRem[];
  originals: Map<string, string>;
  source: NonNullable<WorkspaceState['official']>;
}

/** Offline validation precedes all content writes. Unknown archive members are never extracted. */
export async function readOfficialExport(
  archivePath: string,
  snapshotPath: string | undefined,
  kbId: string,
  backendFactory?: () => Promise<WorkspaceBackend>,
  editableRootId?: string
): Promise<OfficialBootstrap> {
  const archive = await input(archivePath),
    archiveSha256 = createHash('sha256').update(archive).digest('hex');
  const names = new Set<string>();
  let total = 0;
  const files = unzipSync(archive, {
    filter: (file) => {
      if (names.has(file.name) || !/^[A-Za-z0-9_.-]+$/.test(file.name) || file.name === '..')
        throw new Error('Unsafe or duplicate official ZIP member');
      names.add(file.name);
      total += file.originalSize;
      if (names.size > 100 || file.originalSize > MAX_INPUT || total > 256 * 1024 * 1024)
        throw new Error('Official ZIP exceeds bounded extraction limits');
      return file.name === 'rem.json' || file.name === 'cards.json';
    },
  });
  if (!files['rem.json'] || !files['cards.json'])
    throw new Error('Official export requires rem.json and cards.json');
  const remExport = exported.parse(JSON.parse(Buffer.from(files['rem.json']).toString('utf8')));
  const cardExport = exported.parse(JSON.parse(Buffer.from(files['cards.json']).toString('utf8')));
  if ([remExport, cardExport].some((value) => value.knowledgebaseId !== kbId))
    throw new Error('Official export identity/date binding mismatch');
  const rawById = new Map<string, Record<string, unknown>>();
  for (const rem of remExport.docs) {
    const id = idSchema.parse(rem._id);
    if (rawById.has(id)) throw new Error('Duplicate official Rem ID');
    if (rem.parent !== null) idSchema.parse(rem.parent);
    rawById.set(id, rem);
  }
  if (editableRootId && !rawById.has(editableRootId))
    throw new Error('Editable root is absent from official export');
  let backend: WorkspaceBackend | undefined;
  const connect = async () => {
    backend ??= await backendFactory!();
    if ((await backend.identity()).kbId !== kbId) throw new Error('Official discovery KB mismatch');
    return backend;
  };
  if (!snapshotPath && !backendFactory)
    throw new Error('Official export requires public SDK discovery');
  const snapshotInput: unknown = snapshotPath
    ? JSON.parse((await input(snapshotPath)).toString('utf8'))
    : {
        schemaVersion: 1,
        knowledgeBaseId: kbId,
        sourceSha256: archiveSha256,
        exportDate: remExport.exportDate,
        ...(await (await connect()).discover([...rawById.keys()])),
      };
  snapshotSchema.parse(snapshotInput);
  // Validation must not materialize Zod defaults into partially collected native facts.
  const snapshots = snapshotInput as z.infer<typeof snapshotSchema>;
  if (
    snapshots.knowledgeBaseId !== kbId ||
    snapshots.sourceSha256 !== archiveSha256 ||
    snapshots.exportDate !== remExport.exportDate
  )
    throw new Error('Official export/snapshot KB, date or archive SHA binding mismatch');
  const publicById = new Map<string, Record<string, unknown>>(),
    publicOriginalById = new Map<string, Record<string, unknown>>();
  for (const snapshot of snapshots.snapshots) {
    const id = idSchema.parse(snapshot.id);
    if (snapshot.$type !== 'rem' || publicById.has(id) || !rawById.has(id))
      throw new Error('Public snapshot type/ID-set mismatch');
    publicById.set(id, decode(snapshot) as Record<string, unknown>);
    publicOriginalById.set(id, snapshot);
  }
  if (
    publicById.size !== rawById.size ||
    Object.keys(snapshots.flags).some((id) => !rawById.has(id))
  )
    throw new Error('Public snapshot/flags do not match exact export ID set');
  if (editableRootId) {
    if (!backendFactory)
      throw new Error('Editable subtree verification requires a live SDK connection');
    for (const rem of await (await connect()).subtree([editableRootId])) {
      const old = publicById.get(rem.id);
      if (
        !old ||
        hash([
          old.parent,
          old.children,
          old.text ?? null,
          old.backText ?? null,
          old.type ?? null,
        ]) !== hash([rem.parent, rem.children, rem.text, rem.backText, rem.type])
      )
        throw new Error(
          'Editable subtree changed after public snapshot; refresh export/snapshot before import'
        );
      const before = snapshots.flags[rem.id];
      snapshots.flags[rem.id] = {
        ...before,
        document: rem.document,
        folder: rem.folder,
        cardItem: rem.cardItem,
        practice: rem.practice,
        enablePractice: rem.enablePractice,
        unsupported: rem.unsupported ?? '',
        ...supplemental(rem),
        ...(before?.facts || rem.facts ? { facts: { ...before?.facts, ...rem.facts } } : {}),
        ...(before?.collected || rem.collected
          ? {
              collected: [
                ...new Set([...(before?.collected ?? []), ...(rem.collected ?? [])]),
              ].sort(),
            }
          : {}),
      };
    }
  }
  const rems: WorkspaceRem[] = [];
  for (const [id, raw] of rawById) {
    const live = publicById.get(id)!,
      flags = snapshots.flags[id];
    if (
      flags?.cards?.some((card) => card.remId !== id) ||
      (flags?.cards && new Set(flags.cards.map((card) => card.id)).size !== flags.cards.length)
    )
      throw new Error('Native card snapshot identity/owner mismatch');
    if (live.parent !== raw.parent || !Array.isArray(live.children))
      throw new Error('Public snapshot parent/ordered children incomplete or changed since export');
    const complete =
      flags &&
      typeof flags.document === 'boolean' &&
      typeof flags.folder === 'boolean' &&
      typeof flags.cardItem === 'boolean' &&
      typeof flags.practice === 'string' &&
      typeof flags.enablePractice === 'boolean' &&
      typeof flags.unsupported === 'string';
    const unsupported = complete ? flags.unsupported : 'unverified-native-flags';
    rems.push({
      id,
      parent: raw.parent as string | null,
      children: z.array(idSchema).parse(live.children),
      type:
        live.type === undefined || live.type === null
          ? null
          : z.union([z.number().int(), z.string()]).parse(live.type),
      text: live.text ?? null,
      backText: live.backText ?? null,
      document: flags?.document ?? null,
      folder: flags?.folder ?? null,
      cardItem: flags?.cardItem ?? null,
      practice: flags?.practice ?? null,
      enablePractice: flags?.enablePractice ?? null,
      public: publicOriginalById.get(id)!,
      ...supplemental(flags ?? {}),
      ...(unsupported ? { unsupported } : {}),
    });
  }
  const errors = validateGraph(rems);
  if (errors.length)
    throw new Error(`Official/native graph mismatch: ${errors.slice(0, 10).join('; ')}`);
  const originals = new Map<string, string>(),
    hashes: Record<string, string> = {};
  const add = (path: string, value: unknown) => {
    const text = JSON.stringify(value, null, 2) + '\n';
    originals.set(path, text);
    hashes[path] = hash(text);
  };
  const remPaths: string[] = [],
    cardPaths: string[] = [],
    publicPaths: string[] = [];
  for (const rem of remExport.docs) {
    const path = `.remnote/originals/rems/${rem._id}.json`;
    remPaths.push(path);
    add(path, rem);
  }
  cardExport.docs.forEach((card, index) => {
    const path = `.remnote/originals/cards/${String(index).padStart(6, '0')}.json`;
    cardPaths.push(path);
    add(path, card);
  });
  snapshots.snapshots.forEach((rem) => {
    const path = `.remnote/originals/public/${rem.id}.json`;
    publicPaths.push(path);
    add(path, rem);
  });
  const { docs: _rems, ...remHeader } = remExport,
    { docs: _cards, ...cardHeader } = cardExport;
  const manifestPath = '.remnote/originals/manifest.json';
  const manifest =
    JSON.stringify(
      {
        schemaVersion: 1,
        archiveSha256,
        remHeader,
        cardHeader,
        remPaths,
        cardPaths,
        publicPaths,
        flags: snapshots.flags,
        files: hashes,
      },
      null,
      2
    ) + '\n';
  originals.set(manifestPath, manifest);
  return {
    rems,
    originals,
    source: {
      archiveSha256,
      exportDate: remExport.exportDate,
      manifestPath,
      manifestHash: hash(manifest),
      remCount: remExport.docs.length,
      cardCount: cardExport.docs.length,
    },
  };
}
