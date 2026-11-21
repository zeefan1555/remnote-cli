import { registerBatchCommand } from './commands/batch.js';
import { registerCompositeCommands } from './commands/composite.js';
import { registerTaskCommands } from './commands/task.js';
import { Command } from 'commander';
import { createRequire } from 'node:module';
import { registerCreateCommand } from './commands/create.js';
import {
  registerListChildrenCommand,
  registerSearchByTagCommand,
  registerSearchCommand,
} from './commands/search.js';
import { registerReadCommand } from './commands/read.js';
import { registerAssertCommand, registerInspectCommand } from './commands/state.js';
import { registerPowerupCommand } from './commands/powerup.js';
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
import { registerSyncCommands } from './commands/sync.js';

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
    .option('--kb-id <id>', 'Require this exact active knowledge base')
    .option('--allow-destructive', 'Explicitly allow destructive SDK operations')
    .option('--verbose', 'Enable verbose stderr logging');

  registerCreateCommand(program);
  registerSearchCommand(program);
  registerSearchByTagCommand(program);
  registerListChildrenCommand(program);
  registerReadCommand(program);
  registerInspectCommand(program);
  registerAssertCommand(program);
  registerPowerupCommand(program);
  registerCompositeCommands(program);
  registerTaskCommands(program);
  registerBatchCommand(program, version);
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
  registerSyncCommands(program);

  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  const program = createProgram(packageJson.version);
  await program.parseAsync(argv);
}
