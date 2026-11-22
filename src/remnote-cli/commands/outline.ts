import { emit } from '../output/runtime.js';
import { Command } from 'commander';
import { createCommandClient } from '../client/command-client.js';
import { formatResult, type OutputFormat } from '../output/formatter.js';
import type { CommandCatalog } from '../spec/command-spec.js';

function formatOutlineText(data: unknown): string {
  const result = data as Record<string, unknown>;
  const action = result.collapsed === true ? 'collapse' : 'expand';
  const mode = result.dryRun === true ? 'Preview' : 'Applied';
  return `${mode} ${action} for ${String(result.rootTitle)} [${String(result.rootRemId)}]: scanned=${String(result.scanned)}, eligible=${String(result.eligible)}, changed=${String(result.changed)}`;
}

function registerOutlineAction(
  outline: Command,
  program: Command,
  catalog: CommandCatalog,
  name: 'collapse' | 'expand',
  collapsed: boolean
): void {
  catalog
    .action(outline, name, {
      description: `${name === 'collapse' ? 'Collapse' : 'Expand'} every non-leaf Rem below a root Rem`,
      risk: 'write',
      bridge: 'required',
    })
    .option('--today', "Use today's daily document as the root")
    .option('--root-id <remId>', 'Root Rem ID')
    .option('--apply', 'Apply the change; otherwise preview only')
    .action(async (opts) => {
      const format: OutputFormat = program.opts().text ? 'text' : 'json';
      const client = createCommandClient(program);
      try {
        const payload: Record<string, unknown> = {
          collapsed,
          dryRun: opts.apply !== true,
        };
        if (opts.today) payload.today = true;
        if (opts.rootId) payload.rootRemId = opts.rootId;
        const result = await client.execute('set_outline_collapsed', payload);
        emit(program, formatResult(result, format, formatOutlineText));
      } finally {
        await client.close();
      }
    });
}

export function registerOutlineCommand(
  program: Command,
  catalog: CommandCatalog,
  parent: Command
): void {
  const outline = catalog.group(parent, 'outline', {
    description: 'Preview or change outline folding',
  });
  registerOutlineAction(outline, program, catalog, 'collapse', true);
  registerOutlineAction(outline, program, catalog, 'expand', false);
}
