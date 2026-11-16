import { z } from 'zod';
import { idSchema } from './identity.js';
import { hash, type FeedbackRoles, type WorkspaceBackend, type WorkspaceRem } from './types.js';

export const feedbackRolesSchema = z
  .object({ todoTagId: idSchema, doneTagId: idSchema })
  .strict()
  .refine((value) => value.todoTagId !== value.doneTagId, 'Feedback roles must be distinct IDs');
export const feedbackPartitionSchema = z
  .object({
    roles: feedbackRolesSchema,
    attachmentIds: z.array(idSchema),
  })
  .strict();

export function contentChildren(rem: WorkspaceRem): string[] {
  return rem.children.filter((id) => !rem.feedback?.attachmentIds.includes(id));
}
export function contentTags(rem: WorkspaceRem, roles = rem.feedback?.roles) {
  return rem.tags?.filter((id) => id !== roles?.todoTagId && id !== roles?.doneTagId) ?? rem.tags;
}

/** One bounded physical tree; references are never traversed as ownership edges. */
export async function readAttachment(
  backend: WorkspaceBackend,
  rootId: string,
  parentId: string,
  roles: FeedbackRoles,
  canonical: ReadonlySet<string>,
  owned: Set<string> = new Set()
): Promise<WorkspaceRem[]> {
  const queue = [{ id: rootId, parent: parentId, depth: 0 }],
    result: WorkspaceRem[] = [];
  while (queue.length) {
    const { id, parent, depth } = queue.shift()!;
    if (canonical.has(id) || owned.has(id) || depth > 64 || owned.size >= 1000)
      throw new Error('Unsafe feedback ownership: canonical member, duplicate, cycle or bound');
    owned.add(id);
    const values = await backend.read([id], { tags: true });
    const rem = values[0];
    if (
      values.length !== 1 ||
      !rem ||
      rem.id !== id ||
      rem.parent !== parent ||
      new Set(rem.children).size !== rem.children.length ||
      rem.type !== null ||
      rem.cardItem !== false ||
      rem.document !== false ||
      rem.folder !== false ||
      rem.backText !== null ||
      !Array.isArray(rem.cards) ||
      rem.cards.length ||
      rem.unsupported ||
      rem.portal != null ||
      !Array.isArray(rem.tags) ||
      !Array.isArray(rem.text) ||
      rem.text.some(
        (part) =>
          typeof part !== 'string' &&
          !(
            part &&
            typeof part === 'object' &&
            'i' in part &&
            part.i === 'q' &&
            '_id' in part &&
            idSchema.safeParse(part._id).success &&
            Object.keys(part).every((key) => key === 'i' || key === '_id')
          )
      )
    )
      throw new Error(
        'Unsupported feedback shape: require an observed non-card plain physical tree'
      );
    if (id === rootId && !rem.tags.includes(roles.todoTagId) && !rem.tags.includes(roles.doneTagId))
      throw new Error('Unbound native child is not an exact TODO/DONE feedback attachment');
    result.push(rem);
    queue.push(...rem.children.map((child) => ({ id: child, parent: id, depth: depth + 1 })));
  }
  for (const rem of result)
    for (const part of rem.text as Array<string | { i: 'q'; _id: string }>)
      if (typeof part !== 'string' && !canonical.has(part._id) && !owned.has(part._id))
        throw new Error(
          'Feedback reference target is outside the proven canonical/attachment identities'
        );
  return result;
}

/** Ordinary sync reads only unexpected physical children under selected exact canonical IDs. */
export async function partitionRemote(
  remote: Map<string, WorkspaceRem>,
  canonical: ReadonlySet<string>,
  roles: FeedbackRoles | undefined,
  backend: WorkspaceBackend
): Promise<void> {
  if (!roles) return;
  feedbackRolesSchema.parse(roles);
  const owned = new Set<string>();
  for (const [id, rem] of remote) {
    if (!canonical.has(id)) continue;
    const attachmentIds = rem.children.filter((child) => !canonical.has(child));
    if (new Set(rem.children).size !== rem.children.length)
      throw new Error('Duplicate physical children in feedback partition');
    if (attachmentIds.length && (rem.type === 6 || rem.portal != null || rem.unsupported))
      throw new Error('Feedback under opaque/Portal parents is unsupported');
    for (const child of attachmentIds)
      await readAttachment(backend, child, id, roles, canonical, owned);
    remote.set(id, { ...rem, feedback: { roles, attachmentIds } });
  }
}

/** Ack lifecycle mutations do not change the captured content/ownership revision. */
export function feedbackRevision(rems: WorkspaceRem[], roles: FeedbackRoles): string {
  return hash(
    rems.map((rem, index) => ({
      id: rem.id,
      parent: rem.parent,
      children: rem.children,
      text: rem.text,
      backText: rem.backText,
      type: rem.type,
      tags: index === 0 ? contentTags(rem, roles) : rem.tags,
      cardItem: rem.cardItem,
      cards: rem.cards,
      document: rem.document,
      folder: rem.folder,
      powerups: rem.powerups,
      propertyValues: rem.propertyValues,
      references: rem.references,
      facts: Object.fromEntries(
        Object.entries(rem.facts ?? {}).filter(
          ([key]) =>
            ![
              'createdAt',
              'updatedAt',
              'localUpdatedAt',
              ...(index === 0 ? ['todoStatus'] : []),
            ].includes(key)
        )
      ),
    }))
  );
}
