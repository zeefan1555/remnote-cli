import { z } from 'zod';
import {
  FLASHCARD_CREATE_CAPABILITIES,
  FLASHCARD_PATCH_CAPABILITIES,
  FLASHCARD_REUSE_CAPABILITIES,
} from '../business/operation-capabilities.js';
import { PROTOCOL_VERSION } from '../remnote-cli/client/connection.js';
import { REMOTE_ACTION_NAMES } from '../remnote-cli/client/remote-actions.js';
import { FlashcardsApplySchema } from './task-schemas.js';
import { CLI_ERROR_TYPES, EXIT } from '../remnote-cli/output/errors.js';
import type { CommandSpec } from '../remnote-cli/spec/command-spec.js';
import { localSdkCapabilities } from '../remnote-cli/client/sdk-capabilities.js';

export const CONTRACT_SCHEMA_NAMES = ['flashcards'] as const;
export type ContractSchemaName = (typeof CONTRACT_SCHEMA_NAMES)[number];

const receipt = {
  schemaVersion: 1,
  statuses: ['preview', 'verified', 'partial', 'unknown', 'incomplete', 'conflict'],
  complete: 'boolean',
  errors: 'array<{code,message,remId?}>',
};

const planSchemas = {
  flashcards: z.toJSONSchema(FlashcardsApplySchema, { io: 'input' }),
} as const;

const requiredCapabilities = {
  flashcards: {
    create: FLASHCARD_CREATE_CAPABILITIES,
    patch: FLASHCARD_PATCH_CAPABILITIES,
    reuse: FLASHCARD_REUSE_CAPABILITIES,
  },
};

export function buildCliContract(commands: CommandSpec[] = []) {
  return {
    schemaVersion: 2,
    protocolVersion: PROTOCOL_VERSION,
    sdkFacts: {
      schemaVersion: localSdkCapabilities().catalogSchemaVersion,
      sdkVersion: localSdkCapabilities().sdkVersion,
      catalogHash: localSdkCapabilities().sdkCatalogHash,
      capabilities: localSdkCapabilities().capabilities.length,
    },
    bridgeActions: Object.values(REMOTE_ACTION_NAMES),
    plans: planSchemas,
    requiredCapabilities,
    receipt,
    output: {
      schemaVersion: 2,
      successStream: 'stdout',
      failureStream: 'stderr',
      errorTypes: CLI_ERROR_TYPES,
    },
    exitCodes: {
      success: EXIT.SUCCESS,
      internal: EXIT.INTERNAL,
      usage: EXIT.USAGE,
      configurationOrUnavailable: EXIT.UNAVAILABLE,
      notFoundOrConflict: EXIT.NOT_FOUND_OR_CONFLICT,
      unknownOutcome: EXIT.UNKNOWN_OUTCOME,
      unsupported: EXIT.UNSUPPORTED,
    },
    commands: commands.map((command) =>
      command.kind === 'group'
        ? { path: command.path, kind: command.kind, helpSection: command.helpSection }
        : {
            path: command.path,
            kind: command.kind,
            helpSection: command.helpSection,
            risk: command.risk,
            bridge: command.bridge,
            dynamic: command.dynamic,
            ...(command.pagination === undefined ? {} : { pagination: command.pagination }),
          }
    ),
  } as const;
}

export function contractSchema(name: string) {
  if (!CONTRACT_SCHEMA_NAMES.includes(name as ContractSchemaName))
    throw new Error(`Unknown contract schema: ${name}`);
  return planSchemas[name as ContractSchemaName];
}
