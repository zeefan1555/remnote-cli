import { AsyncLocalStorage } from 'node:async_hooks';
import type { Command } from 'commander';
import { DirectClient, type ClientOptions } from './direct-client.js';
import { runtimeFor } from '../output/runtime.js';

const sharedClient = new AsyncLocalStorage<DirectClient>();

export function createCommandClient(
  program: Command,
  overrides: Partial<ClientOptions> = {}
): DirectClient {
  const runtime = runtimeFor(program);
  return (
    sharedClient.getStore() ??
    new DirectClient({
      ...program.opts(),
      ...overrides,
      onDiagnostic: (text: string) => runtime.err(text),
    })
  );
}

/** Run inner CLI commands against one already retained client. */
export function runWithCommandClient<T>(client: DirectClient, fn: () => Promise<T>): Promise<T> {
  return sharedClient.run(client, fn);
}
