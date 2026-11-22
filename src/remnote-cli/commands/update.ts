import { emit } from '../output/runtime.js';
import { Command } from 'commander';
import { createCommandClient } from '../client/command-client.js';
import { formatResult, type OutputFormat } from '../output/formatter.js';
import { validateNotFlag } from './arg-utils.js';
import type { CommandCatalog } from '../spec/command-spec.js';
import { UpdateNoteSchema, UpdateAnswerSchema } from '../../schemas/remnote-schemas.js';
import { readContentFileOrStdin, resolveOptionalInlineOrFileContent } from './content-input.js';

export function registerUpdateCommand(
  program: Command,
  catalog: CommandCatalog,
  parent: Command
): void {
  const subprogram = catalog.action(parent, 'update <rem-id>', {
    description: 'Update note metadata or replace its own text without replacing children',
    risk: 'write',
    bridge: 'required',
  });
  const validate = (val: string) => validateNotFlag(val, subprogram);

  subprogram
    .option('--title <text>', 'New title (supports [[id:<remId>]] references)', validate)
    .option(
      '--content <text|->',
      'Replacement own text; "-" reads stdin; supports Markdown and [[id:<remId>]]',
      validate
    )
    .option(
      '--expected-text-hash <sha256>',
      'SHA-256 of current raw text, not the title or card hash; required with --content',
      validate
    )
    .option('--add-aliases <aliases...>', 'Real aliases to add')
    .option('--remove-aliases <aliases...>', 'Real aliases to remove by normalized match')
    .addHelpText(
      'after',
      '\n--content replaces only this Rem text. It does not replace children.\nUse [[id:<remId>]] for native references, as with rem create.\nContent updates check raw text hash, parent, children, card-item, CardIDs, scheduling and available history.\nA failed write/readback has an unknown outcome. Inspect exact IDs before another write.\n--content cannot be combined with --title, --add-aliases, or --remove-aliases. Run separate commands.\n--title and alias updates retain their existing metadata update behavior.'
    )
    .action(async (remId: string, opts) => {
      const globalOpts = program.opts();
      const format: OutputFormat = globalOpts.text ? 'text' : 'json';
      const client = createCommandClient(program);

      try {
        const payload: Record<string, unknown> = { remId };
        if (opts.content !== undefined) payload.content = opts.content;
        if (opts.expectedTextHash !== undefined) payload.expectedTextHash = opts.expectedTextHash;
        if (opts.title !== undefined) payload.title = opts.title;
        if (opts.addAliases?.length > 0) payload.addAliases = opts.addAliases;
        if (opts.removeAliases?.length > 0) payload.removeAliases = opts.removeAliases;

        const input = UpdateNoteSchema.parse(payload);
        if (input.content !== undefined) input.content = await updateContent(input.content);
        const result = await client.execute('update_note', input);
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

  const answer = catalog.action(parent, 'update-answer <answer-rem-id>', {
    description: 'Replace an existing direct card-item child text and verify card identity/history',
    risk: 'write',
    bridge: 'required',
  });
  const validateAnswer = (value: string) => validateNotFlag(value, answer);
  answer
    .requiredOption(
      '--card-id <rem-id>',
      'Exact card-generating parent Rem ID, not a generated CardID',
      validateAnswer
    )
    .requiredOption(
      '--content <text|->',
      'Replacement answer text; "-" reads stdin; supports Markdown and [[id:<remId>]]',
      validateAnswer
    )
    .requiredOption(
      '--expected-text-hash <sha256>',
      'SHA-256 of current answer raw text, not the title or card hash',
      validateAnswer
    )
    .addHelpText(
      'after',
      '\nThe target must already be a card-item and a direct child of --card-id.\n--card-id is the parent Rem ID, not a generated CardID. No card is created or converted.\nUnavailable review history remains null in the receipt. Failed readback must be reconciled before another write.'
    )
    .action(async (remId: string, opts) => {
      const client = createCommandClient(program);
      try {
        const input = UpdateAnswerSchema.parse({
          remId,
          cardId: opts.cardId,
          content: opts.content,
          expectedTextHash: opts.expectedTextHash,
        });
        input.content = await updateContent(input.content);
        const result = await client.execute('update_answer', input);
        emit(
          program,
          formatResult(
            result,
            program.opts().text ? 'text' : 'json',
            () => `Updated answer ${remId}; card identity and history verified`
          )
        );
      } finally {
        await client.close();
      }
    });
}

async function updateContent(content: string): Promise<string> {
  if (content === '-') return readContentFileOrStdin('-');
  return (await resolveOptionalInlineOrFileContent({
    inlineText: content,
    filePath: undefined,
    inlineFlag: '--content',
    fileFlag: '--content-file',
  }))!;
}
