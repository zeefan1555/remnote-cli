import { readFile, rm } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { Connection } from '../../../src/remnote-cli/client/connection.js';
import { remoteSdk } from '../../../src/remnote-cli/client/remote-sdk.js';
import { verifiedCatalog } from '../../../src/remnote-cli/client/sdk-capabilities.js';
import { CliTestClient } from '../../integration/cli/cli-test-client.js';
import { transactionsWorkflow } from '../../integration/cli/workflows/11-transactions.js';

vi.mock('../../../src/remnote-cli/client/remote-sdk.js');
vi.mock('../../../src/remnote-cli/client/sdk-capabilities.js');
afterEach(() => vi.restoreAllMocks());

it.each([false, true, 'unavailable'])(
  'checks native readback or refuses writes when rollback is %s',
  async (broken) => {
    let directory = '';
    vi.spyOn(console, 'log').mockImplementation((value: string) => {
      if (value.startsWith('Transaction evidence and recovery plan: '))
        directory = value.split(': ')[1];
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(Connection.prototype, 'open').mockResolvedValue({
      pluginVersion: 'test',
      sdkVersion: '0.0.46',
      sdkCatalogHash: 'b'.repeat(64),
      knowledgeBaseId: 'kb',
      knowledgeBaseName: 'Test',
    });
    vi.spyOn(Connection.prototype, 'request').mockResolvedValue({
      pluginId: 'remnote-cli-bridge',
      nativeTransactions: broken === 'unavailable' ? false : true,
    });
    const close = vi.spyOn(Connection.prototype, 'close').mockResolvedValue();
    vi.mocked(verifiedCatalog).mockReturnValue({
      catalogSchemaVersion: 1,
      sdkVersion: '0.0.46',
      sdkCatalogHash: 'b'.repeat(64),
      capabilities: [],
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
        broken === 'unavailable'
          ? [false]
          : broken
            ? [true, true, false]
            : [true, true, true, true, true]
      );
      expect(transaction).toHaveBeenCalledTimes(broken === 'unavailable' ? 0 : broken ? 1 : 2);
      expect(close).toHaveBeenCalledTimes(broken ? 1 : 2);
      const receipt = JSON.parse(
        await readFile(`${directory}/${broken ? 'failure' : 'result'}.json`, 'utf8')
      );
      expect(receipt.ids).toEqual(
        broken === 'unavailable' ? {} : { root: 'r1', abortedChild: 'r2' }
      );
      expect(state.has('r2')).toBe(broken === true);
      if (broken === 'unavailable') expect(state.size).toBe(0);
    } finally {
      if (directory) await rm(directory, { recursive: true });
    }
  }
);
