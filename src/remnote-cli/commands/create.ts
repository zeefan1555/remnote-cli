import { emit } from '../output/runtime.js';
import { Command } from 'commander';
import { createCommandClient } from '../client/command-client.js';
import { formatResult, type OutputFormat } from '../output/formatter.js';
import { resolveOptionalInlineOrFileContent } from './content-input.js';
import { checkPayloadForFlags, validateNotFlag } from './arg-utils.js';
import type { CommandCatalog } from '../spec/command-spec.js';

export interface CreateCommandInput extends Record<string, unknown> {
  title?: string;
  content?: string;
  parentId?: string;
  tagRemIds?: string[];
  asDocument?: boolean;
  aliases?: string[];
}

export async function executeCreate(
  program: Command,
  payload: CreateCommandInput,
  action: 'create_note' | 'create_card' = 'create_note'
): Promise<void> {
  const globalOpts = program.opts();
  const format: OutputFormat = globalOpts.text ? 'text' : 'json';
  const client = createCommandClient(program);

  try {
    const result = await client.execute(action, payload);
    emit(
      program,
      formatResult(result, format, (data) => {
        const r = data as { remIds?: string[]; titles?: string[] };
        const ids = r.remIds || [];
        const titles = r.titles || [];
        if (ids.length === 0) return 'No Rems created.';
        return titles
          .map((t, i) => `Created: ${t || '(untitled)'} (ID: ${ids[i] || 'unknown'})`)
          .join('\n');
      })
    );
  } finally {
    await client.close();
  }
}

export function registerCreateCommand(
  program: Command,
  catalog: CommandCatalog,
  parent: Command
): void {
  const subprogram = catalog.action(parent, 'create [title]', {
    description: 'Create a generic note or Rem; newly created non-leaf Rems are collapsed',
    risk: 'write',
    bridge: 'required',
  });
  const validate = (val: string) => validateNotFlag(val, subprogram);

  subprogram
    .option('--title <text>', 'Note title (supports [[id:<remId>]] references)', validate)
    .option(
      '-c, --content <text>',
      'Note content (markdown supported; use [[id:<remId>]] for exact references)',
      validate
    )
    .option('--content-file <path>', 'Read note content from UTF-8 file ("-" for stdin)', validate)
    .option('--parent-id <id>', 'Parent Rem ID', validate)
    .option('--tag-ids <tagRemIds...>', 'Exact tag Rem IDs to add')
    .option('--as-document', 'Mark the created title/root Rem as a document')
    .option('--aliases <aliases...>', 'Real aliases to add to the explicit title/root Rem')
    .addHelpText(
      'after',
      '\nTo create review cards with RemNote card text syntax, run:\n  remnote-cli card create --help'
    )
    .action(async (titleArg: string | undefined, opts) => {
      const payload: CreateCommandInput = {};
      // Validate shifting flags for positional arguments
      checkPayloadForFlags({ title: titleArg }, subprogram);
      const title = titleArg !== undefined ? titleArg : (opts.title as string | undefined);

      if (title !== undefined) payload.title = title;

      const content = await resolveOptionalInlineOrFileContent({
        inlineText: opts.content as string | undefined,
        filePath: opts.contentFile as string | undefined,
        inlineFlag: '--content',
        fileFlag: '--content-file',
      });

      if (content !== undefined) payload.content = content;
      if (opts.parentId) payload.parentId = opts.parentId;
      if (opts.tagIds && opts.tagIds.length > 0) payload.tagRemIds = opts.tagIds;
      if (opts.asDocument) payload.asDocument = true;
      if (opts.aliases && opts.aliases.length > 0) payload.aliases = opts.aliases;
      await executeCreate(program, payload);
    });
}
