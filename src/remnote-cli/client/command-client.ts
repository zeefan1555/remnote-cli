import type { Command } from 'commander';
import { DirectClient } from './direct-client.js';
export function createCommandClient(program: Command): DirectClient {
  return new DirectClient(program.opts());
}
