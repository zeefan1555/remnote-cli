import { AsyncLocalStorage } from 'node:async_hooks';
import type { Command } from 'commander';
import { DirectClient } from './direct-client.js';

const sharedClient = new AsyncLocalStorage<DirectClient>();

export function createCommandClient(program: Command): DirectClient {
  return sharedClient.getStore() ?? new DirectClient(program.opts());
}

/** Run inner CLI commands against one already retained client. */
export function runWithCommandClient<T>(client: DirectClient, fn: () => Promise<T>): Promise<T> {
  return sharedClient.run(client, fn);
}
