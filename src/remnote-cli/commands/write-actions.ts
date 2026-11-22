import { emit } from '../output/runtime.js';
import { Command, InvalidArgumentError } from 'commander';
import { createCommandClient } from '../client/command-client.js';
import { formatResult, type OutputFormat } from '../output/formatter.js';
import { resolveOptionalInlineOrFileContent } from './content-input.js';
import { validateNotFlag } from './arg-utils.js';
import type { CommandCatalog } from '../spec/command-spec.js';

type InsertPosition = 'first' | 'last' | 'before' | 'after';
const REM_CLASSIFICATIONS = [
  'folder',
  'document',
  'dailyDocument',
  'concept',
  'descriptor',
  'portal',
  'text',
] as const;

function validateExpectedOldRemType(value: string, command: Command): string {
  validateNotFlag(value, command);
  if (!REM_CLASSIFICATIONS.includes(value as (typeof REM_CLASSIFICATIONS)[number])) {
    throw new InvalidArgumentError(
      `expectedOldRemType must be one of: ${REM_CLASSIFICATIONS.join(', ')}`
    );
  }
  return value;
}

function formatRemResult(data: unknown, emptyMessage: string): string {
  const r = data as { remIds?: string[]; titles?: string[] };
  const ids = r.remIds || [];
  const titles = r.titles || [];
  if (ids.length === 0) return emptyMessage;
  return ids.map((id, i) => `Updated/Created: ${titles[i] || '(untitled)'} (ID: ${id})`).join('\n');
}

async function resolveRequiredContent(options: {
  content: string | undefined;
  contentFile: string | undefined;
}): Promise<string> {
  const content = await resolveOptionalInlineOrFileContent({
    inlineText: options.content,
    filePath: options.contentFile,
    inlineFlag: '--content',
    fileFlag: '--content-file',
  });

  if (content === undefined) {
    throw new Error(
      'Provide exactly one content source: --content <text> or --content-file <path|->'
    );
  }

  return content;
}

export function registerInsertChildrenCommand(
  program: Command,
  catalog: CommandCatalog,
  parent: Command
): void {
  const subprogram = catalog.action(parent, 'insert <parent-rem-id>', {
    description: 'Insert child Rems; newly created non-leaf Rems are collapsed automatically',
    risk: 'write',
    bridge: 'required',
  });
  const validate = (val: string) => validateNotFlag(val, subprogram);

  subprogram
    .option(
      '--content <text>',
      'Content to insert (use [[id:<remId>]] for exact references)',
      validate
    )
    .option(
      '--content-file <path>',
      'Read inserted content from UTF-8 file ("-" for stdin)',
      validate
    )
    .requiredOption(
      '--position <position>',
      'Insert position: first, last, before, or after',
      validate
    )
    .option('--sibling-rem-id <id>', 'Sibling Rem ID for before/after positions', validate)
    .action(async (parentRemId: string, opts) => {
      const globalOpts = program.opts();
      const format: OutputFormat = globalOpts.text ? 'text' : 'json';
      const client = createCommandClient(program);

      try {
        const content = await resolveRequiredContent({
          content: opts.content as string | undefined,
          contentFile: opts.contentFile as string | undefined,
        });
        const position = opts.position as InsertPosition;

        const payload: Record<string, unknown> = {
          parentRemId,
          content,
          position,
        };
        if (opts.siblingRemId) payload.siblingRemId = opts.siblingRemId;

        const result = await client.execute('insert_children', payload);
        emit(
          program,
          formatResult(result, format, (data) =>
            formatRemResult(data, `Inserted children under ${parentRemId}`)
          )
        );
      } finally {
        await client.close();
      }
    });
}

export function registerReplaceChildrenCommand(
  program: Command,
  catalog: CommandCatalog,
  parent: Command
): void {
  const subprogram = catalog.action(parent, 'replace <parent-rem-id>', {
    description: 'Replace direct children; newly created non-leaf Rems are collapsed automatically',
    risk: 'destructive',
    bridge: 'required',
  });
  const validate = (val: string) => validateNotFlag(val, subprogram);

  subprogram
    .option(
      '--content <text>',
      'Replacement content (use [[id:<remId>]] for exact references)',
      validate
    )
    .option(
      '--content-file <path>',
      'Read replacement content from UTF-8 file ("-" for stdin; empty file clears children)',
      validate
    )
    .action(async (parentRemId: string, opts) => {
      const globalOpts = program.opts();
      const format: OutputFormat = globalOpts.text ? 'text' : 'json';
      const client = createCommandClient(program);

      try {
        const content = await resolveRequiredContent({
          content: opts.content as string | undefined,
          contentFile: opts.contentFile as string | undefined,
        });

        const result = await client.execute('replace_children', { parentRemId, content });
        emit(
          program,
          formatResult(result, format, (data) =>
            formatRemResult(data, `Replaced children under ${parentRemId}`)
          )
        );
      } finally {
        await client.close();
      }
    });
}

