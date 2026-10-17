import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPairing } from '../../../src/remnote-cli/client/connection-config.js';
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

let directory: string, client: DirectClient;
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'direct-client-'));
  vi.stubEnv('REMNOTE_CLI_CONFIG', join(directory, 'connection.json'));
  await createPairing('kb');
  const data = { sdkVersion: '0.0.46', capabilities: [] };
  const sdkCatalogHash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  wire.open.mockResolvedValue({
    knowledgeBaseId: 'kb',
    acceptWriteOperations: true,
    acceptReplaceOperation: false,
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
          acceptWriteOperations: true,
        }
  );
  wire.plugin = new MockRemNotePlugin();
  client = new DirectClient();
});
afterEach(async () => {
  await client.close();
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

  it('rejects catalog drift and invalid port settings', async () => {
    wire.open.mockResolvedValue({ sdkVersion: 'different', sdkCatalogHash: 'f'.repeat(64) });
    await expect(client.execute('get_status', {})).rejects.toThrow('catalog changed');
    await client.close();
    client = new DirectClient({ port: '0' });
    await expect(client.execute('get_status', {})).rejects.toThrow('Invalid loopback port');
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

  it('honors explicit KB and port requirements without product version matching', async () => {
    client = new DirectClient({ kbId: 'requested', port: '4002', verbose: true });
    await client.execute('get_status', {});
    expect(wire.constructed).toHaveBeenCalledWith(
      expect.objectContaining({ knowledgeBaseId: 'requested', port: 4002 })
    );
  });
});
