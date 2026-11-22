import { emit } from '../output/runtime.js';
import type { Command } from 'commander';
import { buildCliContract, contractSchema } from '../../schemas/contract.js';
import { formatResult } from '../output/formatter.js';

export function registerContractCommand(program: Command): void {
  program
    .command('contract')
    .description('Print the offline machine-readable CLI contract')
    .option('--schema <name>', 'Print one plan schema: flashcards, wiki, or workspace')
    .action((options: { schema?: string }) => {
      const value = options.schema ? contractSchema(options.schema) : buildCliContract();
      emit(program, formatResult(value, 'json'));
    });
}
