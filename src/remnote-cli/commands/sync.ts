import { Option, type Command } from 'commander';
import {
  diffWorkspace,
  lintWorkspace,
  importWorkspace,
  pushWorkspace,
  statusWorkspace,
  recoverWorkspace,
  resumeWorkspace,
  readWorkspace,
  saveWorkspace,
} from '../../business/workspace/workspace.js';
import { fileByteLimit } from '../../business/workspace/files.js';
import { formatWorkspace } from '../../business/workspace/format.js';
import { relocateWorkspace } from '../../business/workspace/relocate.js';
import { alignWorkspaceBaseline } from '../../business/workspace/baseline.js';
import { readContentFileOrStdin } from './content-input.js';
import { createCommandClient } from '../client/command-client.js';
import { formatError, formatResult } from '../output/formatter.js';
import {
  acknowledgeFeedback,
  bindFeedbackRoles,
  captureFeedback,
} from '../../business/workspace/feedback.js';

interface SyncOptions {
  apply?: boolean;
  planHash?: string;
  scope?: 'changed' | 'all';
  paths?: string[];
  rootId?: string;
  export?: string;
  snapshot?: string;
  editableRootId?: string;
  contentFile?: string;
  expectedFileHash?: string;
  acceptNewParent?: string[];
  acceptNewChild?: string[];
  acceptNativeSource?: boolean;
}

interface SelectionOptions {
  scope: 'changed' | 'all';
  path: string[];
  planHash?: string;
  expectedFileHash?: string;
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
    .description('Publish local-authoritative Markdown to RemNote through bounded commands');

  const feedback = workspace
    .command('feedback')
    .description('Explicit exact feedback binding, capture and proof-gated acknowledgment');
  const runFeedback = async (
    operation: (
      factory: () => ReturnType<ReturnType<typeof createCommandClient>['workspaceBackend']>
    ) => Promise<unknown>
  ) => {
    const client = createCommandClient(program),
      format = program.opts().text ? 'text' : 'json';
    try {
      console.log(
        formatResult(await operation(() => client.workspaceBackend()), format, (data) =>
          JSON.stringify(data, null, 2)
        )
      );
    } catch (error) {
      console.error(formatError(error instanceof Error ? error.message : String(error), format));
      process.exitCode = 1;
    } finally {
      await client.close();
    }
  };
  feedback
    .command('bind <directory>')
    .description('Bind exact lifecycle tags on clean aligned source; no native or Markdown writes')
    .requiredOption('--todo-tag-id <id>', 'Already sealed native TODO tag ID')
    .requiredOption('--done-tag-id <id>', 'Already sealed native DONE tag ID')
    .action(async (directory: string, options: { todoTagId: string; doneTagId: string }) =>
      runFeedback((factory) => bindFeedbackRoles(directory, factory, options))
    );
  feedback
    .command('capture <directory>')
    .description(
      'Capture one exact non-canonical physical feedback attachment into a private receipt'
    )
    .requiredOption('--id <id>', 'Exact feedback Rem ID')
    .requiredOption(
      '--target-id <id>',
      'Exact canonical target; repeatable',
      (value: string, ids: string[]) => ids.concat(value),
      []
    )
    .action(async (directory: string, options: { id: string; targetId: string[] }) =>
      runFeedback((factory) => captureFeedback(directory, factory, options.id, options.targetId))
    );
  feedback
    .command('ack <directory>')
    .description(
      'Acknowledge or resume acknowledgment only after exact guarded publication; never republishes'
    )
    .requiredOption('--receipt <hash>', 'Exact captured feedback receipt')
    .requiredOption('--plan-hash <hash>', 'Completed guarded publisher plan')
    .action(async (directory: string, options: { receipt: string; planHash: string }) =>
      runFeedback((factory) =>
        acknowledgeFeedback(directory, factory, options.receipt, options.planHash)
      )
    );

  async function execute(
    name:
      | 'sync'
      | 'import'
      | 'status'
      | 'lint'
      | 'diff'
      | 'recover'
      | 'resume'
      | 'read'
      | 'save'
      | 'relocate'
      | 'baseline-align'
      | 'format',
    directory: string,
    options: SyncOptions,
    path?: string
  ): Promise<void> {
    const format = program.opts().text ? 'text' : 'json';
    const client = createCommandClient(program);
    try {
      let result: unknown;
      if (name === 'read') result = await readWorkspace(directory, path!);
      else if (name === 'relocate') result = await relocateWorkspace(directory, path!);
      else if (name === 'format') result = await formatWorkspace(directory);
      else if (name === 'baseline-align')
        result = await alignWorkspaceBaseline(directory, () => client.workspaceBackend(), options);
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
      else if (name === 'resume')
        result = await resumeWorkspace(
          directory,
          () => client.workspaceBackend(),
          options.planHash!
        );
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
          ? 'Preview local-authoritative publication with zero native writes'
          : 'Plan, check, apply and verify synchronization in one invocation'
      )
      .addOption(
        new Option('--scope <scope>', 'Reconcile local changes or all bound IDs in selected paths')
          .choices(['changed', 'all'])
          .default('changed')
      );
    if (name === 'apply')
      command
        .option('--plan-hash <sha256>', 'Require this exact previous preview when applying')
        .option(
          '--expected-file-hash <sha256>',
          'Guard one exact --path from sync read and return full native file verification (includes cards/history and known Powerup codes; slower than the default probe)'
        );
    command.action(async (directory: string, { path, ...options }: SelectionOptions) =>
      execute('sync', directory, { ...options, paths: path, apply: name === 'apply' })
    );
  }
  pathOptions(workspace.command('baseline-align <directory>'))
    .description(
      'Preview missing native tag/null-portal observations and readonly seals; never write RemNote'
    )
    .option('--apply', 'Publish the exact reviewed local baseline alignment')
    .option('--plan-hash <sha256>', 'Exact preview hash required with --apply')
    .option('--accept-native-source', 'Disabled: native feedback ownership cannot be proven')
    .option(
      '--accept-new-parent <id>',
      'Disabled: native feedback ownership cannot be proven',
      (value: string, ids: string[] = []) => ids.concat(value)
    )
    .option(
      '--accept-new-child <id>',
      'Disabled: native feedback ownership cannot be proven',
      (value: string, ids: string[] = []) => ids.concat(value)
    )
    .action(
      async (
        directory: string,
        { path, ...options }: SyncOptions & { path: string[] },
        command: Command
      ) => {
        if (options.apply && !options.planHash)
          command.error('sync baseline-align --apply requires --plan-hash', {
            code: 'commander.missingMandatoryOptionValue',
          });
        await execute('baseline-align', directory, { ...options, paths: path });
      }
    );
  workspace
    .command('resume <directory>')
    .description(
      'Reconcile exact IDs for the original interrupted plan, then continue only unattempted writes'
    )
    .requiredOption(
      '--plan-hash <sha256>',
      'Exact original interrupted plan hash; no selector changes'
    )
    .action(async (directory: string, options: SyncOptions) =>
      execute('resume', directory, options)
    );
  workspace
    .command('relocate <directory> <destination>')
    .description('Relocate a bound private workspace offline without changing note identities')
    .action(async (directory: string, destination: string) =>
      execute('relocate', directory, {}, destination)
    );
  workspace
    .command('read <directory> <path>')
    .description('Read local Markdown and its exact fileHash offline')
    .action(async (directory: string, path: string) => execute('read', directory, {}, path));
  workspace
    .command('save <directory> <path>')
    .description('Save local Markdown offline under the current source hash')
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
        diff: 'Offline supported changes and local deletion intent; no native movement',
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
