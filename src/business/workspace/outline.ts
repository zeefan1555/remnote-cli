import type { LocalContext } from './local.js';
import { nodeKind } from './markdown.js';
import { publicationRevisionHash } from './snapshots.js';
import type { WorkspaceRem } from './types.js';

const plain = (value: unknown): string =>
  Array.isArray(value)
    ? value
        .map((part) =>
          typeof part === 'string'
            ? part
            : part && typeof part === 'object' && typeof part.text === 'string'
              ? part.text
              : ''
        )
        .join('')
    : '';
const references = (value: unknown) =>
  Array.isArray(value)
    ? value.flatMap((part) =>
        part && typeof part === 'object' && part.i === 'q' && typeof part._id === 'string'
          ? [part._id as string]
          : []
      )
    : [];

export interface OutlineProjectionNode {
  id: string | null;
  key: string;
  path: string;
  line: number;
  kind: string;
  text: string;
  children: string[];
  parent: string | null;
  document: boolean | null;
  folder: boolean | null;
  pinned: null;
  tags: string[] | null;
  powerups: Record<string, boolean> | null;
  cardIds: string[] | null;
  cards: WorkspaceRem['cards'] | null;
  references: Array<{ id: string; resolved: boolean }>;
  observed: {
    tags: string[] | null;
    powerups: Record<string, boolean> | null;
    cardIds: string[] | null;
    cards: WorkspaceRem['cards'] | null;
    document: boolean | null;
    folder: boolean | null;
    pinned: null;
    kind: string | null;
    text: string;
    children: string[];
    parent: string | null;
    references: Array<{ id: string; resolved: boolean }>;
    revisionHash: string | null;
  };
}

/** Parsed local intent and explicitly labeled sealed native facts; never a live SDK observation. */
export function projectOutline(context: LocalContext, path: string) {
  const parsed = new Map(
    [...context.parsed].flatMap(([path, doc]) =>
      doc.nodes
        .filter((node) => node.kind !== 'mount')
        .map((node) => [node.key, { node, path }] as const)
    )
  );
  const keys = new Set(context.parsed.get(path)!.nodes.map((node) => node.key));
  for (const key of keys) {
    const node = parsed.get(key)?.node,
      rem = context.native.get(key);
    for (const id of [
      node?.parent ?? rem?.parent,
      ...(node?.relations?.tags ?? rem?.tags ?? []),
      ...references(node?.text ?? rem?.text),
      ...references(node?.backText ?? rem?.backText),
    ])
      if (id && context.native.has(id)) keys.add(id);
  }
  const nodes: Record<string, OutlineProjectionNode> = {};
  for (const key of keys) {
    const local = parsed.get(key),
      node = local?.node,
      rem = context.native.get(key);
    const observed = {
      tags: rem?.tags ?? null,
      powerups:
        rem?.powerupStates ??
        (rem?.powerups
          ? Object.fromEntries(rem.powerups.map((value) => [value.code, true]))
          : null),
      cardIds: rem?.cards?.map((card) => card.id) ?? null,
      cards: rem?.cards ?? null,
      document: rem?.document ?? null,
      folder: rem?.folder ?? null,
      pinned: null,
      kind: rem ? nodeKind(rem, context.native) : null,
      text: plain(rem?.text),
      children: rem?.children ?? [],
      parent: rem?.parent ?? null,
      references: [...references(rem?.text), ...references(rem?.backText)].map((id) => ({
        id,
        resolved: context.native.has(id),
      })),
      revisionHash: rem ? publicationRevisionHash(rem) : null,
    };
    nodes[key] = {
      id: rem?.id ?? null,
      key,
      path: local?.path ?? context.state.entries[key]?.path ?? path,
      line: node?.line ?? 1,
      ...observed,
      kind: node?.kind ?? (rem ? nodeKind(rem, context.native) : 'text'),
      text: plain(node?.kind === 'opaque' ? rem?.text : (node?.text ?? rem?.text)),
      children: node?.children ?? rem?.children ?? [],
      parent: node?.parent ?? rem?.parent ?? null,
      tags: node?.relations?.tags ?? observed.tags,
      powerups: node?.relations?.powerups
        ? { ...observed.powerups, ...node.relations.powerups }
        : observed.powerups,
      references: [
        ...references(node?.text ?? rem?.text),
        ...references(node?.backText ?? rem?.backText),
      ].map((id) => ({ id, resolved: context.native.has(id) })),
      observed,
    };
  }
  return {
    schema: 'remnote-outline/1' as const,
    observation: 'sealed-local-baseline' as const,
    nodes,
  };
}
