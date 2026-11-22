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
import { registerContractCommand } from './commands/contract.js';
import { registerSchemaCommand } from './commands/schema.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { CommanderError } from 'commander';
import type { CliRuntime } from './output/runtime.js';
import { bindRuntime, createProcessRuntime, finishProgram, runtimeFor } from './output/runtime.js';
import { CommandCatalog } from './spec/command-spec.js';
import {
  commandBoundaryFailure,
  installCommandHelpGroups,
  rootHelpRequested,
} from './spec/command-boundary.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json') as { version: string };

export function createProgram(
  version: string,
  runtime: CliRuntime = createProcessRuntime()
): Command {
  const program = new Command();
  const catalog = new CommandCatalog(program);

  program
    .name('remnote-cli')
    .description('Direct RemNote SDK automation')
    .version(version)
    .option('--json', 'JSON output (default)')
    .option('--text', 'Human-readable output')
    .option('--kb-id <id>', 'Require this exact active knowledge base')
    .option('--allow-destructive', 'Explicitly allow destructive SDK operations')
    .option('--verbose', 'Enable verbose stderr logging')
    .helpCommand('help [command]', 'display help for command');

  registerCreateCommand(program, catalog);
  registerSearchCommand(program, catalog);
  registerSearchByTagCommand(program, catalog);
  registerListChildrenCommand(program, catalog);
  registerReadCommand(program, catalog);
  registerInspectCommand(program, catalog);
  registerAssertCommand(program, catalog);
  registerPowerupCommand(program, catalog);
  registerCompositeCommands(program, catalog);
  registerTaskCommands(program, catalog);
  registerReviewStatsCommand(program, catalog);
  registerOutlineCommand(program, catalog);
  registerTodoCommand(program, catalog);
  registerGetMediaCommand(program, catalog);
  registerUpdateCommand(program, catalog);
  registerInsertChildrenCommand(program, catalog);
  registerMoveNoteCommand(program, catalog);
  registerSetDocumentStatusCommand(program, catalog);
  registerReplaceChildrenCommand(program, catalog);
  registerUpdateTagsCommand(program, catalog);
  registerSetPropertyCommand(program, catalog);
  registerJournalCommand(program, catalog);
  registerReadTableCommand(program, catalog);
  registerSyncCommands(program, catalog);
  registerBatchCommand(program, catalog, version);
  registerStatusCommand(program, catalog);
  registerSchemaCommand(program, catalog);
  registerDoctorCommand(program, catalog);
  registerContractCommand(program, catalog);
  registerSdkCommands(program, catalog);

  installCommandHelpGroups(program);
  bindRuntime(program, runtime);
  return program;
}

export async function runProgram(
  program: Command,
  argv: string[],
  runtime: CliRuntime = runtimeFor(program)
): Promise<number> {
  const normalizedArgv = normalizeTrailingGroupHelp(program, argv);
  try {
    const boundaryFailure = commandBoundaryFailure(program, normalizedArgv);
    if (boundaryFailure) {
      runtime.failure(boundaryFailure);
      return finishProgram(runtime);
    }
    if (rootHelpRequested(program, normalizedArgv)) {
      program.outputHelp();
      return finishProgram(runtime);
    }
    await program.parseAsync(normalizedArgv);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) {
      runtime.setExitCode(0);
      return 0;
    }
    runtime.failure(error);
  }
  return finishProgram(runtime);
}

function normalizeTrailingGroupHelp(program: Command, argv: string[]): string[] {
  if (argv.at(-1) !== 'help' || argv.slice(2, -1).includes('--')) return argv;
  let command = program;
  for (const token of argv.slice(2, -1)) {
    if (token.startsWith('-')) return argv;
    const child = command.commands.find((candidate) => candidate.name() === token);
    if (!child) return argv;
    command = child;
  }
  if (command === program || command.commands.length === 0) return argv;
  return [...argv.slice(0, -1), '--help'];
}

export async function runCli(
  argv = process.argv,
  runtime: CliRuntime = createProcessRuntime()
): Promise<number> {
  const program = createProgram(packageJson.version, runtime);
  return runProgram(program, argv, runtime);
}
