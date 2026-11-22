import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { RemAdapter } from '../../business/rem-adapter.js';
import * as schemas from '../../schemas/remnote-schemas.js';
import { InspectManySchema, VerifyScopeSchema } from '../../schemas/composite-schemas.js';
import { InspectStateSchema, PowerupGetSchema } from '../../schemas/state-schemas.js';
import { FlashcardsApplySchema, WikiApplySchema } from '../../schemas/task-schemas.js';
import { resolveManagedImage } from '../../media.js';
import { Connection } from './connection.js';
import { remnoteCliStateHome } from './state-home.js';
import { verifiedCatalog, type CapabilityResult } from './sdk-capabilities.js';
import { remoteSdk } from './remote-sdk.js';
import { LocalState } from './local-state.js';
import { SdkWorkspaceBackend } from '../../business/workspace/sdk-backend.js';
import { ReadSession } from './session.js';
import { isWriteUncertainty, unknownOutcomeFailure } from '../output/errors.js';

const require = createRequire(import.meta.url);
const { version } = require('../../../package.json') as { version: string };
const operations = {
  create_note: ['createNote', schemas.CreateNoteSchema],
  append_journal: ['appendJournal', schemas.AppendJournalSchema],
  search: ['search', schemas.SearchSchema],
  search_by_tag: ['searchByTag', schemas.SearchByTagSchema],
  read_note: ['readNote', schemas.ReadNoteSchema],
  list_children: ['listChildren', schemas.ListChildrenSchema],
  get_review_stats: ['getReviewStats', schemas.ReviewStatsSchema],
  set_outline_collapsed: ['setOutlineCollapsed', schemas.SetOutlineCollapsedSchema],
  list_todos: ['listTodos', schemas.ListTodosSchema],
  update_todo: ['updateTodo', schemas.UpdateTodoSchema],
  update_note: ['updateNote', schemas.UpdateNoteSchema],
  set_document_status: ['setDocumentStatus', schemas.SetDocumentStatusSchema],
  insert_children: ['insertChildren', schemas.InsertChildrenSchema],
  move_note: ['moveNote', schemas.MoveNoteSchema],
  replace_children: ['replaceChildren', schemas.ReplaceChildrenSchema],
  update_tags: ['updateTags', schemas.UpdateTagsSchema],
  set_property: ['setProperty', schemas.SetPropertySchema],
  read_table: ['readTable', schemas.ReadTableSchema],
  inspect_many: ['inspectMany', InspectManySchema],
  verify_scope: ['verifyScope', VerifyScopeSchema],
  inspect_state: ['inspectState', InspectStateSchema],
  powerup_get: ['getPowerupSlot', PowerupGetSchema],
  flashcards_apply: ['applyFlashcards', FlashcardsApplySchema],
  wiki_apply: ['applyWiki', WikiApplySchema],
} as const;
const READ_ONLY_ACTIONS = new Set([
  'get_status',
  'get_sdk_capabilities',
  'search',
  'search_by_tag',
  'read_note',
  'list_children',
  'get_review_stats',
  'inspect_many',
  'verify_scope',
  'inspect_state',
  'powerup_get',
  'get_media',
]);
export interface ClientOptions {
  kbId?: string;
  allowDestructive?: boolean;
  verbose?: boolean;
  persist?: boolean;
  onDiagnostic?: (text: string) => void;
}
export class DirectClient {
  private connection?: Connection;
  private adapter?: RemAdapter;
  private catalog?: CapabilityResult;
  private state?: LocalState;
  private workspace?: SdkWorkspaceBackend;
  private startedAt = performance.now();
  private holds = 0;
  private persist = true;
  private readonly readSession = new ReadSession();
  constructor(private readonly options: ClientOptions = {}) {
    this.persist = options.persist !== false;
  }

  /** Keep the bridge open while an outer batch runs inner commands. */
  retain(): void {
    this.holds += 1;
  }
  /** Outer batch --allow-destructive, shared with inner sdk calls. */
  allowsDestructive(): boolean {
    return this.options.allowDestructive === true;
  }
  release(): void {
    this.holds = Math.max(0, this.holds - 1);
  }
  disablePersistence(): void {
    this.persist = false;
  }

