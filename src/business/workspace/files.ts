import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
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

/** Only explicit, verified sync deletions call this; missing files never request native deletion. */
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

async function releaseOwnedLock(
  roots: string[],
  owned: { dev: number; ino: number }
): Promise<void> {
  // A relocation moves this same lock inode. Never remove a replacement/foreign lock.
  for (const candidate of new Set(roots)) {
    try {
      const path = await safePath(candidate, '.sync/writer.lock');
      const current = await lstat(path);
      if (current.dev !== owned.dev || current.ino !== owned.ino || current.isSymbolicLink())
        continue;
      await unlink(path);
      return;
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
  const path = await safePath(root, '.sync/writer.lock', true);
  let file;
  try {
    file = await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        'Workspace writer is locked; inspect its process and pending journal, never auto-break an unknown writer',
        { cause: error }
      );
    throw error;
  }
  const owned = await file.stat();
  try {
    await file.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await file.sync();
    return await action();
  } finally {
    await file.close();
    await releaseOwnedLock(relocatedRoot ? [root, relocatedRoot] : [root], owned);
  }
}
