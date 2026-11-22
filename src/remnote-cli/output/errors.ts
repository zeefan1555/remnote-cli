import { CommanderError } from 'commander';
import { z } from 'zod';

export const CLI_ERROR_TYPES = [
  'usage',
  'configuration',
  'unavailable',
  'not_found',
  'conflict',
  'unsupported',
  'unknown_outcome',
  'internal',
] as const;

export type CliErrorType = (typeof CLI_ERROR_TYPES)[number];

export interface CliErrorData {
  type: CliErrorType;
  subtype: string;
  message: string;
  hint?: string;
  retryable: boolean;
  details?: unknown;
}

export interface CliFailureOptions {
  hint?: string;
  retryable?: boolean;
  details?: unknown;
  cause?: unknown;
}

export class CliFailure extends Error {
  readonly type: CliErrorType;
  readonly subtype: string;
  readonly hint?: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    type: CliErrorType,
    subtype: string,
    message: string,
    options: CliFailureOptions = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CliFailure';
    this.type = type;
    this.subtype = subtype;
    this.hint = options.hint;
    this.retryable = options.retryable ?? type === 'unavailable';
    this.details = options.details;
  }
}

export const EXIT = {
  SUCCESS: 0,
  INTERNAL: 1,
  USAGE: 2,
  UNAVAILABLE: 3,
  NOT_FOUND_OR_CONFLICT: 4,
  UNKNOWN_OUTCOME: 5,
  UNSUPPORTED: 6,
} as const;

const EXIT_BY_TYPE = {
  usage: EXIT.USAGE,
  configuration: EXIT.UNAVAILABLE,
  unavailable: EXIT.UNAVAILABLE,
  not_found: EXIT.NOT_FOUND_OR_CONFLICT,
  conflict: EXIT.NOT_FOUND_OR_CONFLICT,
  unsupported: EXIT.UNSUPPORTED,
  unknown_outcome: EXIT.UNKNOWN_OUTCOME,
  internal: EXIT.INTERNAL,
} satisfies Record<CliErrorType, number>;

export function exitCodeForFailure(failure: CliFailure): number {
  return EXIT_BY_TYPE[failure.type];
}

export function errorData(failure: CliFailure): CliErrorData {
  return {
    type: failure.type,
    subtype: failure.subtype,
    message: failure.message,
    ...(failure.hint === undefined ? {} : { hint: failure.hint }),
    retryable: failure.retryable,
    ...(failure.details === undefined ? {} : { details: failure.details }),
  };
}

function messageFrom(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function subtypeFromMessage(message: string): string {
  const normalized = message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return normalized || 'unclassified';
}

export function isConnectionMessage(message: string): boolean {
  return /\b(bridge|connection|connect|socket|websocket|port|loopback|handshake|session closed)\b/i.test(
    message
  );
}

function isMalformedMessage(message: string): boolean {
  return /\b(sdk|malformed|invalid response|unexpected|incomplete|missing response)\b/i.test(
    message
  );
}

export function asCliFailure(error: unknown): CliFailure {
  if (error instanceof CliFailure) return error;

  if (error instanceof z.ZodError) {
    return new CliFailure(
      'usage',
      'validation_failed',
      error.issues
        .map((issue) => {
          const path = issue.path.length === 0 ? 'input' : issue.path.join('.');
          return path + ': ' + issue.message;
        })
        .join('; '),
      { details: error.issues }
    );
  }

  if (error instanceof CommanderError) {
    return new CliFailure('usage', error.code, error.message);
  }

  const message = messageFrom(error);
  if (/outcome unknown|do not replay writes|verify write outcome/i.test(message)) {
    return new CliFailure('unknown_outcome', 'write_response_lost', message, {
      hint: 'Read the exact affected IDs before making another write.',
      retryable: false,
      cause: error,
    });
  }
  if (/\bnot found\b|\bmissing\b|inaccessible/i.test(message)) {
    return new CliFailure('not_found', 'target_missing', message, { cause: error });
  }
  if (/\bconflict\b|changed externally|stale\b|expired\b|mismatch\b/i.test(message)) {
    return new CliFailure('conflict', 'state_conflict', message, { cause: error });
  }
  if (/\bunsupported\b|not expose|write operations are disabled/i.test(message)) {
    return new CliFailure('unsupported', 'capability_unavailable', message, { cause: error });
  }
  if (isConnectionMessage(message)) {
    return new CliFailure('unavailable', 'bridge_unavailable', message, { cause: error });
  }
  if (isMalformedMessage(message)) {
    return new CliFailure('internal', subtypeFromMessage(message), message, { cause: error });
  }
  return new CliFailure('usage', subtypeFromMessage(message), message, { cause: error });
}

export function unknownOutcomeFailure(error: unknown): CliFailure {
  const message = messageFrom(error);
  return new CliFailure('unknown_outcome', 'write_response_lost', message, {
    hint: 'Read the exact affected IDs before making another write.',
    retryable: false,
    cause: error,
  });
}

export function isWriteUncertainty(error: unknown): boolean {
  if (error instanceof CliFailure) return error.type === 'unknown_outcome';
  const message = messageFrom(error);
  return /outcome unknown|do not replay writes|verify write outcome|session closed|socket|malformed response/i.test(
    message
  );
}
