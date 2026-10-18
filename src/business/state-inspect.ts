import type { ReactRNPlugin, RichTextInterface } from '@remnote/plugin-sdk';
import { hasCardStructure } from './card-structure.js';
import { contentHash } from './content-hash.js';
import { plainText } from './plain-text.js';
import { sdkSafeRichText } from './sdk-rich-text.js';
import { builtinSlotName } from './powerup-read.js';
import { summarizeRichText, type RichTextElementSummary } from './rich-text-elements.js';
import { BuiltInPowerupCodes, RemType } from './sdk-constants.generated.js';

export const INSPECT_FIELDS = [
  'type',
  'text',
  'backText',
  'elements',
  'markdown',
  'isCardItem',
  'hasCardStructure',
  'practiceDirection',
  'enablePractice',
  'cards',
  'tags',
  'parent',
  'children',
  'aliases',
  'sources',
  'portal',
] as const;
export type InspectField = (typeof INSPECT_FIELDS)[number];

const SUMMARY_OMIT = new Set<InspectField>(['text', 'backText', 'markdown']);
const PRACTICE = new Set(['forward', 'backward', 'both', 'none']);
const PORTAL_TYPE_NAME: Record<number, string> = {
  0: 'portal',
  2: 'embeddedQueue',
  3: 'scaffold',
  4: 'searchPortal',
};
const MAX_ANCESTORS = 30;
const MAX_OUTPUT_BYTES = 1_000_000;
/**
 * In-flight SDK reads in one bridge session. Responses are matched by id, and RemNote
 * interleaves read promises, so a wider cap overlaps per-call latency.
 */
export const INSPECT_CONCURRENCY = 32;

function createLimiter(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    while (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

function classifyPortalType(raw: unknown): {
  portalType: string | null;
  portalTypeCode: number | null;
} {
  if (typeof raw === 'number' && Object.hasOwn(PORTAL_TYPE_NAME, raw))
    return { portalType: PORTAL_TYPE_NAME[raw] ?? null, portalTypeCode: raw };
  return { portalType: null, portalTypeCode: null };
}

async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: items.length === 0 ? 0 : workers }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await fn(items[index]!, index);
      }
    })
  );
  return results;
}

export interface InspectStateParams {
  remIds: string[];
  descendants?: number;
  fields?: InspectField[];
  summary?: boolean;
  /** Test seam. The CLI schema does not accept this. */
  maxRems?: number;
}

export interface InspectPathNode {
  id: string;
  name: string;
  type: string;
}

export interface InspectedCard {
  id: string;
  type: unknown;
  due: number | null;
  nextRepetition: number | null;
  historyLength: number;
  hash: string;
}

export interface InspectedTag extends InspectPathNode {
  ancestors: InspectPathNode[];
}

export interface InspectedPortal {
  /** Known portal kind, or null when the SDK value is not one of the classified codes. */
  portalType: string | null;
  portalTypeCode: number | null;
  /** Value returned by getPortalType, including values that are not a classified code. */
  portalTypeRaw: unknown;
  includedIds: string[];
  query: unknown;
  filter: unknown;
}

export interface InspectFieldError {
  field: string;
  message: string;
}

export interface InspectedRem {
  id: string;
  missing?: boolean;
  type?: string | null;
  text?: unknown;
  backText?: unknown;
  elements?: { text: RichTextElementSummary; backText: RichTextElementSummary } | null;
  markdown?: string | null;
  backMarkdown?: string | null;
  isCardItem?: boolean | null;
  hasCardStructure?: boolean | null;
  practiceDirection?: string | null;
  enablePractice?: boolean | null;
  cards?: InspectedCard[] | null;
  tags?: InspectedTag[] | null;
  parent?: InspectPathNode[] | null;
  children?: string[] | null;
  aliases?: string[] | null;
  sources?: Array<{ id: string; name: string }> | null;
  portal?: InspectedPortal | null;
  errors?: InspectFieldError[];
}

export interface InspectStateResult {
  schemaVersion: 1;
  complete: boolean;
  truncated: boolean;
  rems: InspectedRem[];
  errors: Array<{ id?: string; field?: string; message: string }>;
}