export function registerUpdateTagsCommand(
  program: Command,
  catalog: CommandCatalog,
  parent: Command
): void {
  const subprogram = catalog.action(parent, 'update <rem-id>', {
    description: 'Add or remove tags by exact tag Rem ID',
    risk: 'write',
    bridge: 'required',
  });

  subprogram
    .option('--add-tag-ids <tag-rem-ids...>', 'Exact tag Rem IDs to add')
    .option('--remove-tag-ids <tag-rem-ids...>', 'Exact tag Rem IDs to remove')
    .action(async (remId: string, opts) => {
      const globalOpts = program.opts();
      const format: OutputFormat = globalOpts.text ? 'text' : 'json';
      const client = createCommandClient(program);

      try {
        const payload: Record<string, unknown> = { remId };
        if (opts.addTagIds?.length) payload.addTagRemIds = opts.addTagIds;
        if (opts.removeTagIds?.length) payload.removeTagRemIds = opts.removeTagIds;

        const result = await client.execute('update_tags', payload);
        emit(
          program,
          formatResult(result, format, (data) => formatRemResult(data, `Updated tags on ${remId}`))
        );
      } finally {
        await client.close();
      }
    });
}

export function registerSetPropertyCommand(
  program: Command,
  catalog: CommandCatalog,
  parent: Command
): void {
  const subprogram = catalog.action(parent, 'set <rem-id>', {
    description: 'Set or clear a tag/table property value by exact IDs',
    risk: 'write',
    bridge: 'required',
  });
  const validate = (val: string) => validateNotFlag(val, subprogram);

  subprogram
    .requiredOption('--tag-id <id>', 'Exact tag/table Rem ID that owns the property', validate)
    .requiredOption('--property-id <id>', 'Exact property Rem ID under the tag/table Rem', validate)
    .option(
      '--value <text>',
      'Set a plain text or markdown property value; use [[id:<remId>]] for exact references',
      validate
    )
    .option(
      '--rem-reference-id <id>',
      'Set a Rem reference value; use select-option Rem IDs here too',
      validate
    )
    .option('--clear', 'Clear the property value')
    .action(async (remId: string, opts) => {
      const globalOpts = program.opts();
      const format: OutputFormat = globalOpts.text ? 'text' : 'json';
      const client = createCommandClient(program);

      try {
        const selectedValueOptions = [
          opts.value !== undefined,
          opts.remReferenceId !== undefined,
          Boolean(opts.clear),
        ].filter(Boolean).length;

        if (selectedValueOptions !== 1) {
          throw new Error('Provide exactly one of --value, --rem-reference-id, or --clear.');
        }

        const value =
          opts.value !== undefined
            ? { kind: 'text', text: opts.value }
            : opts.remReferenceId !== undefined
              ? { kind: 'rem_reference', remId: opts.remReferenceId }
              : { kind: 'clear' };

        const payload: Record<string, unknown> = {
          remId,
          tagRemId: opts.tagId,
          propertyRemId: opts.propertyId,
          value,
        };

        const result = await client.execute('set_property', payload);
        emit(
          program,
          formatResult(result, format, (data) => {
            const r = data as Record<string, unknown>;
            return `Set property: ${r.propertyRemId ?? opts.propertyId} on ${r.remId ?? remId} (${r.valueKind ?? 'unknown'})`;
          })
        );
      } finally {
        await client.close();
      }
    });
}

