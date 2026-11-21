import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../../src/remnote-cli/cli.js';

afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
});

describe('contract command', () => {
  it('prints the full contract without opening a Bridge session', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram('test').parseAsync(['node', 'remnote-cli', 'contract']);
    const value = JSON.parse(log.mock.calls[0]![0]);
    expect(value).toMatchObject({
      schemaVersion: 1,
      protocolVersion: 2,
      bridgeActions: ['get_status', 'get_sdk_capabilities', 'sdk_call'],
      exitCodes: { success: 0, validationConnectionOrIncomplete: 1 },
    });
    expect(value.plans.flashcards.$schema).toContain('json-schema.org');
    expect(value.plans.workspace.properties.operation.enum).toContain('apply');
  });

  it('prints one schema and rejects an unknown name', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram('test').parseAsync([
      'node',
      'remnote-cli',
      'contract',
      '--schema',
      'flashcards',
    ]);
    expect(JSON.parse(log.mock.calls[0]![0]).properties.schemaVersion.const).toBe(1);
    await createProgram('test').parseAsync([
      'node',
      'remnote-cli',
      'contract',
      '--schema',
      'unknown',
    ]);
    expect(error).toHaveBeenCalledWith('Unknown contract schema: unknown');
    expect(process.exitCode).toBe(1);
  });
});
