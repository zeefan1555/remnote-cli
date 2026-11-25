import { Command } from 'commander';
import type { CommandCatalog } from '../spec/command-spec.js';
import { validateNotFlag } from './arg-utils.js';
import { executeCreate, type CreateCommandInput } from './create.js';

const helpText = `
Content uses RemNote's official card text syntax. Examples:

  remnote-cli card create --content "Question >> Answer"
  remnote-cli card create --content $'Question >>>\\n  - Answer line one\\n  - Answer line two'

One --content value may contain multiple cards. RemNote's native parser determines
the card direction and type; do not pass a separate card-type option. Use
[[id:<remId>]] for exact native references.

For WWH concept cards or GRAI retrospective cards, follow the installed RemNote
card-format Skill and lint the reviewed text before calling this command.

Official syntax: https://help.remnote.com/en/articles/9252072-how-to-import-flashcards-from-text`;

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
        content: opts.content as string,
      };
      if (opts.title) payload.title = opts.title;
      if (opts.parentId) payload.parentId = opts.parentId;
      if (opts.tagIds && opts.tagIds.length > 0) payload.tagRemIds = opts.tagIds;
      await executeCreate(program, payload);
    });
}
