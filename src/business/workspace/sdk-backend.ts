import type { ReactRNPlugin, PluginRem, RichTextInterface } from '@remnote/plugin-sdk';
import { cardMetadataSchema } from './metadata.js';
import { RemType } from '../sdk-constants.generated.js';
import { idSchema } from './identity.js';
import { immutableProjection } from './snapshots.js';
import { mapReads, settleReads } from './read-pool.js';
import {
  hash,
  type MetadataStore,
  type WorkspaceBackend,
  type WorkspaceRem,
  type PublicDiscovery,
} from './types.js';

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Incomplete native ${label} flag`);
  return value;
}

function publicSnapshot(rem: PluginRem): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(
      {
        $type: 'rem',
        id: rem._id,
        ...Object.fromEntries(
          Object.entries(rem).filter(([key, value]) => key !== '_id' && typeof value !== 'function')
        ),
      },
      (_key, value) => (value === undefined ? { $type: 'undefined' } : value)
    )
  );
}

function cardHistoryJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cardHistoryJson);
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError('Native Card history requires plain JSON objects');
    const result = Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, cardHistoryJson(item)])
    );
    // z.json() skips __proto__; validate its value explicitly and retain it as a data key.
    if (Object.hasOwn(result, '__proto__'))
      cardMetadataSchema.shape.repetitionHistory.parse([result.__proto__]);
    return result;
  }
  return value;
}

function cardsSnapshot(
  cards: Awaited<ReturnType<PluginRem['getCards']>>,
  remId: string
): NonNullable<WorkspaceRem['cards']> {
  if (!Array.isArray(cards)) throw new Error('Incomplete native card snapshot');
  return cards
    .map((card) => {
      if (!card || card.remId !== remId) throw new Error('Native card owner mismatch');
      const repetitionHistory = cardHistoryJson(card.repetitionHistory ?? null);
      const metadata = cardMetadataSchema.parse({
        id: card._id,
        remId: card.remId,
        type: card.type,
        createdAt: card.createdAt,
        repetitionHistory,
        nextRepetitionTime: card.nextRepetitionTime ?? null,
        lastRepetitionTime: card.lastRepetitionTime ?? null,
        timesWrongInRow: card.timesWrongInRow ?? null,
      });
      // Keep the validated input: Zod's record output deliberately omits __proto__ keys.
      return {
        ...metadata,
        repetitionHistory: repetitionHistory as typeof metadata.repetitionHistory,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** No SDK handles are cached. Every read obtains fresh public SDK objects. */
export class SdkWorkspaceBackend implements WorkspaceBackend {
  constructor(
    private readonly plugin: ReactRNPlugin,
    readonly journal: MetadataStore,
    private readonly status: () => Promise<{
      kbId: string;
      writable: boolean;
      destructive?: boolean;
    }>
  ) {}

  async identity(): Promise<{ kbId: string; writable: boolean; destructive?: boolean }> {
    const live = await this.status(),
      kb = await this.plugin.kb.getCurrentKnowledgeBaseData();
    if (!kb || kb._id !== live.kbId) throw new Error('Workspace live KB binding mismatch');
    return live;
  }

  private async snapshot(rem: PluginRem): Promise<WorkspaceRem> {
    if (
      !rem ||
      typeof rem._id !== 'string' ||
      !(rem.parent === null || typeof rem.parent === 'string') ||
      !Array.isArray(rem.children) ||
      rem.children.some((id) => typeof id !== 'string')
    )
      throw new Error('Incomplete SDK Rem snapshot');
    const [
      document,
      folder,
      cardItem,
      practice,
      enablePractice,
      table,
      property,
      powerup,
      powerupSlot,
      powerupProperty,
      powerupEnum,
      powerupList,
    ] = await settleReads([
      rem.isDocument(),
      rem.isFolder(),
      rem.isCardItem(),
      rem.getPracticeDirection(),
      rem.getEnablePractice(),
      rem.isTable(),
      rem.isProperty(),
      rem.isPowerup(),
      rem.isPowerupSlot(),
      rem.isPowerupProperty(),
      rem.isPowerupEnum(),
      rem.isPowerupPropertyListItem(),
    ]);
    const unsupported = [
      ['table', table],
      ['property', property],
      ['powerup', powerup],
      ['powerup-slot', powerupSlot],
      ['powerup-property', powerupProperty],
      ['powerup-enum', powerupEnum],
      ['powerup-list', powerupList],
    ]
      .filter(([label, value]) => boolean(value, String(label)))
      .map(([label]) => label)
      .join(',');
    if (!['forward', 'backward', 'both', 'none'].includes(practice))
      throw new Error('Incomplete native practice direction');
    const cards = cardsSnapshot(await rem.getCards(), rem._id);
    let portal: WorkspaceRem['portal'];
    if (rem.type === RemType.PORTAL) {
      const [rawType, members] = await settleReads([
        rem.getPortalType(),
        rem.getPortalDirectlyIncludedRem(),
      ]);
      // The SDK may explicitly return undefined for an unclassified portal subtype.
      const type = rawType === undefined ? null : rawType;
      if (
        (type !== null && (typeof type !== 'number' || !Number.isInteger(type))) ||
        !Array.isArray(members)
      )
        throw new Error(
          `Incomplete native portal membership for ${rem._id}: ` +
            `subtype=${rawType === null ? 'null' : typeof rawType}, integer=${Number.isInteger(rawType)}, ` +
            `members=${members === null ? 'null' : Array.isArray(members) ? 'array' : typeof members}`
        );
      const ids = members.map((member) => idSchema.parse(member?._id));
      if (new Set(ids).size !== ids.length) throw new Error('Ambiguous native portal membership');
      portal = { type, directlyIncludedRemIds: ids };
    }
    return {
      id: rem._id,
      parent: rem.parent,
      children: [...rem.children],
      type: rem.type ?? null,
      text: rem.text ?? null,
      backText: rem.backText ?? null,
      document: boolean(document, 'document'),
      folder: boolean(folder, 'folder'),
      cardItem: boolean(cardItem, 'cardItem'),
      practice,
      enablePractice: boolean(enablePractice, 'enablePractice'),
      public: publicSnapshot(rem),
      cards,
      ...(portal === undefined ? {} : { portal }),
      facts: {
        isTable: boolean(table, 'table'),
        isProperty: boolean(property, 'property'),
        isPowerup: boolean(powerup, 'powerup'),
        isPowerupSlot: boolean(powerupSlot, 'powerupSlot'),
        isPowerupProperty: boolean(powerupProperty, 'powerupProperty'),
        isPowerupEnum: boolean(powerupEnum, 'powerupEnum'),
        isPowerupPropertyListItem: boolean(powerupList, 'powerupList'),
      },
      ...(unsupported ? { unsupported } : {}),
    };
  }

  async enumerate(): Promise<WorkspaceRem[]> {
    // Official global enumeration. Transport errors remain incomplete: no search/known-root fallback.
    const rems = await this.plugin.rem.getAll();
    if (!Array.isArray(rems)) throw new Error('Full-library enumeration did not return an array');
    return mapReads(rems, 4, (rem) => this.snapshot(rem));
  }

  async read(ids: string[]): Promise<WorkspaceRem[]> {
    if (ids.length > 50) throw new Error('Exact-ID native read batch exceeds 50');
    const rems = await this.plugin.rem.findMany(ids);
    if (
      !Array.isArray(rems) ||
      rems.length !== ids.length ||
      new Set(rems.map((rem) => rem._id)).size !== ids.length ||
      rems.some((rem) => !ids.includes(rem._id))
    )
      throw new Error('Incomplete exact-ID native read');
    const byId = new Map(rems.map((rem) => [rem._id, rem]));
    return mapReads(ids, 4, (id) => this.snapshot(byId.get(id)!));
  }

  async readPublic(ids: string[]): Promise<Record<string, unknown>[]> {
    if (ids.length > 50 || new Set(ids).size !== ids.length)
      throw new Error('Exact public read batch exceeds 50 or repeats IDs');
    const rems = await this.plugin.rem.findMany(ids);
    if (
      !Array.isArray(rems) ||
      new Set(rems.map((rem) => rem._id)).size !== rems.length ||
      rems.some((rem) => !ids.includes(rem._id))
    )
      throw new Error('Malformed exact public read');
    const byId = new Map(rems.map((rem) => [rem._id, rem]));
    return ids.flatMap((id) => (byId.has(id) ? [publicSnapshot(byId.get(id)!)] : []));
  }

  async subtree(rootIds: string[]): Promise<WorkspaceRem[]> {
    if (!rootIds.length || new Set(rootIds).size !== rootIds.length)
      throw new Error('Subtree requires unique exact root IDs');
    const queue = [...rootIds],
      seen = new Set<string>(),
      result: WorkspaceRem[] = [];
    while (queue.length) {
      const ids = queue.splice(0, 50);
      if (ids.some((id) => seen.has(id))) throw new Error('Duplicate/cyclic subtree reference');
      ids.forEach((id) => seen.add(id));
      if (seen.size > 100000) throw new Error('Subtree exceeds 100000 Rem bound');
      const rems = await this.read(ids);
      if (
        new Set(rems.map((rem) => rem.id)).size !== ids.length ||
        rems.some((rem) => !ids.includes(rem.id))
      )
        throw new Error('Malformed exact subtree batch');
      result.push(...rems);
      queue.push(...rems.flatMap((rem) => rem.children));
    }
    return result;
  }

  async discover(ids: string[]): Promise<PublicDiscovery> {
    if (new Set(ids).size !== ids.length || ids.length > 100000)
      throw new Error('Invalid official discovery ID set');
    const result: PublicDiscovery = { snapshots: [], flags: {} };
    for (let start = 0; start < ids.length; start += 50) {
      const batch = ids.slice(start, start + 50),
        rems = await this.plugin.rem.findMany(batch);
      if (
        !Array.isArray(rems) ||
        rems.length !== batch.length ||
        new Set(rems.map((rem) => rem._id)).size !== batch.length ||
        rems.some((rem) => !batch.includes(rem._id))
      )
        throw new Error('Incomplete official exact-ID public snapshot collection');
      const byId = new Map(rems.map((rem) => [rem._id, rem]));
      const collected = await mapReads(batch, 4, async (id) => {
        const rem = byId.get(id)!;
        const [document, folder] = await settleReads([rem.isDocument(), rem.isFolder()]);
        return {
          snapshot: publicSnapshot(rem),
          id: rem._id,
          flags: {
            document: boolean(document, 'document'),
            folder: boolean(folder, 'folder'),
            unsupported: 'unverified-native-flags',
          },
        };
      });
      for (const item of collected) {
        result.snapshots.push(item.snapshot);
        result.flags[item.id] = item.flags;
      }
    }
    return result;
  }

  private async rem(id: string): Promise<PluginRem> {
    const rem = await this.plugin.rem.findOne(id);
    if (!rem || rem._id !== id) throw new Error('Missing native Rem');
    return rem;
  }

  async cardFacts(id: string): Promise<Array<{ id: string; hash: string }>> {
    const cards = await (await this.rem(id)).getCards();
    if (!Array.isArray(cards)) throw new Error('Incomplete native card read');
    return cards
      .map((card) => {
        if (!card || typeof card._id !== 'string' || card.remId !== id)
          throw new Error('Malformed native card identity');
        return {
          id: card._id,
          hash: hash({ id: card._id, remId: card.remId, type: card.type }),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async guard(ids: string[]): Promise<string> {
    const facts = await mapReads([...ids].sort(), 4, async (id) => {
      const rem = await this.rem(id),
        snapshot = await this.snapshot(rem),
        tags = await rem.getTagRems();
      if (!Array.isArray(tags)) throw new Error('Incomplete native tags');
      return {
        ...immutableProjection(snapshot),
        tags: tags.map((tag) => tag._id).sort(),
        cards: await this.cardFacts(id),
      };
    });
    return hash(facts);
  }

  private async writable(): Promise<void> {
    if (!(await this.identity()).writable) throw new Error('Live workspace write gate is disabled');
  }

  async create(markdown?: string): Promise<string> {
    await this.writable();
    const rem =
      markdown === undefined
        ? await this.plugin.rem.createRem()
        : await this.plugin.rem.createSingleRemWithMarkdown(markdown);
    if (!rem?._id) throw new Error('Creation did not return an identity; outcome may be unknown');
    return rem._id;
  }
  async writeField(id: string, field: 'text' | 'backText', value: unknown[]): Promise<void> {
    await this.writable();
    const rem = await this.rem(id);
    if (field === 'text') await rem.setText(value as RichTextInterface);
    else await rem.setBackText(value as RichTextInterface);
  }
  async setParent(id: string, parent: string, position: number): Promise<void> {
    await this.writable();
    await (await this.rem(id)).setParent(parent, position);
  }
  async setCardItem(id: string, value: boolean): Promise<void> {
    await this.writable();
    await (await this.rem(id)).setIsCardItem(value);
  }
  async remove(id: string): Promise<void> {
    const live = await this.identity();
    if (!live.writable || !live.destructive)
      throw new Error('Both write gates and --allow-destructive are required');
    await (await this.rem(id)).remove();
  }
  async existingIds(ids: string[]): Promise<string[]> {
    const rems = await this.plugin.rem.findMany(ids);
    if (!Array.isArray(rems) || rems.some((rem) => !ids.includes(rem._id)))
      throw new Error('Invalid exact deletion readback');
    return rems.map((rem) => rem._id);
  }
}
