import { emit } from '../output/runtime.js';
import type { Command } from 'commander';
import { buildCliContract, contractSchema } from '../../schemas/contract.js';
import { formatResult } from '../output/formatter.js';
import { buildCommandSpecs, type CommandCatalog } from '../spec/command-spec.js';

export function registerContractCommand(program: Command, catalog: CommandCatalog): void {
  catalog
    .action(program, 'contract', {
      description: 'Print the offline machine-readable CLI contract',
      risk: 'read',
      bridge: 'none',
    })
    .option('--schema <name>', 'Print one plan schema: flashcards, wiki, or workspace')
    .action((options: { schema?: string }) => {
      const value = options.schema
        ? contractSchema(options.schema)
        : buildCliContract(buildCommandSpecs(program));
      emit(program, formatResult(value, 'json'));
    });
}
