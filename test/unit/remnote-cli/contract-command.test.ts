import { describe, expect, it } from 'vitest';
import { EXIT } from '../../../src/remnote-cli/output/errors.js';
import { parseFailure, parseSuccess, runCliForTest } from '../../helpers/run-cli.js';

describe('contract command', () => {
  it('prints the full contract without opening a Bridge session', async () => {
    const result = await runCliForTest(['contract']);
    const value = parseSuccess(result.stdout) as {
      schemaVersion: number;
      protocolVersion: number;
      bridgeActions: string[];
      output: { schemaVersion: number; failureStream: string };
      exitCodes: { unknownOutcome: number };
    };
    expect(result.exitCode).toBe(0);
    expect(value).toMatchObject({
      schemaVersion: 2,
      protocolVersion: 2,
      bridgeActions: ['get_status', 'get_sdk_capabilities', 'sdk_call'],
      output: { schemaVersion: 2, failureStream: 'stderr' },
      exitCodes: { success: 0, unknownOutcome: 5 },
    });
    expect(value).not.toHaveProperty('plans');
  });

  it('rejects the removed plan schema option', async () => {
    const unknown = await runCliForTest(['contract', '--schema', 'flashcards']);
    expect(parseFailure(unknown.stderr)).toMatchObject({
      type: 'usage',
      subtype: 'commander.unknownOption',
    });
    expect(unknown.exitCode).toBe(EXIT.USAGE);
  });
});
