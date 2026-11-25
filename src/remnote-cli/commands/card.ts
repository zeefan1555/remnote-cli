import { Command } from 'commander';
import type { CommandCatalog } from '../spec/command-spec.js';
import { validateNotFlag } from './arg-utils.js';
import { executeCreate, type CreateCommandInput } from './create.js';

const helpText = `
Content uses RemNote's official card text syntax. Examples:

  remnote-cli card create --content "Question >> Answer"

Write multiline text as ordinary Markdown with real newlines:

remnote-cli card create \\
  --content '- Question >>>
  - Why
  - Reason

  - How
  - Action' \\
  --parent-id <PARENT_REM_ID>

One blank line between answer bullets marks a section boundary. card create
converts it to RemNote's empty answer item, so the card keeps readable spacing.
Leading, trailing and multi-card blank lines are removed.

One --content value may contain multiple cards. RemNote's native parser determines
the card direction and type; do not pass a separate card-type option. Use
[[id:<remId>]] for exact native references.

For WWH concept cards or GRAI retrospective cards, follow the installed RemNote
card-format Skill and lint the reviewed text before calling this command.

Official syntax: https://help.remnote.com/en/articles/9252072-how-to-import-flashcards-from-text`;

/** Preserve ordinary Markdown answer-group spacing as empty Rem answer items. */
export function normalizeCardMarkdown(content: string): string {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const output: string[] = [];
  let pendingBlank = false;

  for (const line of lines) {
    if (line.trim() === '') {
      pendingBlank = output.length > 0;
      continue;
    }
    const isAnswer = /^ {2}-(?:\s|$)/.test(line);
    if (pendingBlank && output.length > 0 && isAnswer && /^ {2}-(?:\s|$)/.test(output.at(-1)!))
      output.push('  -');
    output.push(line);
    pendingBlank = false;
  }

  return output.join('\n');
}

export function registerCardCreateCommand(
  program: Command,
  catalog: CommandCatalog,
  parent: Command
): void {
  const subprogram = catalog.action(parent, 'create', {
    description: 'Create review cards from RemNote official card text',
    risk: 'write',
    bridge: 'required',
  });
  const validate = (value: string) => validateNotFlag(value, subprogram);

  subprogram
    .requiredOption('--content <text>', 'RemNote official card text', validate)
    .option('--title <text>', 'Optional title for a parent Rem or card cluster', validate)
    .option('--parent-id <id>', 'Parent Rem ID', validate)
    .option('--tag-ids <tagRemIds...>', 'Exact tag Rem IDs to add')
    .addHelpText('after', helpText)
    .action(async (opts) => {
      const payload: CreateCommandInput = {
        content: normalizeCardMarkdown(opts.content as string),
      };
      if (opts.title) payload.title = opts.title;
      if (opts.parentId) payload.parentId = opts.parentId;
      if (opts.tagIds && opts.tagIds.length > 0) payload.tagRemIds = opts.tagIds;
      await executeCreate(program, payload);
    });
}
