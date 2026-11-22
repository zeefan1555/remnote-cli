import { emit } from '../output/runtime.js';
import type { Command } from 'commander';
import { buildCliContract } from '../../schemas/contract.js';
import { formatResult } from '../output/formatter.js';
import { buildCommandSpecs, type CommandCatalog } from '../spec/command-spec.js';

export function registerContractCommand(program: Command, catalog: CommandCatalog): void {
  catalog
    .action(program, 'contract', {
      description: 'Print the offline machine-readable CLI contract',
      risk: 'read',
      bridge: 'none',
    })
    .action(() => {
      const value = buildCliContract(buildCommandSpecs(program));
      emit(program, formatResult(value, 'json'));
    });
}
