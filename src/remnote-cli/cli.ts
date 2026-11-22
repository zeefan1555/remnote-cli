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
  registerDeleteCommand,
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
  normalizeTrailingGroupHelp,
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
  program.configureHelp({ helpWidth: 120 });

  program
    .name('remnote-cli')
    .description('Direct RemNote SDK automation')
    .version(version)
    .option('--json', 'JSON output (default)')
    .option('--text', 'Human-readable output')
    .option('--verbose', 'Enable verbose stderr logging')
    .helpCommand('help [command]', 'display help for command');

  const rem = catalog.group(program, 'rem', {
    description: 'Inspect and modify RemNote Rems',
  });
  const children = catalog.group(rem, 'children', {
    description: 'Read or replace direct children',
  });
  const tags = catalog.group(rem, 'tags', {
    description: 'Update exact tag associations',
  });
  const property = catalog.group(rem, 'property', {
    description: 'Set or clear tag and table properties',
  });
  const document = catalog.group(rem, 'document', {
    description: 'Change document status',
  });
  const card = catalog.group(program, 'card', {
    description: 'Apply card tasks and inspect native review facts',
  });
  const table = catalog.group(program, 'table', {
    description: 'Read Advanced Tables',
  });
  const media = catalog.group(program, 'media', {
    description: 'Read RemNote-managed media',
  });
  const journal = catalog.group(program, 'journal', {
    description: 'Append to the daily journal',
  });

  registerCreateCommand(program, catalog, rem);
  registerSearchCommand(program, catalog, rem);
  registerSearchByTagCommand(program, catalog, rem);
  registerListChildrenCommand(program, catalog, children);
  registerReadCommand(program, catalog, rem);
  registerInspectCommand(program, catalog, rem);
  registerAssertCommand(program, catalog, rem);
  registerPowerupCommand(program, catalog, rem);
  registerCompositeCommands(program, catalog, rem);
  registerTaskCommands(program, catalog, card);
  registerReviewStatsCommand(program, catalog, card);
  registerOutlineCommand(program, catalog, rem);
  registerTodoCommand(program, catalog);
  registerGetMediaCommand(program, catalog, media);
  registerUpdateCommand(program, catalog, rem);
  registerInsertChildrenCommand(program, catalog, children);
  registerMoveNoteCommand(program, catalog, rem);
  registerDeleteCommand(program, catalog, rem);
  registerSetDocumentStatusCommand(program, catalog, document);
  registerReplaceChildrenCommand(program, catalog, children);
  registerUpdateTagsCommand(program, catalog, tags);
  registerSetPropertyCommand(program, catalog, property);
  registerJournalCommand(program, catalog, journal);
  registerReadTableCommand(program, catalog, table);
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

export async function runCli(
  argv = process.argv,
  runtime: CliRuntime = createProcessRuntime()
): Promise<number> {
  const program = createProgram(packageJson.version, runtime);
  return runProgram(program, argv, runtime);
}
