import { describe, expect, it } from 'vitest';
import { EXIT } from '../../../src/remnote-cli/output/errors.js';
import { parseSuccess, runCliForTest } from '../../helpers/run-cli.js';

describe('contract command', () => {
  it('prints the full contract without opening a Bridge session', async () => {
    const result = await runCliForTest(['contract']);
    const value = parseSuccess(result.stdout) as {
      schemaVersion: number;
      protocolVersion: number;
      bridgeActions: string[];
      output: { schemaVersion: number; failureStream: string };
      exitCodes: { unknownOutcome: number };
      plans: {
        flashcards: { $schema: string };
      };
    };
    expect(result.exitCode).toBe(0);
    expect(value).toMatchObject({
      schemaVersion: 2,
      protocolVersion: 2,
      bridgeActions: ['get_status', 'get_sdk_capabilities', 'sdk_call'],
      output: { schemaVersion: 2, failureStream: 'stderr' },
      exitCodes: { success: 0, unknownOutcome: 5 },
    });
    expect(value.plans.flashcards.$schema).toContain('json-schema.org');
    expect(Object.keys(value.plans)).toEqual(['flashcards']);
  });

  it('prints one schema and rejects an unknown name', async () => {
    const schema = await runCliForTest(['contract', '--schema', 'flashcards']);
    const value = parseSuccess(schema.stdout) as {
      properties: { schemaVersion: { const: number } };
    };
    expect(value.properties.schemaVersion.const).toBe(1);

    const unknown = await runCliForTest(['contract', '--schema', 'unknown']);
    expect(unknown.stderr).toContain('Unknown contract schema: unknown');
    expect(unknown.exitCode).toBe(EXIT.USAGE);
  });
});
