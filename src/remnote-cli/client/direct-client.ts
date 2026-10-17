import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { RemAdapter } from '../../business/rem-adapter.js';
import * as schemas from '../../schemas/remnote-schemas.js';
import { InspectManySchema, VerifyScopeSchema } from '../../schemas/composite-schemas.js';
import { FlashcardsApplySchema, WikiApplySchema } from '../../schemas/task-schemas.js';
import { resolveManagedImage } from '../../media.js';
import { Connection } from './connection.js';
import { connectionConfigPath, readConnectionConfig } from './connection-config.js';
import { verifiedCatalog, type CapabilityResult } from './sdk-capabilities.js';
import { remoteSdk } from './remote-sdk.js';
import { LocalState } from './local-state.js';

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
  flashcards_apply: ['applyFlashcards', FlashcardsApplySchema],
  wiki_apply: ['applyWiki', WikiApplySchema],
} as const;
export interface ClientOptions {
  port?: string;
  kbId?: string;
  allowDestructive?: boolean;
  verbose?: boolean;
}
export class DirectClient {
  private connection?: Connection;
  private adapter?: RemAdapter;
  private catalog?: CapabilityResult;
  private state?: LocalState;
  private startedAt = performance.now();
  private readonly configPath = connectionConfigPath();
  private holds = 0;
  constructor(private readonly options: ClientOptions = {}) {}

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

  private async connect(): Promise<void> {
    if (this.adapter) return;
    const config = await readConnectionConfig(this.configPath);
    if (this.options.port !== undefined) {
      const port = Number(this.options.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535)
        throw new Error('Invalid loopback port');
      config.port = port;
    }
    if (this.options.kbId) config.knowledgeBaseId = this.options.kbId;
    this.connection = new Connection(config, version);
    const identity = await this.connection.open();
    const catalog = verifiedCatalog(await this.connection.request('get_sdk_capabilities', {}));
    if (
      catalog.sdkCatalogHash !== identity.sdkCatalogHash ||
      catalog.sdkVersion !== identity.sdkVersion
    )
      throw new Error('SDK catalog changed during handshake');
    this.catalog = catalog;
    const kbKey = createHash('sha256').update(config.knowledgeBaseId).digest('hex');
    this.state = new LocalState(join(dirname(this.configPath), 'state', kbKey));
    const plugin = remoteSdk(this.connection, catalog, this.options.allowDestructive === true);
    this.adapter = new RemAdapter(
      plugin,
      {
        ...config.settings,
        acceptWriteOperations: identity.acceptWriteOperations,
        acceptReplaceOperation:
          identity.acceptReplaceOperation && this.options.allowDestructive === true,
      },
      this.state
    );
    this.adapter.importSearchSnapshots(await this.state.getLocal('search-snapshots'));
  }
  async execute(action: string, payload: Record<string, unknown>): Promise<unknown> {
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
        cliVersion: version,
        sdkVersion: this.catalog!.sdkVersion,
        sdkCatalogHash: this.catalog!.sdkCatalogHash,
        timings: {
          ...this.connection!.timings,
          commandMs: Math.round(performance.now() - this.startedAt),
        },
      };
    if (action === 'get_sdk_capabilities') return this.catalog!;
    if (action === 'sdk_call')
      return this.connection!.request('sdk_call', schemas.SdkCallSchema.parse(payload));
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
  async close(): Promise<void> {
    if (this.holds > 0) return;
    try {
      if (this.adapter && this.state)
        await this.state.setLocal('search-snapshots', this.adapter.exportSearchSnapshots());
      if (this.options.verbose && this.connection)
        console.error(
          JSON.stringify({
            timings: {
              ...this.connection.timings,
              commandMs: Math.round(performance.now() - this.startedAt),
            },
          })
        );
    } finally {
      await this.connection?.close();
    }
  }
}
