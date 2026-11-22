import { emit } from '../output/runtime.js';
import { Command } from 'commander';
import { createCommandClient } from '../client/command-client.js';
import { formatResult, type OutputFormat } from '../output/formatter.js';
import { validateNotFlag } from './arg-utils.js';
import type { CommandCatalog } from '../spec/command-spec.js';

export function registerUpdateCommand(
  program: Command,
  catalog: CommandCatalog,
  parent: Command
): void {
  const subprogram = catalog.action(parent, 'update <rem-id>', {
    description: 'Update note metadata',
    risk: 'write',
    bridge: 'required',
  });
  const validate = (val: string) => validateNotFlag(val, subprogram);

  subprogram
    .option('--title <text>', 'New title (supports [[id:<remId>]] references)', validate)
    .option('--add-aliases <aliases...>', 'Real aliases to add')
    .option('--remove-aliases <aliases...>', 'Real aliases to remove by normalized match')
    .action(async (remId: string, opts) => {
      const globalOpts = program.opts();
      const format: OutputFormat = globalOpts.text ? 'text' : 'json';
      const client = createCommandClient(program);

      try {
        if (
          opts.title === undefined &&
          (!opts.addAliases || opts.addAliases.length === 0) &&
          (!opts.removeAliases || opts.removeAliases.length === 0)
        ) {
          throw new Error(
            'Provide --title, --add-aliases, or --remove-aliases for update. Use insert-children, replace-children, or update-tags for other writes.'
          );
        }

        const payload: Record<string, unknown> = { remId };
        if (opts.title !== undefined) payload.title = opts.title;
        if (opts.addAliases?.length > 0) payload.addAliases = opts.addAliases;
        if (opts.removeAliases?.length > 0) payload.removeAliases = opts.removeAliases;

        const result = await client.execute('update_note', payload);
        emit(
          program,
          formatResult(result, format, (data) => {
            const r = data as { remIds?: string[]; titles?: string[] };
            const ids = r.remIds || [];
            const titles = r.titles || [];
            if (ids.length === 0) return `Updated note ${remId} (no Rems created)`;
            return titles
              .map((t, i) => `Updated/Created: ${t || '(untitled)'} (ID: ${ids[i] || 'unknown'})`)
              .join('\n');
          })
        );
      } finally {
        await client.close();
      }
    });
}
