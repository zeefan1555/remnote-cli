import { isAlias, parseDocument, stringify, visit } from 'yaml';
import { z } from 'zod';
import { blockSchema, idSchema, keySchema, originalPath, recordPath } from './identity.js';
import type { Diagnostic } from './types.js';

const bool = () => z.boolean().nullable().default(null);
const number = () => z.number().finite().nullable().default(null);
const propertyValue = z
  .object({
    propertyId: idSchema,
    valueRemId: idSchema.nullable(),
    valueRichText: z.array(z.json()).nullable(),
  })
  .strict();
export const cardMetadataSchema = z
  .object({
    id: idSchema,
    remId: idSchema,
    type: z.union([z.enum(['forward', 'backward']), z.object({ clozeId: z.string() }).strict()]),
    createdAt: number(),
    repetitionHistory: z.array(z.json()).nullable().default(null),
    nextRepetitionTime: number(),
    lastRepetitionTime: number(),
    timesWrongInRow: number(),
  })
  .strict();
export const nativeDetailsSchema = z
  .object({
    isListItem: bool(),
    isQuote: bool(),
    isCode: bool(),
    isTodo: bool(),
    isTable: bool(),
    isProperty: bool(),
    isPowerup: bool(),
    isPowerupEnum: bool(),
    isPowerupPropertyListItem: bool(),
    isPowerupSlot: bool(),
    isPowerupProperty: bool(),
    embeddedQueueViewMode: bool(),
    todoStatus: z.enum(['Finished', 'Unfinished']).nullable().default(null),
    fontSize: z.enum(['H1', 'H2', 'H3']).nullable().default(null),
    highlightColor: z.string().nullable().default(null),
    propertyType: z
      .union([
        z.literal(0),
        z.enum([
          'number',
          'title',
          'text',
          'checkbox',
          'date',
          'multi_select',
          'single_select',
          'created_at',
          'last_updated',
          'image',
          'url',
          'definition',
        ]),
      ])
      .nullable()
      .default(null),
    aliasRemIds: z.array(idSchema).nullable().default(null),
    sourceRemIds: z.array(idSchema).nullable().default(null),
    createdAt: number(),
    localUpdatedAt: number(),
    updatedAt: number(),
  })
  .strict();
export type NativeDetails = z.infer<typeof nativeDetailsSchema>;
export const nativeSchema = z
  .object({
    type: z.union([z.number().int(), z.string()]).nullable(),
    parent: idSchema.nullable(),
    children: z.array(idSchema).nullable(),
    isDocument: z.boolean().nullable(),
    isFolder: z.boolean().nullable(),
    isCardItem: z.boolean().nullable(),
    practiceDirection: z.enum(['forward', 'backward', 'both', 'none']).nullable(),
    enablePractice: z.boolean().nullable(),
    tags: z.array(idSchema).nullable(),
    references: z.array(idSchema).nullable(),
    powerups: z
      .array(
        z
          .object({
            code: z.string(),
            slots: z.array(
              z
                .object({
                  slot: z.string(),
                  valueRemId: idSchema.nullable(),
                  valueRichText: z.array(z.json()).nullable(),
                })
                .strict()
            ),
          })
          .strict()
      )
      .nullable(),
    propertyValues: z.array(propertyValue).nullable(),
    portal: z
      .object({
        type: z.json().nullable(),
        directlyIncludedRemIds: z.array(idSchema).nullable(),
      })
      .strict()
      .nullable(),
    cards: z.array(cardMetadataSchema).nullable(),
    ...nativeDetailsSchema.shape,
    collected: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.collected).size !== value.collected.length ||
      value.collected.some((key) => key === 'collected' || !(key in value))
    )
      context.addIssue({
        code: 'custom',
        path: ['collected'],
        message: 'collected is a set of explicitly read native field names',
      });
  });

const entrySchema = z.union([
  z
    .object({
      id: idSchema,
      block: blockSchema,
      content: z.enum(['text', 'multiline', 'basic', 'readonly']),
      native: nativeSchema,
      readOnly: z
        .object({
          record: z.string(),
          public: z.string().nullable(),
          original: z.string().nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: z.null(),
      block: blockSchema,
      content: z.enum(['text', 'multiline']),
    })
    .strict(),
]);

export const metadataSchema = z
  .object({
    schema: z.literal('remnote-sync/1'),
    root: idSchema,
    title: z.string().optional(),
    aliases: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
    rems: z.record(keySchema, entrySchema),
  })
  .strict()
  .superRefine((value, context) => {
    const blocks = new Set<string>();
    for (const [key, entry] of Object.entries(value.rems)) {
      const issue = (message: string) =>
        context.addIssue({ code: 'custom', path: ['rems', key], message });
      if (blocks.has(entry.block)) issue('Each block ID must identify exactly one Rem in the file');
      blocks.add(entry.block);
      if (entry.id === null) {
        if (!key.startsWith('new:')) issue('An uncreated Rem requires a new: local key');
      } else {
        if (key !== entry.id) issue('Existing YAML key and native Rem ID must agree');
        if (
          entry.readOnly.record !== recordPath(entry.id) ||
          (entry.readOnly.public !== null &&
            entry.readOnly.public !== originalPath('public', entry.id)) ||
          (entry.readOnly.original !== null &&
            entry.readOnly.original !== originalPath('rems', entry.id))
        )
          issue('Read-only paths must be the exact private sidecars of this Rem');
      }
    }
    if (value.rems[value.root]?.id !== value.root)
      context.addIssue({
        code: 'custom',
        path: ['root'],
        message: 'The H1 root requires its existing Rem entry',
      });
  });

export type WorkspaceMetadata = z.infer<typeof metadataSchema>;
export type RemMetadata = WorkspaceMetadata['rems'][string];
export type NativeMetadata = z.infer<typeof nativeSchema>;

export function renderFrontmatter(metadata: WorkspaceMetadata): string {
  return `---\n${stringify(metadataSchema.parse(metadata), { lineWidth: 0, aliasDuplicateObjects: false })}---\n\n`;
}

/** Strict YAML 1.2 source mode: neither aliases, unknown tags nor duplicate keys are executable input. */
export function parseFrontmatter(
  path: string,
  source: string
): {
  metadata?: WorkspaceMetadata;
  body: string;
  bodyLine: number;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const fail = (message: string) =>
    diagnostics.push({ path, line: 1, code: 'YAML_METADATA', message });
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) {
    fail('Require one remnote-sync/1 YAML frontmatter block before the H1');
    return { body: source, bodyLine: 1, diagnostics };
  }
  const bodyOffset = match[0].length;
  // One optional separator line belongs to frontmatter, not the Markdown root.
  const rest = source.slice(bodyOffset),
    separator = /^\r?\n/.exec(rest)?.[0] ?? '';
  const body = rest.slice(separator.length);
  const bodyLine = source.slice(0, bodyOffset + separator.length).split('\n').length;
  try {
    const document = parseDocument(match[1]!, {
      version: '1.2',
      uniqueKeys: true,
      stringKeys: true,
      strict: true,
      prettyErrors: false,
    });
    if (document.errors.length || document.warnings.length)
      throw new Error(
        [...document.errors, ...document.warnings].map((error) => error.message).join('; ')
      );
    visit(document, (_key, node) => {
      if (isAlias(node)) throw new Error('YAML aliases are not supported in workspace metadata');
    });
    const metadata = metadataSchema.parse(document.toJS({ maxAliasCount: 0 }));
    return { metadata, body, bodyLine, diagnostics };
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return { body, bodyLine, diagnostics };
  }
}