  private async connect(): Promise<void> {
    if (this.adapter) return;
    this.connection = new Connection({ knowledgeBaseId: this.options.kbId }, version);
    const identity = await this.connection.open();
    const catalog = verifiedCatalog(await this.connection.request('get_sdk_capabilities', {}));
    if (
      catalog.sdkCatalogHash !== identity.sdkCatalogHash ||
      catalog.sdkVersion !== identity.sdkVersion
    )
      throw new Error('SDK catalog changed during handshake');
    this.catalog = catalog;
    const kbKey = createHash('sha256').update(identity.knowledgeBaseId).digest('hex');
    this.state = new LocalState(join(remnoteCliStateHome(), 'state', kbKey));
    const plugin = remoteSdk(this.connection, catalog, this.options.allowDestructive === true);
    this.workspace = new SdkWorkspaceBackend(plugin, this.state, async () => {
      const status = (await this.connection!.request('get_status', {})) as Record<string, unknown>;
      if (typeof status.knowledgeBaseId !== 'string')
        throw new Error('Incomplete live workspace status');
      return {
        kbId: status.knowledgeBaseId,
        writable: true,
        destructive: this.options.allowDestructive === true,
      };
    });
    const supportedCapabilities = new Set(
      catalog.capabilities
        .filter((capability) => capability.status === 'supported')
        .map((c) => c.id)
    );
    this.adapter = new RemAdapter(
      plugin,
      {
        acceptWriteOperations: true,
        acceptReplaceOperation: this.options.allowDestructive === true,
      },
      this.state,
      supportedCapabilities,
      this.readSession
    );
    this.adapter.importSearchSnapshots(await this.state.getLocal('search-snapshots'));
  }
  async execute(action: string, payload: Record<string, unknown>): Promise<unknown> {
    const taskPreview =
      (action === 'flashcards_apply' || action === 'wiki_apply') && payload.dryRun !== false;
    try {
      return await this.executeAction(action, payload);
    } catch (error) {
      if (!READ_ONLY_ACTIONS.has(action) && !taskPreview && isWriteUncertainty(error))
        throw unknownOutcomeFailure(error);
      throw error;
    } finally {
      if (!READ_ONLY_ACTIONS.has(action) && !taskPreview) this.readSession.invalidateAll();
    }
  }

  private async executeAction(action: string, payload: Record<string, unknown>): Promise<unknown> {
    const operation = operations[action as keyof typeof operations];
    if (
      !operation &&
      !['get_status', 'get_sdk_capabilities', 'sdk_call', 'get_media'].includes(action)
    )
      throw new Error('Unknown CLI action: ' + action);
    const input = operation ? operation[1].parse(payload) : payload;
    await this.connect();
    if (action === 'read_note' && Array.isArray((input as { remIds?: unknown }).remIds))
      return this.adapter!.readNotes(input as Parameters<RemAdapter['readNotes']>[0]);
    if (
      action === 'list_children' &&
      Array.isArray((input as { parentRemIds?: unknown }).parentRemIds)
    )
      return this.adapter!.listChildrenMany(input as Parameters<RemAdapter['listChildrenMany']>[0]);
    if (action === 'get_status')
      return {
        ...((await this.connection!.request('get_status', {})) as object),
        acceptWriteOperations: true,
        acceptReplaceOperation: this.options.allowDestructive === true,
        cliVersion: version,
        sdkVersion: this.catalog!.sdkVersion,
        sdkCatalogHash: this.catalog!.sdkCatalogHash,
        timings: {
          ...this.connection!.timings,
          commandMs: Math.round(performance.now() - this.startedAt),
        },
      };
    if (action === 'get_sdk_capabilities') return this.catalog!;
    if (action === 'sdk_call') return this.connection!.request('sdk_call', payload);
    if (action === 'get_media') {
      const media = schemas.GetMediaSchema.parse(payload);
      const locator = await this.adapter!.getMediaLocator(media);
      return resolveManagedImage(
        locator,
        (process.env.REMNOTE_MEDIA_ROOTS ?? '').split(':').filter(Boolean),
        media.maxInlineBytes
      );
    }
    // The table is local CLI code, not user-controlled SDK dispatch.
    return Reflect.apply(Reflect.get(this.adapter!, operation![0]), this.adapter!, [input]);
  }
  /** Called lazily, only after offline workspace parsing/lint. Shares the batch connection. */
  async workspaceBackend(): Promise<SdkWorkspaceBackend> {
    await this.connect();
    return this.workspace!;
  }
  async close(): Promise<void> {
    if (this.holds > 0) return;
    try {
      if (this.adapter && this.state && this.persist)
        await this.state.setLocal('search-snapshots', this.adapter.exportSearchSnapshots());
      if (this.options.verbose && this.connection)
        this.options.onDiagnostic?.(
          JSON.stringify({
            timings: {
              ...this.connection.timings,
              commandMs: Math.round(performance.now() - this.startedAt),
            },
          }) + '\n'
        );
    } finally {
      await this.connection?.close();
    }
  }
}
