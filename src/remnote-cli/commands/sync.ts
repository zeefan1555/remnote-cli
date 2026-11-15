import { Option, type Command } from 'commander';
import {
  diffWorkspace,
  lintWorkspace,
  importWorkspace,
  pushWorkspace,
  statusWorkspace,
  recoverWorkspace,
  readWorkspace,
  saveWorkspace,
} from '../../business/workspace/workspace.js';
import { fileByteLimit } from '../../business/workspace/files.js';
import { formatWorkspace } from '../../business/workspace/format.js';
import { readContentFileOrStdin } from './content-input.js';
import { createCommandClient } from '../client/command-client.js';
import { formatError, formatResult } from '../output/formatter.js';

interface SyncOptions {
  apply?: boolean;
  planHash?: string;
  deleteId?: string;
  scopeRoot?: string;
  scope?: 'changed' | 'all';
  paths?: string[];
  rootId?: string;
  export?: string;
  snapshot?: string;
  editableRootId?: string;
  contentFile?: string;
  expectedFileHash?: string;
}

interface SelectionOptions {
  scope: 'changed' | 'all';
  path: string[];
  planHash?: string;
}

function pathOptions(command: Command): Command {
  return command.option(
    '--path <path>',
    'Select a vault-relative Markdown file or directory; repeatable, no globs',
    (value: string, paths: string[]) => paths.concat(value),
    [] as string[]
  );
}

export function registerSyncCommands(program: Command): void {
  const workspace = program
    .command('sync')
    .description('Synchronize local Markdown and RemNote through explicit bounded commands');

  async function execute(
    name: 'sync' | 'import' | 'status' | 'lint' | 'diff' | 'recover' | 'read' | 'save' | 'format',
    directory: string,
    options: SyncOptions,
    path?: string
  ): Promise<void> {
    const format = program.opts().text ? 'text' : 'json';
    const client = createCommandClient(program);
    try {
      let result: unknown;
      if (name === 'read') result = await readWorkspace(directory, path!);
      else if (name === 'format') result = await formatWorkspace(directory);
      else if (name === 'save')
        result = await saveWorkspace(
          directory,
          path!,
          await readContentFileOrStdin(options.contentFile!, process.stdin, fileByteLimit(path!)),
          options.expectedFileHash!
        );
      else if (name === 'import') {
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

  for (const name of ['plan', 'apply'] as const) {
    const command = pathOptions(workspace.command(name + ' <directory>'))
      .description(
        name === 'plan'
          ? 'Preview bidirectional synchronization with zero native writes'
          : 'Plan, check, apply and verify synchronization in one invocation'
      )
      .addOption(
        new Option('--scope <scope>', 'Reconcile local changes or all bound IDs in selected paths')
          .choices(['changed', 'all'])
          .default('changed')
      );
    if (name === 'apply')
      command.option('--plan-hash <sha256>', 'Require this exact previous preview when applying');
    command.action(async (directory: string, { path, ...options }: SelectionOptions) =>
      execute('sync', directory, { ...options, paths: path, apply: name === 'apply' })
    );
  }
  workspace
    .command('delete <directory>')
    .description('Preview explicit deletion of an exact note/card and its bounded descendants')
    .requiredOption('--id <id>', 'Exact note/card to delete')
    .requiredOption('--scope-root <id>', 'Exact ancestor boundary for deletion')
    .option('--apply', 'Apply the reviewed deletion with destructive authorization and live gates')
    .option('--plan-hash <sha256>', 'Exact deletion preview hash required with --apply')
    .action(
      async (
        directory: string,
        { id, ...options }: SyncOptions & { id: string },
        command: Command
      ) => {
        if (options.apply && !options.planHash)
          command.error('sync delete --apply requires --plan-hash', {
            code: 'commander.missingMandatoryOptionValue',
          });
        await execute('sync', directory, {
          ...options,
          apply: options.apply === true,
          deleteId: id,
        });
      }
    );
  workspace
    .command('read <directory> <path>')
    .description('Read local Markdown and its exact fileHash offline')
    .action(async (directory: string, path: string) => execute('read', directory, {}, path));
  workspace
    .command('save <directory> <path>')
    .description('Save local Markdown offline and bind changed Rem content to this save time')
    .requiredOption('--content-file <path|->', 'Complete edited Markdown file, or - for stdin')
    .requiredOption('--expected-file-hash <sha256>', 'Exact fileHash returned by sync read')
    .action(async (directory: string, path: string, options: SyncOptions) =>
      execute('save', directory, options, path)
    );
  for (const name of ['import', 'status', 'lint', 'diff', 'recover', 'format'] as const) {
    const command = workspace.command(name + ' <directory>').description(
      {
        import: 'Create the first baseline in an empty directory; use sync apply for later changes',
        status: 'Offline local-source status',
        lint: 'Offline native metadata, outline, card and identity validation',
        diff: 'Offline supported changes; never infer deletion or movement',
        recover: 'Finish staged local publication without remote writes',
        format: 'Offline canonical formatting of a clean sealed publication as human Markdown',
      }[name]
    );
    if (name === 'import')
      command
        .option('--root-id <id>', 'Import only this exact subtree into a new dedicated directory')
        .option('--export <file>', 'Official full JSON .rem export; collect public SDK snapshots')
        .option('--snapshot <file>', 'Exact archive-bound public SDK snapshot and native facts')
        .option('--editable-root-id <id>', 'Verify this subtree completely during official import');
    if (name === 'diff')
      pathOptions(command).action(async (directory: string, options: { path: string[] }) =>
        execute(name, directory, { paths: options.path })
      );
    else
      command.action(async (directory: string, options: SyncOptions) =>
        execute(name, directory, options)
      );
  }
}