export function registerMoveNoteCommand(
  program: Command,
  catalog: CommandCatalog,
  parent: Command
): void {
  const subprogram = catalog.action(parent, 'move <rem-id>', {
    description: 'Move a Rem and its subtree under a new parent',
    risk: 'destructive',
    bridge: 'required',
  });
  const validate = (val: string) => validateNotFlag(val, subprogram);

  subprogram
    .requiredOption('--new-parent-rem-id <id>', 'New parent Rem ID', validate)
    .option('--position <position>', 'Move position: first, last, before, or after', validate)
    .option('--sibling-rem-id <id>', 'Sibling Rem ID for before/after positions', validate)
    .option('--apply', 'Perform the move. Without this flag, the command runs as dry-run.')
    .option(
      '--expected-old-parent-rem-id <id>',
      'Reject if current parent differs from this Rem ID',
      validate
    )
    .option(
      '--ancestor-depth <n>',
      'Number of parent Rems to include before/after the move',
      validate
    )
    .action(async (remId: string, opts) => {
      const globalOpts = program.opts();
      const format: OutputFormat = globalOpts.text ? 'text' : 'json';
      const client = createCommandClient(program);

      try {
        const payload: Record<string, unknown> = {
          remId,
          newParentRemId: opts.newParentRemId,
          dryRun: !opts.apply,
        };
        if (opts.position) payload.position = opts.position;
        if (opts.siblingRemId) payload.siblingRemId = opts.siblingRemId;
        if (opts.expectedOldParentRemId)
          payload.expectedOldParentRemId = opts.expectedOldParentRemId;
        if (opts.ancestorDepth) payload.ancestorDepth = parseInt(opts.ancestorDepth, 10);

        const result = await client.execute('move_note', payload);
        emit(
          program,
          formatResult(result, format, (data) => {
            const r = data as Record<string, unknown>;
            return `${r.dryRun ? 'Dry-run move' : 'Moved'}: ${r.title ?? remId} (${r.remId ?? remId}) -> ${r.newParentTitle ?? r.newParentRemId}`;
          })
        );
      } finally {
        await client.close();
      }
    });
}

export function registerDeleteCommand(
  program: Command,
  catalog: CommandCatalog,
  parent: Command
): void {
  const subprogram = catalog.action(parent, 'delete <rem-id>', {
    description: 'Preview or delete one exact Rem and all of its descendants',
    risk: 'destructive',
    bridge: 'required',
  });
  const validate = (value: string) => validateNotFlag(value, subprogram);

  subprogram
    .option('--apply', 'Delete the Rem. Without this flag, the command runs as a preview.')
    .option('--expected-title <text>', 'Require this exact current title when applying', validate)
    .addHelpText(
      'after',
      [
        '',
        'Preview is the default and performs no writes.',
        'Apply requires --allow-destructive and --expected-title, then reads the exact Rem ID back to confirm absence.',
        'Deletion removes the Rem and all of its descendants.',
      ].join('\n')
    )
    .action(async (remId: string, opts: { apply?: boolean; expectedTitle?: string }) => {
      const format: OutputFormat = program.opts().text ? 'text' : 'json';
      const client = createCommandClient(program);
      try {
        const result = await client.execute('delete_rem', {
          remId,
          dryRun: opts.apply !== true,
          ...(opts.expectedTitle === undefined ? {} : { expectedTitle: opts.expectedTitle }),
        });
        emit(
          program,
          formatResult(result, format, (data) => {
            const value = data as Record<string, unknown>;
            return `${value.dryRun === true ? 'Preview deletion' : 'Deleted'} ${String(value.title)} [${String(value.remId)}]`;
          })
        );
      } finally {
        await client.close();
      }
    });
}

export function registerSetDocumentStatusCommand(
  program: Command,
  catalog: CommandCatalog,
  parent: Command
): void {
  const subprogram = catalog.action(parent, 'status <rem-id>', {
    description: 'Preview or set document status on an existing Rem',
    risk: 'write',
    bridge: 'required',
  });
  const validateExpectedType = (val: string) => validateExpectedOldRemType(val, subprogram);

  subprogram
    .option('--document', 'Mark the Rem as a document')
    .option('--no-document', 'Unmark the Rem as a document')
    .option('--apply', 'Apply the change. Without this flag, the command runs as dry-run.')
    .option(
      '--expected-old-rem-type <type>',
      `Reject if current remType differs from this value (${REM_CLASSIFICATIONS.join(', ')})`,
      validateExpectedType
    )
    .action(async (remId: string, opts) => {
      const globalOpts = program.opts();
      const format: OutputFormat = globalOpts.text ? 'text' : 'json';
      const client = createCommandClient(program);

      try {
        if (typeof opts.document !== 'boolean') {
          throw new Error('Provide --document or --no-document.');
        }

        const payload: Record<string, unknown> = {
          remId,
          isDocument: opts.document,
          dryRun: !opts.apply,
        };
        if (opts.expectedOldRemType) payload.expectedOldRemType = opts.expectedOldRemType;

        const result = await client.execute('set_document_status', payload);
        emit(
          program,
          formatResult(result, format, (data) => {
            const r = data as Record<string, unknown>;
            const label = r.dryRun
              ? 'Dry-run document status'
              : r.changed
                ? 'Updated document status'
                : 'Document status unchanged';
            return `${label}: ${r.title ?? remId} (${r.remId ?? remId}) ${r.oldRemType ?? '?'} -> ${r.newRemType ?? '?'}; isDocument=${String(r.newIsDocument ?? r.requestedIsDocument)}`;
          })
        );
      } finally {
        await client.close();
      }
    });
}
