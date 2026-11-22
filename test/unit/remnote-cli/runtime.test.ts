import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  CliFailure,
  EXIT,
  asCliFailure,
  exitCodeForFailure,
  unknownOutcomeFailure,
} from '../../../src/remnote-cli/output/errors.js';
import { createBufferedRuntime } from '../../../src/remnote-cli/output/runtime.js';

describe('CLI error contract', () => {
  it.each([
    ['usage', EXIT.USAGE],
    ['configuration', EXIT.UNAVAILABLE],
    ['unavailable', EXIT.UNAVAILABLE],
    ['not_found', EXIT.NOT_FOUND_OR_CONFLICT],
    ['conflict', EXIT.NOT_FOUND_OR_CONFLICT],
    ['unsupported', EXIT.UNSUPPORTED],
    ['unknown_outcome', EXIT.UNKNOWN_OUTCOME],
    ['internal', EXIT.INTERNAL],
  ] as const)('maps %s to a stable exit code', (type, expected) => {
    expect(exitCodeForFailure(new CliFailure(type, 'test', 'failed'))).toBe(expected);
  });

  it('never marks an unknown write outcome retryable', () => {
    const failure = unknownOutcomeFailure(new Error('write response lost'));
    expect(failure.type).toBe('unknown_outcome');
    expect(failure.retryable).toBe(false);
  });

  it('normalizes Zod failures as usage errors with issue details', () => {
    const parsed = new ZodError([]);
    const failure = asCliFailure(parsed);
    expect(failure.type).toBe('usage');
    expect(failure.details).toEqual([]);
  });

  it('normalizes likely connection failures as unavailable', () => {
    const failure = asCliFailure(new Error('Bridge connection refused'));
    expect(failure.type).toBe('unavailable');
  });

  it('keeps malformed SDK responses internal', () => {
    const failure = asCliFailure(new Error('SDK returned malformed data'));
    expect(failure.type).toBe('internal');
  });
});

describe('buffered CLI runtime', () => {
  it('separates success stdout and failure stderr', () => {
    const runtime = createBufferedRuntime('json');
    runtime.success({ ok: true });
    expect(runtime.stdout()).toContain('"schemaVersion": 2');
    expect(runtime.stderr()).toBe('');

    const failed = createBufferedRuntime('json');
    failed.failure(new CliFailure('conflict', 'changed', 'changed externally'));
    expect(failed.stdout()).toBe('');
    expect(failed.stderr()).toContain('"type": "conflict"');
    expect(failed.getExitCode()).toBe(EXIT.NOT_FOUND_OR_CONFLICT);
  });

  it('sanitizes text diagnostics', () => {
    const runtime = createBufferedRuntime('text');
    runtime.failure(new CliFailure('usage', 'bad', '\u001b[31mbad\u0007'));
    expect(runtime.stderr()).not.toContain('\u001b');
    expect(runtime.stderr()).not.toContain('\u0007');
  });
});
