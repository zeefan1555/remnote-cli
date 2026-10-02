import { readFile, rm } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { Connection } from '../../../src/remnote-cli/client/connection.js';
import { readConnectionConfig } from '../../../src/remnote-cli/client/connection-config.js';
import { remoteSdk } from '../../../src/remnote-cli/client/remote-sdk.js';
import { verifiedCatalog } from '../../../src/remnote-cli/client/sdk-capabilities.js';
import { CliTestClient } from '../../integration/cli/cli-test-client.js';
import { transactionsWorkflow } from '../../integration/cli/workflows/11-transactions.js';

vi.mock('../../../src/remnote-cli/client/connection-config.js');
vi.mock('../../../src/remnote-cli/client/remote-sdk.js');
vi.mock('../../../src/remnote-cli/client/sdk-capabilities.js');
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  'checks native readback and stops when rollback is broken=%s',
  async (broken) => {
    let directory = '';
    vi.spyOn(console, 'log').mockImplementation((value: string) => {
      if (value.startsWith('Transaction evidence and recovery plan: '))
        directory = value.split(': ')[1];
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(readConnectionConfig).mockResolvedValue({
      protocolVersion: 1,
      token: 'a'.repeat(64),
      port: 3002,
      knowledgeBaseId: 'kb',
    });
    vi.spyOn(Connection.prototype, 'open').mockResolvedValue({
      protocolVersion: 1,
      pluginVersion: 'test',
      sdkVersion: '0.0.46',
      sdkCatalogHash: 'b'.repeat(64),
      knowledgeBaseId: 'kb',
      knowledgeBaseName: 'Test',
      acceptWriteOperations: true,
      acceptReplaceOperation: false,
    });
    vi.spyOn(Connection.prototype, 'request').mockResolvedValue({
      pluginId: 'zeefan-remnote-sdk-bridge',
    });
    const close = vi.spyOn(Connection.prototype, 'close').mockResolvedValue();
    vi.mocked(verifiedCatalog).mockReturnValue({
      sdkVersion: '0.0.46',
      sdkCatalogHash: 'b'.repeat(64),
    } as never);
    let state = new Map<string, { text: unknown; parent?: string }>();
    let counter = 0;
    const rem = (id: string) => ({
      _id: id,
      get text() {
        return state.get(id)!.text;
      },
      setText: async (text: unknown) => {
        state.get(id)!.text = text;
      },
      setParent: async (parent: string) => {
        state.get(id)!.parent = parent;
      },
    });
    const transaction = vi.fn(async (fn: () => Promise<unknown>) => {
      const before = structuredClone(state);
      try {
        return await fn();
      } catch (error) {
        if (!broken) state = before;
        throw error;
      }
    });
    vi.mocked(remoteSdk).mockReturnValue({
      app: { getPlatform: async () => 'app', transaction },
      rem: {
        createRem: async () => {
          const id = `r${++counter}`;
          state.set(id, { text: [] });
          return rem(id);
        },
        findOne: async (id: string) => (state.has(id) ? rem(id) : undefined),
      },
    } as never);
    try {
      const result = await transactionsWorkflow({ cli: new CliTestClient(), runId: 'unit-test' });
      expect(result.steps.map((step) => step.passed)).toEqual(
        broken ? [true, true, false] : [true, true, true, true, true]
      );
      expect(transaction).toHaveBeenCalledTimes(broken ? 1 : 2);
      expect(close).toHaveBeenCalledTimes(broken ? 1 : 2);
      const receipt = JSON.parse(
        await readFile(`${directory}/${broken ? 'failure' : 'result'}.json`, 'utf8')
      );
      expect(receipt.ids).toEqual({ root: 'r1', abortedChild: 'r2' });
      expect(state.has('r2')).toBe(broken);
    } finally {
      if (directory) await rm(directory, { recursive: true });
    }
  }
);
