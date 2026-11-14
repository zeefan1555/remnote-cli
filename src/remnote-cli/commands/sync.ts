import type { Command } from 'commander';
import {
  diffWorkspace,
  lintWorkspace,
  importWorkspace,
  pushWorkspace,
  statusWorkspace,
  recoverWorkspace,
} from '../../business/workspace/workspace.js';
import { createCommandClient } from '../client/command-client.js';
import { formatError, formatResult } from '../output/formatter.js';

interface SyncOptions {
  apply?: boolean;
  planHash?: string;
  deleteId?: string;
  scopeRoot?: string;
  rootId?: string;
  export?: string;
  snapshot?: string;
  editableRootId?: string;
}

function deletionOptions(command: Command): Command {
  return command
    .option('--delete-id <id>', 'Explicitly preview deletion of this note/card and its descendants')
    .option('--scope-root <id>', 'Required exact ancestor boundary for explicit deletion');
}

export function registerSyncCommands(program: Command): void {
  const workspace = deletionOptions(
    program
      .command('sync [directory]')
      .description('Preview per-Rem three-way synchronization between local Markdown and RemNote')
      .option('--apply', 'Apply the exact previously previewed plan')
      .option('--plan-hash <sha256>', 'Exact plan hash returned by sync preview')
  );

  async function execute(
    name: 'sync' | 'import' | 'status' | 'lint' | 'diff' | 'recover',
    directory: string,
    options: SyncOptions
  ): Promise<void> {
    const format = program.opts().text ? 'text' : 'json';
    const client = createCommandClient(program);
    try {
      let result: unknown;
      if (name === 'import') {
        const kbId = program.opts().kbId;
        if (!kbId) throw new Error('sync import requires explicit --kb-id');
        result = await importWorkspace(directory, kbId, () => client.workspaceBackend(), options);
      } else if (name === 'recover')
        result = await recoverWorkspace(directory, () => client.workspaceBackend());
      else if (name === 'status') result = await statusWorkspace(directory);
      else if (name === 'lint') result = await lintWorkspace(directory);
      else if (name === 'diff') result = await diffWorkspace(directory, options);
      else result = await pushWorkspace(directory, () => client.workspaceBackend(), options);
      console.log(
        formatResult(result, format, (data) => {
          const value = data as {
            diagnostics?: Array<{ path: string; line: number; code: string; message: string }>;
          };
          return value.diagnostics?.length
            ? value.diagnostics
                .map((d) => d.path + ':' + d.line + ' / ' + d.code + ' / ' + d.message)
                .join('\n')
            : JSON.stringify(data, null, 2);
        })
      );
      if (
        (result as { ok?: boolean; complete?: boolean }).ok === false ||
        (result as { complete?: boolean }).complete === false
      )
        process.exitCode = 1;
    } catch (error) {
      console.error(formatError(error instanceof Error ? error.message : String(error), format));
      process.exitCode = 1;
    } finally {
      await client.close();
    }
  }

  workspace.action(async (directory: string | undefined, options: SyncOptions) => {
    if (!directory) {
      workspace.outputHelp();
      return;
    }
    await execute('sync', directory, options);
  });
  for (const name of ['import', 'status', 'lint', 'diff', 'recover'] as const) {
    const command = workspace.command(name + ' <directory>').description(
      {
        import: 'Create the first local baseline in an empty directory; use sync for later changes',
        status: 'Offline local-source status',
        lint: 'Offline native metadata, outline, card and identity validation',
        diff: 'Offline supported changes; never infer deletion or movement',
        recover: 'Finish staged local publication without remote writes',
      }[name]
    );
    if (name === 'import')
      command
        .option('--root-id <id>', 'Import only this exact subtree into a new dedicated directory')
        .option('--export <file>', 'Official full JSON .rem export; collect public SDK snapshots')
        .option('--snapshot <file>', 'Exact archive-bound public SDK snapshot and native facts')
        .option('--editable-root-id <id>', 'Verify this subtree completely during official import');
    if (name === 'diff') deletionOptions(command);
    command.action(async (directory: string, options: SyncOptions) =>
      execute(name, directory, options)
    );
  }
}
