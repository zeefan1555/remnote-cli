import type { Command } from 'commander';
import { buildCliContract, contractSchema } from '../../schemas/contract.js';
import { EXIT } from '../config.js';

export function registerContractCommand(program: Command): void {
  program
    .command('contract')
    .description('Print the offline machine-readable CLI contract')
    .option('--schema <name>', 'Print one plan schema: flashcards, wiki, or workspace')
    .action((options: { schema?: string }) => {
      try {
        const value = options.schema ? contractSchema(options.schema) : buildCliContract();
        console.log(JSON.stringify(value, null, 2));
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = EXIT.ERROR;
      }
    });
}
