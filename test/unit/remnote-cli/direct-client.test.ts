import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockCard, MockRemNotePlugin } from '../../helpers/business-mocks.js';
import { contentHash } from '../../../src/business/content-hash.js';
const wire = vi.hoisted(() => ({
  open: vi.fn(),
  request: vi.fn(),
  close: vi.fn(),
  constructed: vi.fn(),
  plugin: undefined as unknown,
}));
vi.mock('../../../src/remnote-cli/client/connection.js', () => ({
  Connection: class {
    timings = { connectionMs: 1, sdkCalls: 0, sdkMs: 1 };
    constructor(config: unknown) {
      wire.constructed(config);
    }
    open = wire.open;
    request = wire.request;
    close = wire.close;
  },
}));
vi.mock('../../../src/remnote-cli/client/remote-sdk.js', () => ({ remoteSdk: () => wire.plugin }));
import { DirectClient } from '../../../src/remnote-cli/client/direct-client.js';
import { ReadSession } from '../../../src/remnote-cli/client/session.js';
import { LocalState } from '../../../src/remnote-cli/client/local-state.js';
import { createProgram, runProgram } from '../../../src/remnote-cli/cli.js';
import { createBufferedRuntime } from '../../../src/remnote-cli/output/runtime.js';

let directory: string, client: DirectClient;
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'direct-client-'));
  vi.stubEnv('REMNOTE_CLI_STATE_HOME', directory);
  const data = { catalogSchemaVersion: 1 as const, sdkVersion: '0.0.46', capabilities: [] };
  const sdkCatalogHash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  wire.open.mockResolvedValue({
    pluginVersion: 'different',
    knowledgeBaseId: 'kb',
    sdkCatalogHash,
    sdkVersion: '0.0.46',
  });
  wire.request.mockImplementation(async (action) =>
    action === 'get_sdk_capabilities'
      ? { ...data, sdkCatalogHash }
      : {
          connected: true,
          pluginVersion: 'different',
          knowledgeBaseId: 'kb',
        }
  );
  wire.plugin = new MockRemNotePlugin();
  client = new DirectClient();
});
afterEach(async () => {
  await client.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
describe('local business dispatch', () => {
  it('runs question and answer content updates through schema dispatch and existing inspect facts', async () => {
    const plugin = wire.plugin as MockRemNotePlugin;
    const question = plugin.addTestRem('question', 'Old question');
    const answer = plugin.addTestRem('answer', 'Old answer');
    await answer.setParent(question);
    answer.setIsCardItemMock(true);
    question.setCardsMock([
      new MockCard(
        'card-1',
        'question',
        'forward',
        1,
        [{ score: 1, time: 20 }] as never,
        40,
        0,
        20
      ),
    ]);
    const before = await client.execute('inspect_state', {
      remIds: ['question'],
      fields: ['cards', 'rawCards'],
    });
    const questionResult = await client.execute('update_note', {
      remId: 'question',
      content: 'New question',
      expectedTextHash: await contentHash(question.text),
    });
    const answerResult = await client.execute('update_answer', {
      remId: 'answer',
      cardId: 'question',
      content: 'New answer',
      expectedTextHash: await contentHash(answer.text),
    });
    const after = await client.execute('inspect_state', {
      remIds: ['question'],
      fields: ['cards', 'rawCards'],
    });
    expect(before).toEqual(after);
    expect(questionResult).toMatchObject({ status: 'verified', cardIds: ['card-1'] });
    expect(answerResult).toMatchObject({
      status: 'verified',
      cardIds: ['card-1'],
      isCardItem: true,
    });
    expect(after).toMatchObject({
      complete: true,
      rems: [
        {
          rawCards: [
            {
              id: 'card-1',
              remId: 'question',
              createdAt: 1,
              nextRepetitionTime: 40,
              lastRepetitionTime: 20,
              timesWrongInRow: 0,
              repetitionHistory: [{ score: 1, time: 20 }],
            },
          ],
        },
      ],
    });
    expect(wire.open).toHaveBeenCalledOnce();
  });

  it('rejects missing or malformed content hashes before any bridge connection', async () => {
    await expect(
      client.execute('update_note', { remId: 'question', content: 'New' })
    ).rejects.toThrow();
    await expect(
      client.execute('update_answer', {
        remId: 'answer',
        cardId: 'question',
        content: 'New',
        expectedTextHash: 'A'.repeat(64),
      })
    ).rejects.toThrow();
    expect(wire.open).not.toHaveBeenCalled();
  });

  it('keeps metadata-only title and alias updates on their existing transaction path', async () => {
    const plugin = wire.plugin as MockRemNotePlugin;
    const rem = plugin.addTestRem('metadata', 'Old');
    await client.execute('update_note', { remId: 'metadata', title: 'New', addAliases: ['Alias'] });
    expect(rem.text).toEqual(['New']);
    expect(await rem.getAliases()).toHaveLength(1);
    expect(plugin.app.transaction).toHaveBeenCalledOnce();
  });

  it.each([
    { addAliases: ['Added'] },
    { removeAliases: ['Existing'] },
    { addAliases: ['Added'], removeAliases: ['Existing'] },
  ])('rejects content and aliases before connecting or writing: %j', async (aliases) => {
    const plugin = wire.plugin as MockRemNotePlugin;
    const rem = plugin.addTestRem('question', 'Old');
    rem.setAliasesMock([['Existing']]);
    const textWrite = vi.spyOn(rem, 'setText');
    await expect(
      client.execute('update_note', {
        remId: 'question',
        content: 'New',
        expectedTextHash: await contentHash(rem.text),
        ...aliases,
      })
    ).rejects.toThrow();
    expect(wire.constructed).not.toHaveBeenCalled();
    expect(wire.open).not.toHaveBeenCalled();
    expect(wire.request).not.toHaveBeenCalled();
    expect(textWrite).not.toHaveBeenCalled();
    expect(rem.text).toEqual(['Old']);
    expect((await rem.getAliases()).map((alias) => alias.text)).toEqual([['Existing']]);
    expect(plugin.app.transaction).not.toHaveBeenCalled();
  });

  it('keeps metadata-only alias additions and removals without changing text', async () => {
    const plugin = wire.plugin as MockRemNotePlugin;
    const rem = plugin.addTestRem('metadata', 'Old');
    rem.setAliasesMock([['Existing']]);
    const textWrite = vi.spyOn(rem, 'setText');
    expect(
      await client.execute('update_note', {
        remId: 'metadata',
        addAliases: ['Added'],
        removeAliases: ['Existing'],
      })
    ).toEqual({ titles: ['Old'], remIds: ['metadata'] });
    expect(textWrite).not.toHaveBeenCalled();
    expect(rem.text).toEqual(['Old']);
    expect((await rem.getAliases()).map((alias) => alias.text)).toEqual([['Added']]);
    expect(plugin.app.transaction).toHaveBeenCalledOnce();
  });
  it('uses one command connection for status, workflows and low-level calls', async () => {
    expect(await client.execute('get_status', {})).toMatchObject({
      connected: true,
      pluginVersion: 'different',
      knowledgeBaseId: 'kb',
    });
    expect(await client.execute('get_sdk_capabilities', {})).toMatchObject({
      sdkVersion: '0.0.46',
    });
    const result = (await client.execute('create_note', { title: 'Local business' })) as {
      remIds: string[];
    };
    expect(result.remIds).toHaveLength(1);
    expect(await client.execute('read_note', { remId: result.remIds[0] })).toMatchObject({
      title: 'Local business',
    });
    await client.execute('sdk_call', { capability: 'namespace:kb.getCurrentKnowledgeBaseData' });
    expect(wire.open).toHaveBeenCalledOnce();
    expect(wire.constructed).toHaveBeenCalledOnce();
  });

  it('rejects unknown and removed task actions before connecting', async () => {
    await expect(client.execute('eval', {})).rejects.toThrow('Unknown CLI action');
    await expect(client.execute('flashcards_apply', {})).rejects.toThrow('Unknown CLI action');
    await expect(client.execute('get_review_stats', {})).rejects.toThrow('Unknown CLI action');
    expect(wire.open).not.toHaveBeenCalled();
  });

  it('reports read-only bridge failures without claiming an unknown write', async () => {
    const plugin = wire.plugin as MockRemNotePlugin;
    vi.spyOn(plugin.rem, 'findOne').mockRejectedValueOnce(
      new Error('SDK array exceeds maximum length 1000; verify write outcome before retry')
    );

    await expect(client.execute('list_todos', { rootRemId: 'root' })).rejects.toMatchObject({
      type: 'internal',
      subtype: 'read_failed',
    });
  });

  it('invalidates command reads after a mutation but not after status', async () => {
    const invalidate = vi.spyOn(ReadSession.prototype, 'invalidateAll');
    await client.execute('get_status', {});
    const root = (wire.plugin as MockRemNotePlugin).addTestRem('todo-root', 'Root');
    await client.execute('list_todos', { rootRemId: root._id });
    expect(invalidate).not.toHaveBeenCalled();
    await client.execute('create_note', { title: 'Invalidate' });
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('classifies a failed destructive removal as an unknown write outcome', async () => {
    client = new DirectClient({ allowDestructive: true, persist: false });
    const plugin = wire.plugin as MockRemNotePlugin;
    const rem = plugin.addTestRem('delete_unknown', 'Delete unknown');
    vi.spyOn(plugin.rem, 'findOne').mockResolvedValueOnce(rem);
    vi.spyOn(rem, 'remove').mockRejectedValueOnce(new Error('Native removal failed'));

    await expect(
      client.execute('delete_rem', {
        remId: rem._id,
        dryRun: false,
        expectedTitle: 'Delete unknown',
      })
    ).rejects.toMatchObject({
      type: 'unknown_outcome',
      subtype: 'write_response_lost',
    });
  });

  it('preserves the pending-confirmation subtype at the CLI boundary', async () => {
    client = new DirectClient({ allowDestructive: true, persist: false });
    const plugin = wire.plugin as MockRemNotePlugin;
    const rem = plugin.addTestRem('delete_pending', 'Delete pending');
    vi.spyOn(rem, 'remove').mockResolvedValueOnce(undefined);

    await expect(
      client.execute('delete_rem', {
        remId: rem._id,
        dryRun: false,
        expectedTitle: 'Delete pending',
      })
    ).rejects.toMatchObject({
      type: 'unknown_outcome',
      subtype: 'delete_confirmation_pending_or_not_applied',
      retryable: false,
    });
  });

  it('does not classify a delete preview connection failure as a write outcome', async () => {
    wire.open.mockRejectedValueOnce(
      new Error('Connection lost; write outcome unknown. Do not blindly replay.')
    );

    const error = await client
      .execute('delete_rem', { remId: 'preview-rem', dryRun: true })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as { type?: string }).type).not.toBe('unknown_outcome');
  });

  it('keeps a delete preview transport failure unavailable at the CLI boundary', async () => {
    wire.open.mockRejectedValueOnce(
      new Error('Connection lost; write outcome unknown. Do not blindly replay.')
    );
    const runtime = createBufferedRuntime();
    const program = createProgram('test', runtime);

    const exitCode = await runProgram(
      program,
      ['node', 'remnote-cli', 'rem', 'delete', 'preview-rem'],
      runtime
    );
    expect(exitCode).toBe(3);
    const failure = JSON.parse(runtime.stderr());
    expect(failure).toMatchObject({
      ok: false,
      error: {
        type: 'unavailable',
        subtype: 'bridge_unavailable',
        message: 'Bridge connection failed during a read-only preview; no write was attempted.',
      },
    });
    expect(JSON.stringify(failure)).not.toContain('write outcome unknown');
  });

  it('rejects catalog drift', async () => {
    wire.open.mockResolvedValue({ sdkVersion: 'different', sdkCatalogHash: 'f'.repeat(64) });
    await expect(client.execute('get_status', {})).rejects.toThrow('catalog changed');
  });

  it('does not close a retained connection until the batch releases it', async () => {
    await client.execute('get_status', {});
    client.retain();
    await client.close();
    expect(wire.close).not.toHaveBeenCalled();
    client.release();
    await client.close();
    expect(wire.close).toHaveBeenCalledOnce();
  });

  it('supports read-only clients that never persist search snapshots', async () => {
    client.disablePersistence();
    const persist = vi.spyOn(LocalState.prototype, 'setLocal').mockResolvedValue(undefined);

    await client.execute('get_status', {});
    await client.close();

    expect(persist).not.toHaveBeenCalled();
    expect(wire.close).toHaveBeenCalled();
  });

  it('passes an explicit KB requirement without product version matching', async () => {
    client = new DirectClient({ kbId: 'requested', verbose: true });
    await client.execute('get_status', {});
    expect(wire.constructed).toHaveBeenCalledWith(
      expect.objectContaining({ knowledgeBaseId: 'requested' })
    );
  });
});
