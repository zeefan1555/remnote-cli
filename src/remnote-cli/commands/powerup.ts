import { emit } from '../output/runtime.js';
import { Command } from 'commander';
import { createCommandClient } from '../client/command-client.js';
import { formatResult, type OutputFormat } from '../output/formatter.js';
import type { CommandCatalog } from '../spec/command-spec.js';

export function registerPowerupCommand(
  program: Command,
  catalog: CommandCatalog,
  parent: Command
): void {
  const powerup = catalog.group(parent, 'powerup', { description: 'Read powerup slots by code' });
  catalog
    .action(powerup, 'get', {
      description: 'Read one powerup slot from a Rem',
      risk: 'read',
      bridge: 'required',
    })
    .requiredOption('--rem <id>', 'Rem that carries the powerup')
    .requiredOption('--powerup <code>', 'Powerup code, for example sp')
    .requiredOption('--slot <code>', 'Slot code, for example q or f')
    .option('--as <kind>', 'value (default), richtext, or rem', 'value')
    .addHelpText(
      'after',
      [
        '',
        'Accepts a slot code or a slot name. The CLI maps a known built-in code to the name SDK 0.0.46 requires, then calls rem.getPowerupProperty (or the AsRichText / AsRem variant).',
        'Search portal: f becomes Filter and q becomes Query. A name, a custom powerup, or an unknown code is sent unchanged, and the host error is returned.',
        "The plugin passes those arguments through. This command does not rewrite them in the bridge, call a private RPC, or open RemNote's database.",
        'getPowerupByCode("sp") can return undefined for a built-in powerup. Read the slot on the Rem that carries it.',
        'Example: remnote-cli rem powerup get --rem REM_ID --powerup sp --slot f',
      ].join('\n')
    )
    .action(async (opts: { rem: string; powerup: string; slot: string; as: string }) => {
      const format: OutputFormat = program.opts().text ? 'text' : 'json';
      const client = createCommandClient(program);
      try {
        if (!['value', 'richtext', 'rem'].includes(opts.as))
          throw new Error('--as must be value, richtext, or rem');
        const result = await client.execute('powerup_get', {
          remId: opts.rem,
          powerup: opts.powerup,
          slot: opts.slot,
          as: opts.as,
        });
        emit(
          program,
          formatResult(result, format, (data) => {
            const row = data as { powerup?: string; slot?: string; value?: unknown };
            return `${row.powerup ?? ''}.${row.slot ?? ''} ${JSON.stringify(row.value)}`;
          })
        );
      } finally {
        await client.close();
      }
    });
}