interface LoadedRem {
  _id: string;
  type?: number;
  text?: RichTextInterface;
  backText?: RichTextInterface;
  parent?: unknown;
  isFolder: () => Promise<boolean>;
  isDocument: () => Promise<boolean>;
  isCardItem: () => Promise<boolean>;
  hasPowerup: (code: string) => Promise<boolean>;
  getChildrenRem: () => Promise<LoadedRem[]>;
  getTagRems: () => Promise<LoadedRem[]>;
  getAliases: () => Promise<Array<{ text?: RichTextInterface }>>;
  getSources: () => Promise<LoadedRem[]>;
  getCards: () => Promise<LoadedCard[]>;
  getPracticeDirection: () => Promise<string>;
  getEnablePractice: () => Promise<boolean>;
  getPortalType: () => Promise<number>;
  getPortalDirectlyIncludedRem: () => Promise<LoadedRem[]>;
  getPowerupProperty: (powerupCode: string, powerupSlot: string) => Promise<unknown>;
}

interface LoadedCard {
  _id?: string;
  remId?: string;
  type?: unknown;
  nextRepetitionTime?: number;
  repetitionHistory?: unknown[];
}

interface LoadedPlugin {
  rem: {
    findMany: (ids: string[]) => Promise<LoadedRem[] | undefined>;
  };
  richText: ReactRNPlugin['richText'];
}

function assertParams(params: InspectStateParams): { descendants: number; maxRems: number } {
  const ids = params.remIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100)
    throw new Error('Provide 1 to 100 Rem IDs');
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate Rem IDs');
  for (const id of ids)
    if (typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 256)
      throw new Error('Invalid Rem ID');
  const descendants = params.descendants ?? 0;
  if (!Number.isInteger(descendants) || descendants < 0 || descendants > 20)
    throw new Error('Invalid descendants');
  if (
    params.fields !== undefined &&
    (!Array.isArray(params.fields) ||
      params.fields.length < 1 ||
      params.fields.some((field) => !INSPECT_FIELDS.includes(field)))
  )
    throw new Error('Invalid fields');
  const maxRems = params.maxRems ?? 1000;
  if (!Number.isInteger(maxRems) || maxRems < 1 || maxRems > 1000)
    throw new Error('Invalid maxRems');
  return { descendants, maxRems };
}

/** Fields to fetch and return. An explicit list wins over `--summary`. */
export function requestedFields(params: {
  fields?: InspectField[];
  summary?: boolean;
}): Set<InspectField> {
  if (params.fields?.length) return new Set(params.fields);
  const fields = new Set<InspectField>(INSPECT_FIELDS);
  if (params.summary) for (const field of SUMMARY_OMIT) fields.delete(field);
  return fields;
}

function parentPointer(rem: LoadedRem): string | undefined {
  return typeof rem.parent === 'string' && rem.parent ? rem.parent : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireRemArray(value: unknown, label: string): LoadedRem[] {
  if (!Array.isArray(value)) throw new Error(`SDK ${label} did not return a Rem array`);
  for (const rem of value)
    if (!rem || typeof rem !== 'object' || typeof rem._id !== 'string' || !rem._id)
      throw new Error(`SDK ${label} returned a malformed Rem`);
  return value as LoadedRem[];
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`SDK ${label} did not return a boolean`);
  return value;
}

/**
 * Read many Rems in one plugin session.
 * Requested IDs are loaded with one `findMany` batch. Descendant, tag, and ancestor
 * IDs discovered afterwards are loaded with further `findMany` batches, not per-ID `findOne`.
 */
