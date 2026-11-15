import { isAlias, parseDocument, stringify, visit } from 'yaml';
import { z } from 'zod';
import {
  blockSchema,
  idSchema,
  keySchema,
  originalPath,
  recordPath,
  shortBlockSchema,
} from './identity.js';
import type { Diagnostic } from './types.js';

const bool = () => z.boolean().nullable().default(null);
const number = () => z.number().finite().nullable().default(null);
export const powerupStatesSchema = z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.boolean());
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
    powerupStates: powerupStatesSchema.optional(),
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
      projection: z.enum(['reference-wrapper', 'anchor-required']).optional(),
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

/** User-authored attributes only. Native facts are hydrated from the sealed record baseline. */
export const attributesSchema = z
  .object({
    title: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    rems: z
      .record(
        shortBlockSchema,
        z
          .object({
            content: z.enum(['text', 'multiline']).optional(),
            tags: z.array(z.string().min(1)).optional(),
            powerups: powerupStatesSchema.optional(),
          })
          .strict()
      )
      .optional(),
  })
  .strict();
export type DocumentAttributes = z.infer<typeof attributesSchema>;

export function renderFrontmatter(attributes: DocumentAttributes = {}): string {
  const value = attributesSchema.parse(attributes);
  if (!Object.keys(value).length) return '';
  return `---\n${stringify(value, { lineWidth: 0, aliasDuplicateObjects: false })}---\n\n`;
}

/** Strict YAML 1.2 source mode: neither aliases, unknown tags nor duplicate keys are executable input. */
export function readMetadataYaml(source: string): unknown {
  const document = parseDocument(source, {
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
    if (isAlias(node)) throw new Error('YAML aliases are not supported in workspace attributes');
  });
  return document.toJS({ maxAliasCount: 0 });
}

export interface DocumentHeader {
  attributes?: DocumentAttributes;
  documentKey?: string;
  /** Populated only by the identity-bound record hydration, never by YAML parsing. */
  metadata?: WorkspaceMetadata;
  body: string;
  bodyLine: number;
  diagnostics: Diagnostic[];
}

export function parseFrontmatter(path: string, source: string): DocumentHeader {
  const diagnostics: Diagnostic[] = [];
  const fail = (code: string, message: string) =>
    diagnostics.push({ path, line: 1, code, message });
  let rest = source.replace(/^\uFEFF/, ''),
    attributes: DocumentAttributes | undefined = {};
  if (rest.startsWith('---\n') || rest.startsWith('---\r\n')) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(rest);
    if (!match) {
      fail('YAML_METADATA', 'Unclosed optional YAML attributes');
      return { body: source, bodyLine: 1, diagnostics };
    }
    rest = rest.slice(match[0].length).replace(/^\r?\n/, '');
    try {
      attributes = attributesSchema.parse(readMetadataYaml(match[1]!));
    } catch (error) {
      attributes = undefined;
      fail('YAML_METADATA', error instanceof Error ? error.message : String(error));
    }
  }
  const marker = /^<!-- remnote:([A-Za-z0-9-]{1,64}) -->\r?\n(?:\r?\n)?/.exec(rest);
  if (!marker || [...source.matchAll(/<!--\s*remnote:/g)].length !== 1) {
    fail(
      'ROOT_BINDING',
      'Require exactly one hidden <!-- remnote:document-key --> before the H1; old native YAML requires explicit sync format'
    );
    return {
      attributes,
      body: rest,
      bodyLine: source.slice(0, source.length - rest.length).split('\n').length,
      diagnostics,
    };
  }
  const body = rest.slice(marker[0].length);
  return {
    attributes,
    documentKey: marker[1]!,
    body,
    bodyLine: source.slice(0, source.length - body.length).split('\n').length,
    diagnostics,
  };
}
