import { allFiles, readPrivate, writePrivate } from './files.js';
import { hash } from './types.js';
import { mapReads } from './read-pool.js';

/** Refuse concurrent local changes both after remote reads and immediately before each replacement. */
export class FrozenFiles {
  private constructor(
    private readonly root: string,
    private readonly expected: Map<string, string>
  ) {}
  static async capture(
    root: string,
    paths?: string[],
    read: (path: string) => Promise<string> = (path) => readPrivate(root, path)
  ): Promise<FrozenFiles> {
    const expected = new Map(
      await mapReads(
        paths ?? (await allFiles(root)),
        16,
        async (path) => [path, hash(await read(path))] as const
      )
    );
    return new FrozenFiles(root, expected);
  }
  hashes(): Record<string, string> {
    return Object.fromEntries(this.expected);
  }
  async check(): Promise<void> {
    const paths = await allFiles(this.root);
    if (paths.length !== this.expected.size || paths.some((path) => !this.expected.has(path)))
      throw new Error('Local file set changed during sync; preserve files and reconcile');
    await mapReads(paths, 16, (path) => this.checkPath(path));
  }
  private async checkPath(path: string): Promise<void> {
    let actual: string | undefined;
    try {
      actual = hash(await readPrivate(this.root, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (actual !== this.expected.get(path))
      throw new Error(`Local file changed during sync: ${path}`);
  }
  async write(path: string, content: string): Promise<void> {
    await this.checkPath(path);
    await writePrivate(this.root, path, content);
    this.expected.set(path, hash(content));
  }
}
