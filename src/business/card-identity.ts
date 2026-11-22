import type { PluginCardType } from '@remnote/plugin-sdk';

export interface CardIdentitySource {
  _id?: string;
  remId?: string;
  type?: unknown;
  createdAt?: number;
  repetitionHistory?: unknown[];
  nextRepetitionTime?: number;
  lastRepetitionTime?: number;
  timesWrongInRow?: number;
}

export interface InspectedRawCard {
  id: string;
  remId: string;
  type: PluginCardType;
  createdAt: number | null;
  repetitionHistory: unknown[] | null;
  nextRepetitionTime: number | null;
  lastRepetitionTime: number | null;
  timesWrongInRow: number | null;
}

/** Copy SDK facts so a later write cannot mutate the before snapshot. */
export function snapshotCardIdentity(card: CardIdentitySource, remId: string): InspectedRawCard {
  if (!card || typeof card._id !== 'string' || !card._id || card.remId !== remId)
    throw new Error('SDK raw card identity/owner malformed');
  const type = card.type;
  if (
    type !== 'forward' &&
    type !== 'backward' &&
    !(
      type &&
      typeof type === 'object' &&
      'clozeId' in type &&
      typeof type.clozeId === 'string' &&
      Object.keys(type).length === 1
    )
  )
    throw new Error('SDK raw card type malformed');
  if (card.repetitionHistory != null && !Array.isArray(card.repetitionHistory))
    throw new Error('SDK raw card history malformed');
  const number = (value: unknown): number | null => {
    if (value == null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error('SDK raw card timestamp/count malformed');
    return value;
  };
  return structuredClone({
    id: card._id,
    remId: card.remId,
    type: type as PluginCardType,
    createdAt: number(card.createdAt),
    repetitionHistory: card.repetitionHistory ?? null,
    nextRepetitionTime: number(card.nextRepetitionTime),
    lastRepetitionTime: number(card.lastRepetitionTime),
    timesWrongInRow: number(card.timesWrongInRow),
  });
}
