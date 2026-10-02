import { registerCompositeCommands } from './commands/composite.js';
import { registerTaskCommands } from './commands/task.js';
import { Command } from 'commander';
import { createRequire } from 'node:module';
import { createPairing } from './client/connection-config.js';
import { registerCreateCommand } from './commands/create.js';
import {
  registerListChildrenCommand,
  registerSearchByTagCommand,
  registerSearchCommand,
} from './commands/search.js';
import { registerReadCommand } from './commands/read.js';
import { registerUpdateCommand } from './commands/update.js';
import {
  registerInsertChildrenCommand,
  registerMoveNoteCommand,
  registerReplaceChildrenCommand,
  registerSetDocumentStatusCommand,
  registerSetPropertyCommand,
  registerUpdateTagsCommand,
} from './commands/write-actions.js';
import { registerJournalCommand } from './commands/journal.js';
import { registerStatusCommand } from './commands/status.js';
import { registerReadTableCommand } from './commands/table.js';
import { registerGetMediaCommand } from './commands/media.js';
import { registerReviewStatsCommand } from './commands/review-stats.js';
import { registerSdkCommands } from './commands/sdk.js';
import { registerOutlineCommand } from './commands/outline.js';
import { registerTodoCommand } from './commands/todo.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json') as { version: string };

export function createProgram(version: string): Command {
  const program = new Command();

  program
    .name('remnote-cli')
    .description('Direct RemNote SDK automation')
    .version(version)
    .option('--json', 'JSON output (default)')
    .option('--text', 'Human-readable output')
    .option('--port <number>', 'Loopback WebSocket port (default: paired port)')
    .option('--kb-id <id>', 'Require this exact knowledge base')
    .option('--allow-destructive', 'Explicitly allow destructive SDK operations')
    .option('--verbose', 'Enable verbose stderr logging');

  program
    .command('pair')
    .description('Create a private pairing file using --kb-id; enter its token once in the plugin')
    .action(async () => {
      try {
        const opts = program.opts();
        if (!opts.kbId) throw new Error('pair requires --kb-id <id>');
        const path = await createPairing(opts.kbId, Number(opts.port ?? 3002));
        console.log(
          JSON.stringify({
            configPath: path,
            paired: false,
            next: 'Enter the private token in the plugin, then run status.',
          })
        );
      } catch (error) {
        console.error(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
        );
        process.exitCode = 1;
      }
    });
  registerCreateCommand(program);
  registerSearchCommand(program);
  registerSearchByTagCommand(program);
  registerListChildrenCommand(program);
  registerReadCommand(program);
  registerCompositeCommands(program);
  registerTaskCommands(program);
  registerReviewStatsCommand(program);
  registerOutlineCommand(program);
  registerTodoCommand(program);
  registerSdkCommands(program);
  registerGetMediaCommand(program);
  registerUpdateCommand(program);
  registerInsertChildrenCommand(program);
  registerMoveNoteCommand(program);
  registerSetDocumentStatusCommand(program);
  registerReplaceChildrenCommand(program);
  registerUpdateTagsCommand(program);
  registerSetPropertyCommand(program);
  registerJournalCommand(program);
  registerStatusCommand(program);
  registerReadTableCommand(program);

  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = createProgram(packageJson.version);
  await program.parseAsync(argv);
}
