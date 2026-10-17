import { z } from 'zod';
import { INSPECT_FIELDS } from '../business/state-inspect.js';

const RemIdSchema = z.string().trim().min(1).max(256);

export const InspectStateSchema = z
  .object({
    remIds: z.array(RemIdSchema).min(1).max(100),
    descendants: z.number().int().min(0).max(20).default(0),
    fields: z.array(z.enum(INSPECT_FIELDS)).min(1).optional(),
    summary: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.remIds).size !== value.remIds.length)
      context.addIssue({ code: 'custom', message: 'Duplicate Rem IDs', path: ['remIds'] });
  });

export const PowerupGetSchema = z
  .object({
    remId: RemIdSchema,
    powerup: z.string().trim().min(1).max(64),
    slot: z.string().trim().min(1).max(128),
    as: z.enum(['value', 'richtext', 'rem']).default('value'),
  })
  .strict();
