import type { LocalContext } from './local.js';
import { nodeKind } from './markdown.js';
import { hash, type WorkspaceRem } from './types.js';

function plainText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(plainText).join('');
  if (value && typeof value === 'object') {
    const part = value as Record<string, unknown>;
    return typeof part.text === 'string' ? part.text : '';
  }
  return '';
}

function referenceIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(referenceIds);
  if (!value || typeof value !== 'object') return [];
  const part = value as Record<string, unknown>;
  if (part.i === 'q' && typeof part._id === 'string') return [part._id];
  return [];
}

export function nativeProof(rem: WorkspaceRem) {
  const cards = rem.cards;
  return {
    cardIds: cards?.map((card) => card.id).sort() ?? null,
    reviewHash:
      cards && cards.every((card) => Array.isArray(card.repetitionHistory))
        ? hash(
            cards
              .map(({ id, remId, type, createdAt, repetitionHistory }) => ({
                id,
                remId,
                type,
                createdAt,
                repetitionHistory,
              }))
              .sort((a, b) => a.id.localeCompare(b.id))
          )
        : null,
  };
}

export function nativeOutline(rem: WorkspaceRem, native: Map<string, WorkspaceRem>) {
  const projection = {
    text: plainText(rem.text),
    kind: nodeKind(rem, native),
    parent: rem.parent,
    children: rem.children,
    tags: rem.tags ?? null,
    document: rem.document,
    folder: rem.folder,
    cardItem: rem.cardItem,
    ...nativeProof(rem),
    cards: rem.cards ?? null,
    powerups: {
      ...Object.fromEntries((rem.powerups ?? []).map(({ code }) => [code, true])),
      ...rem.powerupPresence,
    },
    pinned: null,
    references: [...new Set(referenceIds([rem.text, rem.backText]))].map((id) => ({
      id,
      resolved: native.has(id),
    })),
  };
  return { ...projection, revisionHash: hash(projection) };
}

/** Selected local intent plus sealed native observations and exact direct-tag ancestors. */
export function workspaceOutline(context: LocalContext, path: string) {
  const document = context.parsed.get(path);
  if (!document) throw new Error('Outline requires an exact tracked Markdown path');
  const nodes: Record<string, unknown> = {};
  const localNodes = new Map(document.nodes.map((node) => [node.key, node]));
  for (const node of document.nodes) {
    if (node.kind === 'mount') continue;
    const rem = context.native.get(node.key),
      observed = rem ? nativeOutline(rem, context.native) : null;
    const parent = node.parent ? localNodes.get(node.parent) : undefined;
    nodes[node.key] = {
      key: node.key,
      id: rem?.id ?? null,
      path,
      line: node.line,
      ...(observed ?? { document: false, folder: false, cardIds: [], powerups: {}, pinned: null }),
      text: plainText(node.text),
      kind: node.kind,
      parent: node.parent,
      children: node.children,
      cardItem: rem ? rem.cardItem : parent?.kind === 'multiline',
      tags: node.tags ?? rem?.tags ?? null,
      ...(node.cardCluster ? { intent: { cardCluster: true }, powerups: { cc: true } } : {}),
      references: [...new Set(referenceIds([node.text, node.backText]))].map((id) => ({
        id,
        resolved: context.native.has(id),
      })),
      observed,
    };
  }
  for (const node of document.nodes)
    for (const tag of node.tags ?? context.native.get(node.key)?.tags ?? []) {
      const seen = new Set<string>();
      for (let id: string | null = tag; id && !seen.has(id);) {
        seen.add(id);
        const rem = context.native.get(id);
        if (!rem) break;
        if (!nodes[id]) {
          const observed = nativeOutline(rem, context.native);
          nodes[id] = {
            key: id,
            id,
            path: context.state.entries[id]?.path ?? null,
            line: null,
            ...observed,
            observed,
          };
        }
        id = rem.parent;
      }
    }
  return { schema: 'remnote-outline/1', path, nodes };
}

export function outlineIds(context: LocalContext, path: string): string[] {
  return Object.keys(workspaceOutline(context, path).nodes)
    .filter((id) => context.native.has(id))
    .sort();
}

export function knownPowerupCodes(native: Map<string, WorkspaceRem>): Record<string, string[]> {
  return Object.fromEntries(
    [...native].map(([id, rem]) => [
      id,
      [
        ...new Set([
          ...(rem.powerups ?? []).map(({ code }) => code),
          ...Object.keys(rem.powerupPresence ?? {}),
        ]),
      ].sort(),
    ])
  );
}
