import { lstat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { isContentMarkdown } from './files.js';
import type { LocalContext } from './local.js';
import type { SyncSelection, WorkspacePlan, WorkspaceRem } from './types.js';

export interface SelectionOptions {
  scope?: 'changed' | 'all';
  paths?: string[];
}

const sorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();

/** Select existing exact files/directories only. The preceding full scan rejects all symlinks. */
export async function selectFiles(context: LocalContext, values: string[] = []) {
  const files = [...context.parsed.keys()].sort();
  const paths = new Set<string>();
  for (const value of values) {
    if (
      !value ||
      posix.isAbsolute(value) ||
      /[\\\0*?[\]]/.test(value) ||
      value.split('/').includes('..')
    )
      throw new Error(
        '--path requires a vault-relative file or directory without traversal or globs'
      );
    const path = posix.normalize(value).replace(/\/$/, '') || '.';
    if (path.split('/').some((part) => part.startsWith('.') && part !== '.'))
      throw new Error('--path cannot select private metadata or excluded tooling paths');
    if (path !== '.') {
      const parts = path.split('/');
      for (let index = 1; index <= parts.length; index++) {
        const stat = await lstat(join(context.state.directory, ...parts.slice(0, index)));
        if (stat.isSymbolicLink() || (index < parts.length && !stat.isDirectory()))
          throw new Error('Unsafe --path selector');
        if (
          index === parts.length &&
          !stat.isDirectory() &&
          !(stat.isFile() && isContentMarkdown(path) && files.includes(path))
        )
          throw new Error('--path must select a tracked Markdown file or a directory');
      }
    }
    paths.add(path);
  }
  const canonical = sorted(paths);
  return {
    paths: canonical,
    files: files.filter(
      (file) =>
        !canonical.length ||
        canonical.some((path) => path === '.' || file === path || file.startsWith(`${path}/`))
    ),
  };
}

function referenceIds(rem: Partial<Pick<WorkspaceRem, 'text' | 'backText'>>): string[] {
  const result: string[] = [];
  for (const value of [rem.text, rem.backText])
    if (Array.isArray(value))
      for (const part of value)
        if (part && typeof part === 'object' && part.i === 'q' && typeof part._id === 'string')
          result.push(part._id);
  return result;
}

/** Structure/card helpers are checked; unrelated dependency content is never a merge candidate. */
export function verificationClosure(
  context: LocalContext,
  plan: WorkspacePlan,
  candidates: string[]
): string[] {
  const required = new Set(candidates),
    structured = new Set<string>();
  const include = (id: string) => {
    if (context.native.has(id)) required.add(id);
  };
  function structure(id: string): void {
    if (structured.has(id)) return;
    structured.add(id);
    const rem = context.native.get(id);
    if (!rem) return;
    required.add(id);
    if (rem.cardItem && rem.parent) structure(rem.parent);
    if (Array.isArray(rem.backText) || rem.type === 6)
      for (const child of rem.children) structure(child);
    if (rem.type === 6)
      for (const target of rem.portal?.directlyIncludedRemIds ?? []) include(target);
  }
  function ancestors(start: string | null): void {
    for (let id = start; id && context.native.has(id); id = context.native.get(id)!.parent)
      structure(id);
  }
  for (const id of candidates) {
    ancestors(id);
    for (const target of referenceIds(context.native.get(id)!)) include(target);
  }
  for (const change of plan.changes) {
    ancestors(change.key);
    ancestors(change.parent);
    for (const target of referenceIds(change.fields)) include(target);
  }
  return sorted(required).filter((id) => !candidates.includes(id));
}

export async function selectPlan(
  context: LocalContext,
  plan: WorkspacePlan,
  options: SelectionOptions = {}
): Promise<WorkspacePlan & { selection: SyncSelection }> {
  if (options.scope !== undefined && !['changed', 'all'].includes(options.scope))
    throw new Error('--scope must be changed or all');
  const selected = await selectFiles(context, options.paths);
  const changes = plan.changes.filter((change) => selected.files.includes(change.path));
  const candidates =
    plan.deletion?.ids ??
    (options.scope === 'all'
      ? [...context.parsed]
          .filter(([path]) => selected.files.includes(path))
          .flatMap(([, doc]) =>
            doc.nodes
              .filter((node) => node.kind !== 'mount' && !node.key.startsWith('new:'))
              .map((node) => node.key)
          )
      : changes.filter((change) => !change.key.startsWith('new:')).map((change) => change.key));
  const reconcileIds = sorted(candidates);
  const selection: SyncSelection = {
    scope: plan.deletion ? 'delete' : (options.scope ?? 'changed'),
    paths: plan.deletion ? [] : selected.paths,
    files: plan.deletion
      ? sorted(
          [...context.parsed]
            .filter(([, document]) =>
              document.nodes.some((node) => plan.deletion!.ids.includes(node.key))
            )
            .map(([path]) => path)
        )
      : selected.files,
    outgoingKeys: sorted(changes.map((change) => change.key)),
    reconcileIds,
    verificationIds: verificationClosure(context, { ...plan, changes }, reconcileIds),
  };
  for (const [path, document] of context.parsed)
    if (
      !selection.files.includes(path) &&
      selection.files.includes(context.state.entries[document.metadata!.root]!.path)
    )
      throw new Error('Select every document involved in a path swap');
  return { ...plan, changes, selection };
}
