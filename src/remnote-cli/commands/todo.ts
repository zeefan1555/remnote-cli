import { Command } from 'commander';
import { createCommandClient } from '../client/command-client.js';
import { EXIT } from '../config.js';
import { formatError, formatResult, type OutputFormat } from '../output/formatter.js';

function formatTodoListText(data: unknown): string {
  const todos = (data as { todos?: Array<Record<string, unknown>> }).todos ?? [];
  if (todos.length === 0) return 'No tagged todos found.';
  return todos
    .map((todo, index) => {
      const nativeStatus = todo.isTodo
        ? `native=${String(todo.todoStatus ?? 'unknown')}`
        : 'native=not-a-todo';
      return `${index + 1}. ${String(todo.title || '(untitled)')} [${String(todo.remId)}] ${nativeStatus}`;
    })
    .join('\n');
}

export function registerTodoCommand(program: Command): void {
  const todo = program.command('todo').description('Read tagged RemNote todos');
  todo.action(() => todo.outputHelp());

  todo
    .command('list')
    .description('List Rems carrying an exact TODO tag')
    .requiredOption('--tag-id <remId>', 'Exact TODO tag Rem ID')
    .action(async (opts) => {
      const format: OutputFormat = program.opts().text ? 'text' : 'json';
      const client = createCommandClient(program);
      try {
        const result = await client.execute('list_todos', { tagRemId: opts.tagId });
        console.log(formatResult(result, format, formatTodoListText));
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error), format));
        process.exitCode = EXIT.ERROR;
      } finally {
        await client.close();
      }
    });
}
