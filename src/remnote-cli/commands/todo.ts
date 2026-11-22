import { emit } from '../output/runtime.js';
import { Command, Option } from 'commander';
import { createCommandClient } from '../client/command-client.js';
import { formatResult, type OutputFormat } from '../output/formatter.js';
import type { CommandCatalog } from '../spec/command-spec.js';

function formatTodoListText(data: unknown): string {
  const result = data as {
    status?: string;
    todos?: Array<Record<string, unknown>>;
  };
  const todos = result.todos ?? [];
  if (todos.length === 0) return `No ${result.status ?? 'matching'} native todos found.`;
  return todos
    .map((todo, index) => {
      return `${index + 1}. ${String(todo.title || '(untitled)')} [${String(todo.remId)}] native=${String(todo.todoStatus)}`;
    })
    .join('\n');
}

function formatTodoUpdateText(data: unknown): string {
  const result = data as Record<string, unknown>;
  return `${result.dryRun === true ? 'Preview' : 'Applied'} native TODO update for ${String(result.title)} [${String(result.remId)}]: changed=${String(result.changed)}, status=${String(result.newTodoStatus)}`;
}

function registerTodoUpdate(
  todo: Command,
  program: Command,
  catalog: CommandCatalog,
  name: 'complete' | 'reopen',
  finished: boolean
): void {
  catalog
    .action(todo, `${name} <rem-id>`, {
      description: `${name === 'complete' ? 'Complete' : 'Reopen'} a native RemNote TODO`,
      risk: 'write',
      bridge: 'required',
    })
    .option('--apply', 'Apply the change; otherwise preview only')
    .action(async (remId: string, opts) => {
      const format: OutputFormat = program.opts().text ? 'text' : 'json';
      const client = createCommandClient(program);
      try {
        const result = await client.execute('update_todo', {
          remId,
          finished,
          dryRun: opts.apply !== true,
        });
        emit(program, formatResult(result, format, formatTodoUpdateText));
      } finally {
        await client.close();
      }
    });
}

export function registerTodoCommand(program: Command, catalog: CommandCatalog): void {
  const todo = catalog.group(program, 'todo', {
    description: 'List and update native RemNote todos',
  });

  const list = catalog.action(todo, 'list', {
    description: 'List native RemNote TODOs; unfinished by default',
    risk: 'read',
    bridge: 'required',
  });
  list
    .requiredOption('--root-id <id>', 'Inspect this native Rem and all of its descendants')
    .addOption(
      new Option('--status <status>', 'Filter by native TODO status')
        .choices(['unfinished', 'finished', 'all'])
        .default('unfinished')
    )
    .action(async (opts) => {
      const format: OutputFormat = program.opts().text ? 'text' : 'json';
      const client = createCommandClient(program);
      try {
        const result = await client.execute('list_todos', {
          status: opts.status,
          rootRemId: opts.rootId,
        });
        emit(program, formatResult(result, format, formatTodoListText));
      } finally {
        await client.close();
      }
    });

  registerTodoUpdate(todo, program, catalog, 'complete', true);
  registerTodoUpdate(todo, program, catalog, 'reopen', false);
}
