import { constants, type Stats } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { IDENTITY } from './identity.js';

const MAX_FILE = 4 * 1024 * 1024;
export const MAX_METADATA_BYTES = 32 * 1024 * 1024;
export const STATE = '.sync/state.json';
export const OFFICIAL_MANIFEST = '.remnote/originals/manifest.json';
const IGNORED = new Set(['.git', '.sync', '.obsidian', '.trash']);

/** Only these aggregate records share the CLI metadata store's larger bound. */
export function fileByteLimit(name: string): number {
  return name === STATE || name === OFFICIAL_MANIFEST || name === IDENTITY
    ? MAX_METADATA_BYTES
    : MAX_FILE;
}

/** Exact owned guide paths only; arbitrary README.md/SKILL.md remain modeled source. */
export function isContentMarkdown(path: string): boolean {
  return (
    path.endsWith('.md') &&
    path !== 'AGENTS.md' &&
    path !== '.agents/skills/remnote-obsidian/SKILL.md'
  );
}

export function assertFileSize(
  name: string,
  content: string,
  maxBytes = fileByteLimit(name)
): void {
  if (Buffer.byteLength(content) > maxBytes)
    throw new Error(`Workspace file exceeds its safe byte bound: ${name}`);
}

function readableMode(name: string, mode: number): boolean {
  return (
    (mode & 0o077) === 0 ||
    (name.endsWith('.md') &&
      !name.split('/').some((part) => part.startsWith('.')) &&
      (mode & 0o777) === 0o644)
  );
}

/** Explicit, private workspace. Never traverse symlinks inside this boundary. */
export async function workspaceDirectory(input: string, create = false): Promise<string> {
  const path = resolve(input);
  if (path === dirname(path) || path === homedir())
    throw new Error('Workspace must be a dedicated directory');
  if (create) await mkdir(path, { mode: 0o700, recursive: true });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error('Workspace must be a private 0700 directory, not a symlink');
  return realpath(path);
}

async function safePath(root: string, name: string, createParents = false): Promise<string> {
  const path = resolve(root, name),
    rel = relative(root, path);
  if (!rel || isAbsolute(name) || rel.startsWith(`..${sep}`) || rel === '..')
    throw new Error('Path escapes workspace');
  const parts = rel.split(sep);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (createParents)
      await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error('Unsafe workspace directory');
  }
  return path;
}

export async function readPrivate(
  root: string,
  name: string,
  maxBytes = fileByteLimit(name)
): Promise<string> {
  const path = await safePath(root, name);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes || !readableMode(name, stat.mode))
      throw new Error('Unsafe or oversized workspace file');
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

export async function writePrivate(
  root: string,
  name: string,
  content: string,
  maxBytes = fileByteLimit(name)
): Promise<void> {
  assertFileSize(name, content, maxBytes);
  const path = await safePath(root, name, true);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !readableMode(name, stat.mode))
      throw new Error('Unsafe workspace destination');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** Publish a durable immutable record; retries must contain exactly the same bytes. */
