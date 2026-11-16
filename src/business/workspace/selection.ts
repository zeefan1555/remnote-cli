import { lstat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { isContentMarkdown } from './files.js';
import type { LocalContext } from './local.js';
import type { SyncSelection, WorkspacePlan, WorkspaceRem } from './types.js';
import { registerTagIds } from './tags.js';
import { deletionPath, requireSelectedDeletionFeedback } from './deletion.js';

export interface SelectionOptions {
  scope?: 'changed' | 'all';
  paths?: string[];
}

const sorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();

/** Select tracked files, including missing ones, or existing directories. */
export async function selectFiles(context: LocalContext, values: string[] = []) {
  const files = [...new Set([...context.parsed.keys(), ...context.missing])].sort();
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
        let stat;
        try {
          stat = await lstat(join(context.state.directory, ...parts.slice(0, index)));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' && context.missing.includes(path))
            break;
          throw error;
        }
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
  const candidateIds = new Set(candidates),
    required = new Set(candidates),
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
    for (const tag of change.tags?.after ?? []) ancestors(tag);
  }
  return sorted(required).filter((id) => !candidateIds.has(id));
}

/** Public proof includes unknown native flags; it is not the narrower full-native guard set. */
export function publicVerificationIds(
  context: LocalContext,
  plan: WorkspacePlan,
  observed: Map<string, WorkspaceRem>,
  publicationIds: string[],
  requiredIds: string[]
): string[] {
  if (plan.selection?.scope !== 'changed' || plan.guarded || plan.deletion)
    return sorted(observed.keys());
  const seeds = sorted([
    ...publicationIds,
    ...requiredIds,
    ...(plan.selection.verificationIds ?? []),
    ...plan.changes.flatMap((change) => [change.key, ...(change.parent ? [change.parent] : [])]),
  ]).filter((id) => !id.startsWith('new:'));
  const after = new Map([...context.native, ...observed]);
  for (const change of plan.changes) {
    const rem = after.get(change.key);
    if (rem)
      after.set(change.key, {
        ...rem,
        ...change.fields,
        ...(change.tags ? { tags: change.tags.after } : {}),
      });
  }
  const required = new Set(seeds);
  // This closure belongs only to the later changed-mode verification scope. It does not alter
  // discovery selection, original plan/input hashes or all/guarded/delete proof policies.
  let previousSize: number;
  do {
    previousSize = required.size;
    for (const native of [context.native, new Map([...context.native, ...observed]), after]) {
      for (const id of required) {
        const rem = native.get(id);
        if (!rem) continue;
        for (const dependency of verificationClosure({ ...context, native }, plan, [id]))
          required.add(dependency);
        for (const tag of [
          ...(rem.tags ?? []),
          ...plan.changes.flatMap((change) => change.tags?.before ?? []),
        ]) {
          if (native.has(tag)) {
            required.add(tag);
            for (const ancestor of verificationClosure(
              { ...context, native },
              { ...plan, changes: [] },
              [tag]
            ))
              required.add(ancestor);
          }
        }
      }
    }
  } while (required.size !== previousSize);
  return sorted(required);
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
  const deletedIds = (plan.deletion?.ids ?? []).filter((id) =>
    selected.files.includes(deletionPath(context, id))
  );
  const anyNew = [...context.parsed.values()].some((document) =>
    document.nodes.some((node) => node.key.startsWith('new:'))
  );
  const selectedNew = changes.some((change) => change.key.startsWith('new:'));
  if ((deletedIds.length && anyNew) || (selectedNew && plan.deletion?.ids.length))
    throw new Error(
      'MISSING_ID: deletion and new nodes are ambiguous; split into separate synchronizations'
    );
  const deleted = new Set(deletedIds);
  for (const id of deletedIds)
    if (context.native.get(id)!.children.some((child) => !deleted.has(child)))
      throw new Error('Select all locally deleted descendant documents together');
  const deletion = deletedIds.length
    ? {
        roots: deletedIds
          .filter((id) => !deleted.has(context.native.get(id)!.parent ?? ''))
          .map((id) => ({ id, parent: context.native.get(id)!.parent })),
        ids: deletedIds,
      }
    : undefined;
  if (deletion) requireSelectedDeletionFeedback(context, deletion);
  const publicationFiles = new Set(selected.files);
  for (const root of deletion?.roots ?? []) {
    const parentPath =
      root.parent && context.state.entries[root.parent]
        ? deletionPath(context, root.parent)
        : undefined;
    if (parentPath && !publicationFiles.has(parentPath)) {
      if (context.dirty.includes(parentPath))
        throw new Error(
          `Select the dirty parent document before deleting its mounted child: ${parentPath}`
        );
      publicationFiles.add(parentPath);
    }
  }
  const candidates = [
    ...deletedIds,
    ...[...context.parsed]
      .filter(
        ([path]) =>
          selected.files.includes(path) && (options.scope === 'all' || context.dirty.includes(path))
      )
      .flatMap(([, doc]) =>
        doc.nodes
          .filter((node) => node.kind !== 'mount' && !node.key.startsWith('new:'))
          .map((node) => node.key)
      ),
  ];
  const reconcileIds = sorted(candidates);
  const feedbackRoleIds =
    deletion && context.state.feedbackRoles
      ? [context.state.feedbackRoles.todoTagId, context.state.feedbackRoles.doneTagId]
      : [];
  if (deletion) {
    const roleLineage = new Set<string>();
    for (const role of feedbackRoleIds)
      for (let id: string | null = role; id; id = context.native.get(id)?.parent ?? null)
        roleLineage.add(id);
    if (changes.some((change) => roleLineage.has(change.key)))
      throw new Error('Cannot change a feedback role or its ancestor in a deletion batch');
  }
  const selection: SyncSelection = {
    scope: options.scope ?? 'changed',
    paths: selected.paths,
    files: sorted(publicationFiles),
    outgoingKeys: sorted(changes.map((change) => change.key)),
    reconcileIds,
    verificationIds: sorted([
      ...feedbackRoleIds,
      ...verificationClosure(context, { ...plan, changes }, [
        ...deletedIds,
        ...feedbackRoleIds,
        ...changes.filter((change) => !change.key.startsWith('new:')).map((change) => change.key),
      ]),
    ]).filter((id) => !reconcileIds.includes(id)),
  };
  for (const [path, document] of context.parsed)
    if (
      !selection.files.includes(path) &&
      selection.files.includes(context.state.entries[document.metadata!.root]!.path)
    )
      throw new Error('Select every document involved in a path swap');
  const registered = registerTagIds(
    context.native,
    changes.flatMap((change) => change.tags?.after ?? []),
    context.state.tagIds
  );
  const tagIds = Object.fromEntries(
    Object.entries(registered).filter(
      ([token]) => !Object.hasOwn(context.state.tagIds ?? {}, token)
    )
  );
  const { deletion: _allDeletions, ...rest } = plan;
  return {
    ...rest,
    changes,
    selection,
    ...(deletion ? { deletion } : {}),
    ...(Object.keys(tagIds).length ? { tagIds } : {}),
  };
}
