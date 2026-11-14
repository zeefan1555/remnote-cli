import { z } from 'zod';
import { idSchema } from './identity.js';
import { normalizeRichText } from './markdown.js';
import { hash, type WorkspaceRem } from './types.js';

/** Keep explicit serializer values in backups; only known public fields are decoded for editing. */
export function decodePublic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodePublic);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  if (object.$type === 'undefined' && Object.keys(object).length === 1) return undefined;
  return Object.fromEntries(
    Object.entries(object).map(([key, child]) => [key, decodePublic(child)])
  );
}

export function withPublicSnapshot(
  before: WorkspaceRem,
  snapshot: Record<string, unknown>
): WorkspaceRem {
  if (snapshot.$type !== 'rem' || snapshot.id !== before.id)
    throw new Error('Public snapshot identity mismatch');
  const raw = decodePublic(snapshot) as Record<string, unknown>;
  return {
    ...before,
    parent: idSchema.nullable().parse(raw.parent),
    children: z.array(idSchema).parse(raw.children),
    type: raw.type == null ? null : z.union([z.number().int(), z.string()]).parse(raw.type),
    text: raw.text ?? null,
    backText: raw.backText ?? null,
    public: snapshot,
  };
}

/** A targeted SDK read cannot erase supplemental facts which that read did not collect. */
export function withNativeSnapshot(before: WorkspaceRem, snapshot: WorkspaceRem): WorkspaceRem {
  if (before.id !== snapshot.id) throw new Error('Native snapshot identity mismatch');
  return {
    ...before,
    ...snapshot,
    unsupported: snapshot.unsupported,
    ...(before.facts || snapshot.facts ? { facts: { ...before.facts, ...snapshot.facts } } : {}),
    ...(before.collected || snapshot.collected
      ? {
          collected: [
            ...new Set([...(before.collected ?? []), ...(snapshot.collected ?? [])]),
          ].sort(),
        }
      : {}),
  };
}

export function contentProjection(rem: WorkspaceRem): unknown {
  return { text: normalizeRichText(rem.text), backText: normalizeRichText(rem.backText) };
}

export function publicRevision(rem: WorkspaceRem): unknown {
  return {
    id: rem.id,
    parent: rem.parent,
    children: rem.children,
    type: rem.type,
    content: contentProjection(rem),
  };
}

export function cardIdentities(rem: WorkspaceRem): unknown {
  return (
    rem.cards
      ?.map(({ id, remId, type }) => ({ id, remId, type }))
      .sort((a, b) => a.id.localeCompare(b.id)) ?? null
  );
}

/** Client revision checks exclude review history, scheduling and arrival timestamps; native writes remain non-atomic. */
export function immutableProjection(rem: WorkspaceRem): Record<string, unknown> {
  const facts = Object.fromEntries(
    Object.entries(rem.facts ?? {}).filter(
      ([key]) => !['createdAt', 'localUpdatedAt', 'updatedAt'].includes(key)
    )
  );
  return {
    id: rem.id,
    parent: rem.parent,
    type: rem.type,
    document: rem.document,
    folder: rem.folder,
    cardItem: rem.cardItem,
    practice: rem.practice,
    enablePractice: rem.enablePractice,
    unsupported: rem.unsupported ?? '',
    facts,
    tags: rem.tags ?? null,
    powerups: rem.powerups ?? null,
    propertyValues: rem.propertyValues ?? null,
    portal: rem.portal ?? null,
    cards: cardIdentities(rem),
  };
}

export function revisionHash(rem: WorkspaceRem): string {
  const { cards: _cards, ...immutable } = immutableProjection(rem);
  return hash({ public: publicRevision(rem), immutable });
}

export function publicationRevisionHash(rem: WorkspaceRem): string {
  return hash([revisionHash(rem), cardIdentities(rem)]);
}

export function remoteEditedAt(rem: WorkspaceRem): number | null {
  const value = rem.public?.updatedAt;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