export async function writePrivateOnce(root: string, name: string, content: string): Promise<void> {
  const temporary = `${name}.${randomUUID()}.tmp`;
  try {
    await writePrivate(root, temporary, content);
    try {
      await linkPrivate(root, temporary, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if ((await readPrivate(root, name)) !== content)
        throw new Error(`Immutable history record differs: ${name}`, { cause: error });
    }
    if ((await readPrivate(root, name)) !== content)
      throw new Error(`History record readback failed: ${name}`);
  } finally {
    await safePath(root, temporary)
      .then((path) => unlink(path))
      .catch(() => {});
  }
}

/** Remove only an exact verified local publication target. */
export async function removePrivate(root: string, name: string): Promise<void> {
  const path = await safePath(root, name);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe local deletion target');
  await unlink(path);
}

/** Preserve the previous inode before installing with exclusive creation; never overwrite a concurrent save. */
export async function displacePrivate(root: string, name: string, backup: string): Promise<void> {
  const path = await safePath(root, name),
    displaced = await safePath(root, backup, true);
  try {
    await lstat(displaced);
    throw new Error('Displaced content already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await rename(path, displaced);
  const preserved = await open(displaced, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await preserved.stat();
    if (!stat.isFile() || !readableMode(name, stat.mode))
      throw new Error('Unsafe displaced content');
    // Obsidian may save ordinary Markdown as 0644. Its preserved inode becomes private
    // inside staging; metadata/staging paths themselves never gain the Markdown exception.
    await preserved.chmod(0o600);
    await preserved.sync();
  } finally {
    await preserved.close();
  }
  for (const dir of new Set([dirname(path), dirname(displaced)])) {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
export async function linkPrivate(
  root: string,
  source: string,
  destination: string
): Promise<void> {
  const from = await safePath(root, source),
    to = await safePath(root, destination, true);
  const stat = await lstat(from);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error('Unsafe link source');
  await link(from, to);
  const directory = await open(dirname(to), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function allFiles(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symlink forbidden in workspace: ${name}`);
    if ((!prefix && IGNORED.has(entry.name)) || entry.name === '.DS_Store') continue;
    if (entry.isDirectory()) result.push(...(await allFiles(root, name)));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Unsupported filesystem entry: ${name}`);
  }
  return result.sort();
}

const LOCK = '.sync/writer.lock';
const LOCK_MARKER = 'remnote-workspace-kernel-lock:1\n';

function sameInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Publish complete bytes exactly once. The canonical lock inode is never replaced or removed. */
async function openWorkspaceLock(path: string) {
  try {
    return await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  let owned: Stats | undefined;
  try {
    owned = await file.stat();
    await file.writeFile(LOCK_MARKER);
    await file.sync();
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    await file.close();
    // A death here can retain this private alias; it never invalidates the complete marker.
    const current = await lstat(temporary).catch(() => undefined);
    if (owned && current && sameInode(current, owned) && !current.isSymbolicLink())
      await unlink(temporary);
  }
  return open(path, constants.O_RDWR | constants.O_NOFOLLOW);
}

async function assertLockMarker(file: FileHandle): Promise<Stats> {
  const owned = await file.stat(),
    marker = Buffer.alloc(Buffer.byteLength(LOCK_MARKER));
  if (
    !owned.isFile() ||
    (owned.mode & 0o777) !== 0o600 ||
    owned.size !== marker.length ||
    (await file.read(marker, 0, marker.length, 0)).bytesRead !== marker.length ||
    marker.toString('utf8') !== LOCK_MARKER
  )
    throw new Error(
      'Workspace writer is locked by legacy, unknown or unsafe metadata; preserve it for inspection'
    );
  return owned;
}

async function assertOwnedLock(roots: string[], directory: Stats, owned: Stats): Promise<void> {
  for (const candidate of new Set(roots)) {
    try {
      const currentDirectory = await lstat(candidate);
      if (
        !sameInode(currentDirectory, directory) ||
        !currentDirectory.isDirectory() ||
        currentDirectory.isSymbolicLink() ||
        (currentDirectory.mode & 0o077) !== 0
      )
        continue;
      const current = await lstat(await safePath(candidate, LOCK));
      if (sameInode(current, owned) && current.isFile() && (current.mode & 0o777) === 0o600) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error('Workspace lock identity changed; inspect before recovery');
}

export async function withWorkspaceLock<T>(
  root: string,
  action: () => Promise<T>,
  relocatedRoot?: string
): Promise<T> {
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0)
    throw new Error('Workspace must be a private 0700 directory, not a symlink');
  const path = await safePath(root, LOCK, true);
  // Loading/locking errors fail closed. There is no PID/TTL or existence-lock fallback.
  const { tryLock } = await import('fs-native-extensions');
  const file = await openWorkspaceLock(path);
  try {
    if (!tryLock(file.fd)) throw new Error('Workspace writer is locked by another process');
    const owned = await assertLockMarker(file);
    await assertOwnedLock([root], directory, owned);
    // Also flush a marker published by an initializer that died before syncing the directory.
    const parent = await open(dirname(path), 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    let outcome: { value: T } | { error: unknown };
    try {
      outcome = { value: await action() };
    } catch (error) {
      outcome = { error };
    }
    // Relocation moves this exact directory and inode; pathname replacement is never repaired.
    try {
      await assertLockMarker(file);
      await assertOwnedLock(relocatedRoot ? [root, relocatedRoot] : [root], directory, owned);
    } catch (error) {
      if ('error' in outcome)
        throw new AggregateError(
          [outcome.error, error],
          'Workspace action and lock verification failed; preserve the journal before recovery',
          { cause: error }
        );
      throw error;
    }
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  } finally {
    // The kernel also releases ownership on process death; the permanent marker stays intact.
    await file.close();
  }
}