export async function inspectState(
  plugin: ReactRNPlugin,
  params: InspectStateParams
): Promise<InspectStateResult> {
  const { descendants, maxRems } = assertParams(params);
  const fields = requestedFields(params);
  const source = plugin as unknown as LoadedPlugin;
  const cache = new Map<string, LoadedRem>();
  const failed = new Set<string>();
  const childIds = new Map<string, string[]>();
  const childErrors = new Map<string, string>();
  const tagCache = new Map<string, LoadedRem[]>();
  const tagErrors = new Map<string, string>();
  const kinds = new Map<string, string>();
  const names = new Map<string, string>();
  const gate = createLimiter(INSPECT_CONCURRENCY);
  const result: InspectStateResult = {
    schemaVersion: 1,
    complete: true,
    truncated: false,
    rems: [],
    errors: [],
  };

  const loadMany = async (ids: string[]): Promise<void> => {
    const missing = [...new Set(ids)].filter((id) => !cache.has(id) && !failed.has(id));
    for (let offset = 0; offset < missing.length; offset += 100) {
      const slice = missing.slice(offset, offset + 100);
      try {
        const found = await gate(() => source.rem.findMany(slice));
        if (found !== undefined && !Array.isArray(found))
          throw new Error('SDK did not return a Rem array');
        for (const rem of found ?? [])
          if (rem && typeof rem._id === 'string' && slice.includes(rem._id))
            cache.set(rem._id, rem);
        for (const id of slice) if (!cache.has(id)) failed.add(id);
      } catch (error) {
        for (const id of slice) failed.add(id);
        result.complete = false;
        result.errors.push({ message: `batch_read_failed: ${messageOf(error)}` });
      }
    }
  };

  await loadMany(params.remIds);

  const childJobs = new Map<string, Promise<string[]>>();
  const childrenOf = (rem: LoadedRem): Promise<string[]> => {
    const existing = childJobs.get(rem._id);
    if (existing) return existing;
    const job = (async () => {
      const cached = childIds.get(rem._id);
      if (cached) return cached;
      const failedChildren = childErrors.get(rem._id);
      if (failedChildren) throw new Error(failedChildren);
      const list = requireRemArray(await gate(() => rem.getChildrenRem()), 'children');
      const ids = list.map((child) => {
        cache.set(child._id, child);
        return child._id;
      });
      childIds.set(rem._id, ids);
      return ids;
    })();
    childJobs.set(rem._id, job);
    return job;
  };

  const ordered = [...params.remIds];
  const seen = new Set(params.remIds);
  let frontier = params.remIds.filter((id) => cache.has(id));
  for (let depth = 0; depth < descendants && frontier.length > 0 && !result.truncated; depth += 1) {
    const lists = await mapBounded(frontier, INSPECT_CONCURRENCY, async (id) => {
      const rem = cache.get(id);
      if (!rem) return [] as string[];
      try {
        return await childrenOf(rem);
      } catch (error) {
        childErrors.set(id, messageOf(error));
        result.complete = false;
        return [] as string[];
      }
    });
    const next: string[] = [];
    for (const ids of lists)
      for (const id of ids) {
        if (seen.has(id)) continue;
        if (ordered.length >= maxRems) {
          if (!result.truncated)
            result.errors.push({
              message: 'Stopped because the descendant walk reached the Rem limit',
            });
          result.truncated = true;
          result.complete = false;
          continue;
        }
        seen.add(id);
        ordered.push(id);
        next.push(id);
      }
    frontier = next;
  }

  if (fields.has('tags')) {
    await mapBounded(
      ordered.filter((id) => cache.has(id)),
      INSPECT_CONCURRENCY,
      async (id) => {
        try {
          const tags = requireRemArray(await gate(() => cache.get(id)!.getTagRems()), 'tags');
          tagCache.set(id, tags);
          for (const tag of tags) cache.set(tag._id, tag);
        } catch (error) {
          tagErrors.set(id, messageOf(error));
          result.complete = false;
        }
      }
    );
  }

  if (fields.has('parent') || fields.has('tags')) {
    const seeds: LoadedRem[] = [];
    for (const id of ordered) {
      const rem = cache.get(id);
      if (rem) seeds.push(rem);
    }
    for (const tags of tagCache.values()) seeds.push(...tags);
    let parents = [
      ...new Set(seeds.map(parentPointer).filter((id): id is string => Boolean(id))),
    ].filter((id) => !cache.has(id) && !failed.has(id));
    for (let depth = 0; depth < MAX_ANCESTORS && parents.length > 0; depth += 1) {
      await loadMany(parents);
      const next: string[] = [];
      for (const id of parents) {
        const rem = cache.get(id);
        const parent = rem ? parentPointer(rem) : undefined;
        if (parent && !cache.has(parent) && !failed.has(parent)) next.push(parent);
      }
      parents = [...new Set(next)];
    }
  }

  const kindJobs = new Map<string, Promise<string>>();
  const kindOf = (rem: LoadedRem): Promise<string> => {
    const existing = kindJobs.get(rem._id);
    if (existing) return existing;
    const job = (async () => {
      const cached = kinds.get(rem._id);
      if (cached) return cached;
      const [folder, document, daily] = await Promise.all([
        gate(() => rem.isFolder()),
        gate(() => rem.isDocument()),
        gate(() => rem.hasPowerup(BuiltInPowerupCodes.DailyDocument)),
      ]);
      const kind = requireBoolean(daily, 'daily document')
        ? 'dailyDocument'
        : requireBoolean(folder, 'folder')
          ? 'folder'
          : requireBoolean(document, 'document')
            ? 'document'
            : rem.type === RemType.CONCEPT
              ? 'concept'
              : rem.type === RemType.DESCRIPTOR
                ? 'descriptor'
                : rem.type === RemType.PORTAL
                  ? 'portal'
                  : 'text';
      kinds.set(rem._id, kind);
      return kind;
    })();
    kindJobs.set(rem._id, job);
    return job;
  };

  const nameJobs = new Map<string, Promise<string>>();
  const nameOf = (rem: LoadedRem): Promise<string> => {
    const existing = nameJobs.get(rem._id);
    if (existing) return existing;
    const job = (async () => {
      const cached = names.get(rem._id);
      if (cached !== undefined) return cached;
      const name = await gate(() => plainText(plugin, rem.text));
      names.set(rem._id, name);
      return name;
    })();
    nameJobs.set(rem._id, job);
    return job;
  };

  const ancestorJobs = new Map<string, Promise<InspectPathNode[]>>();
  const ancestorsOf = (rem: LoadedRem, stack?: ReadonlySet<string>): Promise<InspectPathNode[]> => {
    if (stack?.has(rem._id)) return Promise.reject(new Error('Ancestor cycle'));
    const existing = ancestorJobs.get(rem._id);
    if (existing) return existing;
    const next = new Set(stack);
    next.add(rem._id);
    const job = (async () => {
      const parentId = parentPointer(rem);
      if (!parentId) return [];
      const parent = cache.get(parentId);
      if (!parent) throw new Error(`Incomplete ancestor ${parentId}`);
      const above = await ancestorsOf(parent, next);
      if (above.length >= MAX_ANCESTORS) throw new Error('Ancestor depth exceeded');
      const [name, type] = await Promise.all([nameOf(parent), kindOf(parent)]);
      return [...above, { id: parent._id, name, type }];
    })();
    ancestorJobs.set(rem._id, job);
    return job;
  };

  const build = async (rem: LoadedRem): Promise<InspectedRem> => {
    const out: InspectedRem = { id: rem._id };
    const errors: InspectFieldError[] = [];
    const fail = (field: string, error: unknown) => {
      errors.push({ field, message: messageOf(error) });
      result.complete = false;
    };
    if (fields.has('text')) out.text = rem.text ?? null;
    if (fields.has('backText')) out.backText = rem.backText ?? null;
    if (fields.has('elements'))
      out.elements = {
        text: summarizeRichText(rem.text),
        backText: summarizeRichText(rem.backText),
      };
    const tasks: Array<Promise<void>> = [];
    if (fields.has('type'))
      tasks.push(
        (async () => {
          try {
            out.type = await kindOf(rem);
          } catch (error) {
            fail('type', error);
            out.type = null;
          }
        })()
      );
    if (fields.has('markdown'))
      tasks.push(
        (async () => {
          try {
            const [front, back] = await Promise.all([
              gate(() => source.richText.toMarkdown(sdkSafeRichText(rem.text))),
              gate(() => source.richText.toMarkdown(sdkSafeRichText(rem.backText))),
            ]);
            if (typeof front !== 'string' || typeof back !== 'string')
              throw new Error('SDK markdown did not return a string');
            out.markdown = front;
            out.backMarkdown = back;
          } catch (error) {
            fail('markdown', error);
            out.markdown = null;
            out.backMarkdown = null;
          }
        })()
      );
    if (fields.has('isCardItem') || fields.has('hasCardStructure'))
      tasks.push(
        (async () => {
          try {
            const cardItem = requireBoolean(await gate(() => rem.isCardItem()), 'card item');
            if (fields.has('isCardItem')) out.isCardItem = cardItem;
            if (fields.has('hasCardStructure'))
              out.hasCardStructure = hasCardStructure(rem.text, rem.backText, cardItem);
          } catch (error) {
            fail('isCardItem', error);
            if (fields.has('isCardItem')) out.isCardItem = null;
            if (fields.has('hasCardStructure')) out.hasCardStructure = null;
          }
        })()
      );
    if (fields.has('practiceDirection'))
      tasks.push(
        (async () => {
          try {
            const direction = await gate(() => rem.getPracticeDirection());
            if (!PRACTICE.has(direction)) throw new Error('SDK practice direction malformed');
            out.practiceDirection = direction;
          } catch (error) {
            fail('practiceDirection', error);
            out.practiceDirection = null;
          }
        })()
      );
    if (fields.has('enablePractice'))
      tasks.push(
        (async () => {
          try {
            out.enablePractice = requireBoolean(
              await gate(() => rem.getEnablePractice()),
              'enable practice'
            );
          } catch (error) {
            fail('enablePractice', error);
            out.enablePractice = null;
          }
        })()
      );
    if (fields.has('cards'))
      tasks.push(
        (async () => {
          try {
            const cards = await gate(() => rem.getCards());
            if (!Array.isArray(cards)) throw new Error('SDK cards malformed');
            out.cards = await Promise.all(
              cards.map(async (card) => {
                if (!card || typeof card._id !== 'string' || !card._id)
                  throw new Error('SDK card identity malformed');
                const history = Array.isArray(card.repetitionHistory) ? card.repetitionHistory : [];
                const due =
                  typeof card.nextRepetitionTime === 'number' ? card.nextRepetitionTime : null;
                return {
                  id: card._id,
                  type: card.type ?? null,
                  due,
                  nextRepetition: due,
                  historyLength: history.length,
                  hash: await contentHash({
                    cardId: card._id,
                    remId: card.remId ?? rem._id,
                    type: card.type ?? null,
                    history,
                  }),
                };
              })
            );
          } catch (error) {
            fail('cards', error);
            out.cards = null;
          }
        })()
      );
    if (fields.has('tags'))
      tasks.push(
        (async () => {
          try {
            const tagError = tagErrors.get(rem._id);
            if (tagError) throw new Error(tagError);
            const tags = tagCache.get(rem._id) ?? [];
            out.tags = await Promise.all(
              tags.map(async (tag) => {
                const [name, type, ancestors] = await Promise.all([
                  nameOf(tag),
                  kindOf(tag),
                  ancestorsOf(tag),
                ]);
                return { id: tag._id, name, type, ancestors };
              })
            );
          } catch (error) {
            fail('tags', error);
            out.tags = null;
          }
        })()
      );
    if (fields.has('parent'))
      tasks.push(
        (async () => {
          try {
            out.parent = await ancestorsOf(rem);
          } catch (error) {
            fail('parent', error);
            out.parent = null;
          }
        })()
      );
    if (fields.has('children'))
      tasks.push(
        (async () => {
          try {
            out.children = await childrenOf(rem);
          } catch (error) {
            fail('children', error);
            out.children = null;
          }
        })()
      );
    if (fields.has('aliases'))
      tasks.push(
        (async () => {
          try {
            const aliases = await gate(() => rem.getAliases());
            if (!Array.isArray(aliases)) throw new Error('SDK aliases malformed');
            out.aliases = await Promise.all(
              aliases.map((alias) =>
                gate(() =>
                  plainText(plugin, alias && typeof alias === 'object' ? alias.text : undefined)
                )
              )
            );
          } catch (error) {
            fail('aliases', error);
            out.aliases = null;
          }
        })()
      );
    if (fields.has('sources'))
      tasks.push(
        (async () => {
          try {
            const sources = requireRemArray(await gate(() => rem.getSources()), 'sources');
            for (const sourceRem of sources) cache.set(sourceRem._id, sourceRem);
            out.sources = await Promise.all(
              sources.map(async (sourceRem) => ({
                id: sourceRem._id,
                name: await nameOf(sourceRem),
              }))
            );
          } catch (error) {
            fail('sources', error);
            out.sources = null;
          }
        })()
      );
    if (fields.has('portal'))
      tasks.push(
        (async () => {
          try {
            const portalTyped = rem.type === RemType.PORTAL;
            const searchPortal = portalTyped
              ? true
              : requireBoolean(
                  await gate(() => rem.hasPowerup(BuiltInPowerupCodes.SearchPortal)),
                  'search portal'
                );
            if (!searchPortal) {
              out.portal = null;
              return;
            }
            const [portalTypeRaw, included] = await Promise.all([
              gate(() => rem.getPortalType()),
              gate(() => rem.getPortalDirectlyIncludedRem()).then((members) =>
                requireRemArray(members, 'portal members')
              ),
            ]);
            const classified = classifyPortalType(portalTypeRaw);
            const portal: InspectedPortal = {
              ...classified,
              portalTypeRaw: portalTypeRaw ?? null,
              includedIds: included.map((member) => member._id),
              query: null,
              filter: null,
            };
            const [query, filter] = await Promise.all([
              gate(() =>
                rem.getPowerupProperty(
                  BuiltInPowerupCodes.SearchPortal,
                  builtinSlotName(BuiltInPowerupCodes.SearchPortal, 'q')
                )
              ).then(
                (value) => value ?? null,
                (error: unknown) => {
                  fail('portal.query', error);
                  return null;
                }
              ),
              gate(() =>
                rem.getPowerupProperty(
                  BuiltInPowerupCodes.SearchPortal,
                  builtinSlotName(BuiltInPowerupCodes.SearchPortal, 'f')
                )
              ).then(
                (value) => value ?? null,
                (error: unknown) => {
                  fail('portal.filter', error);
                  return null;
                }
              ),
            ]);
            portal.query = query;
            portal.filter = filter;
            out.portal = portal;
          } catch (error) {
            fail('portal', error);
            out.portal = null;
          }
        })()
      );
    await Promise.all(tasks);
    const childError = childErrors.get(rem._id);
    if (childError && !errors.some((error) => error.field === 'children'))
      errors.push({ field: 'children', message: childError });
    if (errors.length > 0) out.errors = errors;
    return out;
  };

  const built = await mapBounded(ordered, INSPECT_CONCURRENCY, async (id) => {
    if (!cache.has(id)) {
      result.complete = false;
      return {
        id,
        missing: true,
        errors: [{ field: 'rem', message: 'Rem missing from exact batch lookup' }],
      } satisfies InspectedRem;
    }
    return build(cache.get(id)!);
  });
  // The array JSON is "[" + item + ("," + item)* + "]". Measure each rem once.
  let bytes = 2;
  for (const inspected of built) {
    const next =
      bytes + Buffer.byteLength(JSON.stringify(inspected)) + (result.rems.length > 0 ? 1 : 0);
    if (result.rems.length > 0 && next > MAX_OUTPUT_BYTES) {
      result.truncated = true;
      result.complete = false;
      result.errors.push({
        id: inspected.id,
        message: 'Stopped because the inspect document exceeded 1 MB',
      });
      break;
    }
    bytes = next;
    result.rems.push(inspected);
  }
  if (!result.complete) {
    const seen = new Set<string>();
    const merged: InspectStateResult['errors'] = [];
    const push = (entry: InspectStateResult['errors'][number]) => {
      const key = `${entry.id ?? ''}\0${entry.field ?? ''}\0${entry.message}`;
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(entry);
    };
    for (const error of result.errors) push(error);
    for (const rem of result.rems)
      for (const error of rem.errors ?? [])
        push({ id: rem.id, field: error.field, message: error.message });
    if (merged.length === 0) push({ message: 'Inspect incomplete' });
    result.errors = merged;
  }
  return result;
}
