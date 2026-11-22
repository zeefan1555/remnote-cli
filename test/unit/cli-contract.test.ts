import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  buildCliContract,
  CONTRACT_SCHEMA_NAMES,
  contractSchema,
} from '../../src/schemas/contract.js';
import { createProgram } from '../../src/remnote-cli/cli.js';
import { createBufferedRuntime } from '../../src/remnote-cli/output/runtime.js';
import { buildCommandSpecs } from '../../src/remnote-cli/spec/command-spec.js';

function contractWithCommands() {
  const program = createProgram('contract-test', createBufferedRuntime());
  return buildCliContract(buildCommandSpecs(program));
}

describe('generated CLI contract', () => {
  it('matches the committed generated artifact', async () => {
    const generated = JSON.parse(await readFile('docs/guides/cli-contract.generated.json', 'utf8'));
    expect(generated).toEqual(contractWithCommands());
  });

  it('contains all plan schemas and live capability requirements', () => {
    expect(CONTRACT_SCHEMA_NAMES).toEqual(['flashcards', 'wiki', 'workspace']);
    for (const name of CONTRACT_SCHEMA_NAMES) expect(contractSchema(name)).toBeDefined();
    const contract = contractWithCommands();
    expect(contract.requiredCapabilities.flashcards.create).toContain(
      'namespace:rem.createTreeWithMarkdown'
    );
    expect(contract.requiredCapabilities.wiki.pages).toContain('namespace:rem.createRem');
    expect(contract.bridgeActions).not.toContain('transaction_begin');
    expect(contract.sdkFacts).toEqual({
      schemaVersion: 1,
      sdkVersion: '0.0.46',
      catalogHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      capabilities: expect.any(Number),
    });
    expect(contract.output).toMatchObject({
      schemaVersion: 2,
      successStream: 'stdout',
      failureStream: 'stderr',
    });
    expect(contract.exitCodes.unknownOutcome).toBe(5);
    expect(contract.schemaVersion).toBe(2);
    expect(contract.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'rem search',
          kind: 'action',
          risk: 'read',
          bridge: 'required',
        }),
        expect.objectContaining({ path: 'sync', kind: 'group' }),
        expect.objectContaining({
          path: 'rem move',
          kind: 'action',
          risk: 'destructive',
          bridge: 'required',
        }),
        expect.objectContaining({ path: 'schema', kind: 'action', risk: 'read', bridge: 'none' }),
      ])
    );
  });
});
