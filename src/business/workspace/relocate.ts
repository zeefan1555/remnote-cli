import { lstat, open, realpath, rename } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { readPrivate, STATE, withWorkspaceLock, workspaceDirectory } from './files.js';
import { authoritativeState, loadState, manifestStore, saveState } from './local.js';
import { requireNoPublication } from './publication.js';
import { hash, type WorkspaceState } from './types.js';

const receiptSchema = z
  .object({
    version: z.literal(1),
    source: z.string(),
    destination: z.string(),
    device: z.number().int(),
    inode: z.number().int(),
    previousHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function canonicalPath(input: string): Promise<string> {
  const path = resolve(input);
  if (path === dirname(path) || path === homedir())
    throw new Error('Relocation requires dedicated directories');
  if (resolve(await realpath(dirname(path)), basename(path)) !== path)
    throw new Error('Relocation paths must not contain symlink aliases');
  return path;
}

function nested(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`));
}

async function maybeState(root: string): Promise<WorkspaceState | undefined> {
  try {
    return await authoritativeState(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

/** Pure filesystem relocation. A private inode-bound receipt proves interrupted destinations. */
export async function relocateWorkspace(source: string, destination: string) {
  const from = await canonicalPath(source),
    to = await canonicalPath(destination);
  if (nested(from, to) || nested(to, from))
    throw new Error('Relocation paths must be distinct and non-nested');
  const store = manifestStore(),
    key = `relocation:${hash(from)}`;
  const saved = await store.getLocal<unknown>(key);
  let receipt = saved === undefined ? undefined : receiptSchema.parse(saved);
  if (receipt && (receipt.source !== from || receipt.destination !== to))
    throw new Error('An existing relocation is bound to different paths');
  const sourceExists = await pathExists(from),
    destinationExists = await pathExists(to);
  if (sourceExists === destinationExists || (!receipt && !sourceExists))
    throw new Error('Relocation requires an absent destination or its exact interrupted receipt');
  const currentRoot = sourceExists ? from : to;
  await workspaceDirectory(currentRoot);
  return withWorkspaceLock(
    currentRoot,
    async () => {
      await requireNoPublication(from);
      await requireNoPublication(to);
      const before = await maybeState(from),
        after = await maybeState(to);
      const identity = await lstat(currentRoot);
      if (identity.dev !== (await lstat(dirname(to))).dev)
        throw new Error('Relocation must remain on the same filesystem');
      if (!receipt) {
        // A stale destination authority is not a free name, even when its directory is absent.
        if ((await store.getLocal(`manifest:${hash(to)}`)) !== undefined)
          throw new Error('Destination sync manifest already exists');
        const state = await loadState(from);
        if (!state.complete || state.pending)
          throw new Error('Relocation requires a complete baseline with no pending remote journal');
        receipt = {
          version: 1,
          source: from,
          destination: to,
          device: identity.dev,
          inode: identity.ino,
          previousHash: hash(state),
        };
        await store.setLocal(key, receipt);
      }
      if (receipt.device !== identity.dev || receipt.inode !== identity.ino)
        throw new Error('Relocation directory identity changed; no binding was modified');
      const original = before ?? (after && { ...after, directory: from });
      if (
        !original ||
        hash(original) !== receipt.previousHash ||
        !original.complete ||
        original.pending
      )
        throw new Error('Relocation source manifest changed; inspect the recorded operation');
      const next = { ...original, directory: to };
      if (after && hash(after) !== hash(next))
        throw new Error('Relocation destination manifest differs from the recorded operation');
      if (sourceExists && after)
        throw new Error('Destination authority exists before directory relocation');
      const mirrorHash = hash(JSON.parse(await readPrivate(currentRoot, STATE)));
      if (mirrorHash !== hash(original) && (!after || mirrorHash !== hash(next)))
        throw new Error('Relocation metadata mirror integrity mismatch');
      if (sourceExists) {
        if (await pathExists(to)) throw new Error('Relocation destination appeared concurrently');
        // Node rename is not atomic no-replace. All external filesystem writers must be stopped.
        await rename(from, to);
        for (const parent of new Set([dirname(from), dirname(to)])) {
          const handle = await open(parent, 'r');
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
      }
      if ((await workspaceDirectory(to)) !== to) throw new Error('Relocation destination changed');
      const moved = await lstat(to);
      if (moved.dev !== receipt.device || moved.ino !== receipt.inode)
        throw new Error('Relocation destination inode changed');
      // Keep the old authority until both the new authority and mirror have been read back.
      await saveState(to, next);
      if (hash(await loadState(to)) !== hash(next)) throw new Error('Relocation readback failed');
      if (before) await store.deleteLocal(`manifest:${hash(from)}`);
      await store.deleteLocal(key);
      return {
        ok: true,
        source: from,
        directory: to,
        relocated: true,
        resumed: saved !== undefined,
        remoteChecked: false,
        nativeWrites: 0,
      };
    },
    to
  );
}
