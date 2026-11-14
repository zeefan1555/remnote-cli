import { randomUUID } from 'node:crypto';
import {
  allFiles,
  assertFileSize,
  displacePrivate,
  fileByteLimit,
  linkPrivate,
  MAX_METADATA_BYTES,
  readPrivate,
  withWorkspaceLock,
  workspaceDirectory,
  writePrivate,
} from './files.js';
import {
  authoritativeState,
  loadState,
  publicationStore,
  saveState,
  serializeState,
} from './local.js';
import { FrozenFiles } from './frozen-files.js';
import { hash, type WorkspaceState } from './types.js';

interface Publication {
  version: 1;
  directory: string;
  previousHash: string | null;
  next: WorkspaceState;
  baseline: Record<string, string>;
  writes: Array<{ path: string; stage: string | null; hash: string | null; backup: string }>;
}
async function currentHash(
  root: string,
  path: string,
  maxBytes = fileByteLimit(path)
): Promise<string | null> {
  try {
    return hash(await readPrivate(root, path, maxBytes));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export async function readPublication(root: string): Promise<Publication | undefined> {
  const value = await publicationStore().getLocal<Publication | null>(`publication:${hash(root)}`);
  if (!value) return;
  if (value.version !== 1 || value.directory !== root || value.next.directory !== root)
    throw new Error('Invalid snapshot publication binding');
  serializeState(value.next);
  return value;
}
export async function requireNoPublication(root: string): Promise<void> {
  if (await readPublication(root))
    throw new Error(
      'Unfinished local snapshot publication; run sync recover before another import/sync'
    );
}

async function publish(root: string, publication: Publication): Promise<void> {
  const writes = new Map(publication.writes.map((item) => [item.path, item]));
  const check = async (final = false) => {
    let current: WorkspaceState | undefined;
    try {
      // This single-file authoritative ledger already authorizes exactly the old/new manifest hashes.
      // Reading the manifest directly also repairs interruption between manifest and its ordinary seal.
      current = await authoritativeState(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (
      (current ? hash(current) : null) !== publication.previousHash &&
      (!current || hash(current) !== hash(publication.next))
    )
      throw new Error('Sync metadata changed during local publication');
    const paths = await allFiles(root),
      allowed = new Set([...Object.keys(publication.baseline), ...writes.keys()]);
    if (paths.some((path) => !allowed.has(path)))
      throw new Error('Local file set changed during sync publication');
    for (const path of allowed) {
      const actual = await currentHash(root, path),
        write = writes.get(path),
        before = publication.baseline[path] ?? null;
      const displaced = write ? await currentHash(root, write.backup, fileByteLimit(path)) : null;
      if (displaced !== null && displaced !== before)
        throw new Error(
          `Concurrent content preserved in ${write!.backup}; reconcile before recover`
        );
      if (
        write
          ? final
            ? actual !== write.hash
            : actual !== before &&
              actual !== write.hash &&
              !(actual === null && displaced === before)
          : actual !== before
      )
        throw new Error(`Local file changed during sync publication: ${path}`);
    }
  };
  await check();
  for (const item of publication.writes) {
    const maxBytes = fileByteLimit(item.path);
    const actual = await currentHash(root, item.path);
    if (actual === item.hash) continue;
    const before = publication.baseline[item.path] ?? null;
    const backup = await currentHash(root, item.backup, maxBytes);
    if (actual !== before && !(actual === null && backup === before))
      throw new Error(`Local file changed during sync publication: ${item.path}`);
    if (actual !== null) {
      await displacePrivate(root, item.path, item.backup);
      if ((await currentHash(root, item.backup, maxBytes)) !== before) {
        // Restore without overwriting a subsequent save; the displaced copy is always retained.
        if ((await currentHash(root, item.path)) === null)
          await linkPrivate(root, item.backup, item.path);
        throw new Error(`Concurrent content preserved in ${item.backup}; reconcile before recover`);
      }
    }
    if (item.stage !== null) {
      if ((await currentHash(root, item.stage, maxBytes)) !== item.hash)
        throw new Error('Staged snapshot content integrity mismatch');
      // link(2) fails EEXIST if an editor saved after displacement; it never replaces that save.
      await linkPrivate(root, item.stage, item.path);
    }
  }
  await check(true);
  await saveState(root, publication.next);
  await publicationStore().setLocal(`publication:${hash(root)}`, null);
}

/** Prepare all files first. Keep the old manifest and push journal until publication is complete. */
export async function stageSnapshot(
  root: string,
  next: WorkspaceState,
  previous: WorkspaceState | undefined,
  writes: Map<string, string | null>,
  frozen: FrozenFiles
): Promise<void> {
  await requireNoPublication(root);
  serializeState(next);
  const publication: Publication = {
    version: 1,
    directory: root,
    previousHash: previous ? hash(previous) : null,
    next,
    baseline: frozen.hashes(),
    writes: [],
  };
  const stageRoot = `.sync/staging/${randomUUID()}`;
  for (const [path, content] of writes) {
    if (content !== null) assertFileSize(path, content);
    const stage = content === null ? null : `${stageRoot}/${publication.writes.length}.json`;
    publication.writes.push({
      path,
      stage,
      hash: content === null ? null : hash(content),
      backup: `${stageRoot}/${publication.writes.length}.displaced`,
    });
  }
  if (Buffer.byteLength(JSON.stringify(publication)) > MAX_METADATA_BYTES)
    throw new Error('Snapshot publication metadata exceeds 32 MiB');
  // Validate final serialized bytes before creating even the first staging file.
  for (const item of publication.writes)
    if (item.stage !== null)
      await writePrivate(root, item.stage, writes.get(item.path)!, fileByteLimit(item.path));
  await frozen.check();
  if (previous && hash(await loadState(root)) !== hash(previous))
    throw new Error('Local sync metadata changed while staging');
  // One atomic metadata record is the authority; no content is stored in the CLI state directory.
  await publicationStore().setLocal(`publication:${hash(root)}`, publication);
  await publish(root, publication);
}

export async function recoverWorkspace(directory: string): Promise<unknown> {
  const root = await workspaceDirectory(directory);
  return withWorkspaceLock(root, async () => {
    const publication = await readPublication(root);
    if (!publication) {
      const state = await loadState(root);
      if (state.pending)
        throw new Error(
          'Remote push journal is pending; preserve its key/IDs and reconcile native outcome before further writes'
        );
      return { status: 'nothing-to-recover', complete: true, remoteWrites: 0 };
    }
    await publish(root, publication);
    return {
      status: 'recovered',
      complete: true,
      remoteWrites: 0,
      kbId: publication.next.kbId,
      pending: publication.next.pending ?? null,
    };
  });
}
