import { posix } from 'node:path';
import type { WorkspaceMetadata } from './metadata.js';
import { referenceBranches } from './reference-projection.js';

export interface LinkDocument {
  path: string;
  title: string;
  metadata: WorkspaceMetadata;
}
export interface LinkTarget {
  id: string;
  path: string;
  block: string;
  root: boolean;
  title: string;
  hidden?: boolean;
}

export const pathKey = (path: string): string => path.normalize('NFC').toLocaleLowerCase('en-US');
const stem = (path: string) => path.replace(/\.md$/i, '');
const label = (value: string) => value.replace(/[[\]|\r\n]/g, ' ').trim() || 'Untitled';

/** Every lookup is an exact modeled identity. No guessed target or remote search fallback. */
export class WorkspaceLinks {
  private readonly byId = new Map<string, LinkTarget>();
  private readonly byPath = new Map<string, LinkDocument[]>();
  private readonly byStem = new Map<string, LinkDocument[]>();
  private readonly byBasename = new Map<string, LinkDocument[]>();
  // Paths are fixed for this operation; retain all matches so collisions still fail closed.
  constructor(documents: readonly LinkDocument[]) {
    for (const document of documents) {
      for (const [index, key] of [
        [this.byPath, pathKey(document.path)],
        [this.byStem, pathKey(stem(document.path))],
        [this.byBasename, pathKey(stem(posix.basename(document.path)))],
      ] as const) {
        const matches = index.get(key) ?? [];
        matches.push(document);
        index.set(key, matches);
      }
      const hidden = new Set(
        [...referenceBranches(document.metadata).values()].flatMap((branch) => branch.ids.slice(1))
      );
      for (const [key, entry] of Object.entries(document.metadata.rems))
        this.byId.set(key, {
          id: key,
          path: document.path,
          block: entry.block,
          root: key === document.metadata.root,
          title: key === document.metadata.root ? document.title : key,
          hidden: hidden.has(key),
        });
    }
  }

  render(id: string, display?: string): string {
    const target = this.byId.get(id);
    if (!target || target.hidden) return `[${label(display ?? id)}](remnote:${id})`;
    return `[[${stem(target.path)}${target.root ? '' : `#^${target.block}`}|${label(display ?? target.title)}]]`;
  }

  resolve(currentPath: string, target: string): LinkTarget {
    const separator = target.indexOf('#');
    const file = separator < 0 ? target : target.slice(0, separator);
    const fragment = separator < 0 ? '' : target.slice(separator + 1);
    if (target.includes('\\') || target.includes('\n') || file.includes(':'))
      throw new Error('Unsupported Wiki link target');
    let candidates: LinkDocument[];
    if (!file) candidates = this.byPath.get(pathKey(currentPath)) ?? [];
    else {
      const exact =
        file.startsWith('./') || file.startsWith('../')
          ? posix.normalize(posix.join(posix.dirname(currentPath), file))
          : file.replace(/^\//, '');
      candidates = this.byStem.get(pathKey(stem(exact))) ?? [];
      if (!candidates.length && !file.includes('/'))
        candidates = this.byBasename.get(pathKey(stem(file))) ?? [];
    }
    if (candidates.length !== 1)
      throw new Error(
        candidates.length
          ? 'Ambiguous Wiki link file name; use the full vault path'
          : 'Unknown Wiki link file'
      );
    const doc = candidates[0]!;
    if (!fragment) return this.byId.get(doc.metadata.root)!;
    if (fragment.startsWith('^')) {
      const matches = Object.entries(doc.metadata.rems).filter(
        ([, entry]) => entry.block === fragment.slice(1)
      );
      if (matches.length !== 1) throw new Error('Unknown or ambiguous Wiki block ID');
      const target = this.byId.get(matches[0]![0])!;
      if (target.root || target.hidden)
        throw new Error(
          'Document roots and hidden reference wrappers have no visible block anchor'
        );
      return target;
    }
    // The supported outline has exactly one heading: H1, bound to the document root.
    if (pathKey(fragment) === pathKey(doc.title)) return this.byId.get(doc.metadata.root)!;
    throw new Error('Heading does not uniquely identify a modeled Rem');
  }
}
