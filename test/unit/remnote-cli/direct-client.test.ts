import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockRemNotePlugin } from '../../helpers/business-mocks.js';
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

  it('rejects unknown actions and invalid plans before connecting', async () => {
    await expect(client.execute('eval', {})).rejects.toThrow('Unknown CLI action');
    await expect(client.execute('flashcards_apply', {})).rejects.toThrow();
    expect(wire.open).not.toHaveBeenCalled();
  });

  it('invalidates command reads after a mutation but not after status', async () => {
    const invalidate = vi.spyOn(ReadSession.prototype, 'invalidateAll');
    await client.execute('get_status', {});
    await client.execute('list_todos', {});
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
