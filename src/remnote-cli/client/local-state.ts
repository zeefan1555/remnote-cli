import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** Private metadata only. Corrupt journals fail closed, never become a cache miss. */
export class LocalState {
  constructor(private readonly directory: string) {}
  private path(key: string): string {
    return join(this.directory, createHash('sha256').update(key).digest('hex') + '.json');
  }
  async getLocal<T>(key: string | undefined): Promise<T | undefined> {
    if (key === undefined) return undefined;
    let file;
    try {
      file = await open(this.path(key), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || (stat.mode & 0o077) !== 0)
        throw new Error('Invalid private CLI state file');
      return JSON.parse(await file.readFile('utf8')) as T;
    } finally {
      await file.close();
    }
  }
  async setLocal<T>(key: string, value: T): Promise<void> {
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > 4 * 1024 * 1024) throw new Error('CLI metadata exceeds 4 MiB');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(key),
      temporary = path + '.' + randomUUID() + '.tmp';
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(data);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      const directory = await open(this.directory, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}
