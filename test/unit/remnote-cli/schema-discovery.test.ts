import { describe, expect, it } from 'vitest';
import { EXIT } from '../../../src/remnote-cli/output/errors.js';
import { parseFailure, parseSuccess, runCliForTest } from '../../helpers/run-cli.js';

interface CompletionOutput {
  schemaVersion: number;
  path: string;
  candidates: Array<{ name: string; path: string; kind: string }>;
}

describe('schema and completion discovery', () => {
  it('accepts dotted and space command paths', async () => {
    const dotted = await runCliForTest(['schema', 'sdk.rem.object-get-children-rem']);
    const spaces = await runCliForTest(['schema', 'sdk', 'rem', 'object-get-children-rem']);
    const dottedValue = parseSuccess(dotted.stdout) as { path: string; kind: string };
    const spacesValue = parseSuccess(spaces.stdout) as { path: string; kind: string };
    expect(dottedValue).toMatchObject({ path: 'sdk rem object-get-children-rem', kind: 'action' });
    expect(dottedValue).toMatchObject({
      input: { required: expect.arrayContaining(['targetId']) },
    });
    expect(spacesValue).toEqual(dottedValue);
  });

  it('prints a hierarchical tree for a group', async () => {
    const result = await runCliForTest(['schema', 'sdk.rem', '--tree']);
    const value = parseSuccess(result.stdout) as {
      schemaVersion: number;
      tree: Array<{ name: string; kind: string }>;
    };
    expect(value.schemaVersion).toBe(2);
    expect(value.tree).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'object-get-children-rem', kind: 'action' }),
        expect.objectContaining({ name: 'object-remove', kind: 'action' }),
      ])
    );
  });

  it('rejects a tree request for an action instead of returning the root tree', async () => {
    const result = await runCliForTest(['schema', 'sdk.rem.object-get-children-rem', '--tree']);
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(parseFailure(result.stderr)).toMatchObject({ subtype: 'tree_requires_group' });
  });

  it('requires a target for a concrete Rem or Card method', async () => {
    const result = await runCliForTest([
      'sdk',
      'rem',
      'object-get-children-rem',
      '--args-json',
      '[]',
    ]);
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(parseFailure(result.stderr)).toMatchObject({
      subtype: 'commander.missingMandatoryOptionValue',
    });
  });

  it('returns root, group and partial method candidates from the same catalog', async () => {
    const root = parseSuccess((await runCliForTest(['completion'])).stdout) as CompletionOutput;
    expect(root.candidates.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['sdk', 'rem', 'todo'])
    );
    expect(root.candidates.map(({ name }) => name)).not.toContain('sync');
    expect(root.candidates.map(({ name }) => name)).not.toContain('completion');
    expect(root.candidates.map(({ name }) => name)).not.toContain('card');

    const group = parseSuccess(
      (await runCliForTest(['completion', 'sdk'])).stdout
    ) as CompletionOutput;
    expect(group.candidates.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['call', 'capabilities', 'rem', 'card'])
    );
    expect(group.path).toBe('sdk');
    const nestedGroup = parseSuccess(
      (await runCliForTest(['completion', 'sdk', 'rem'])).stdout
    ) as CompletionOutput;
    expect(nestedGroup.path).toBe('sdk rem');

    const methods = parseSuccess(
      (await runCliForTest(['completion', 'sdk', 'rem', 'object-get'])).stdout
    ) as CompletionOutput;
    expect(methods.candidates.map(({ name }) => name)).toContain('object-get-children-rem');
  });

  it('keeps the hidden completion command out of root help', async () => {
    const result = await runCliForTest(['--help']);
    expect(result.stdout).not.toContain('completion [command-path...]');
  });

  it('returns a structured usage error for an unknown schema path', async () => {
    const result = await runCliForTest(['schema', 'sdk.rem.missing']);
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(parseFailure(result.stderr)).toMatchObject({ subtype: 'unknown_command_schema' });
  });
});
