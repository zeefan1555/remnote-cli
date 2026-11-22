import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  buildCliContract,
  CONTRACT_SCHEMA_NAMES,
  contractSchema,
} from '../../src/schemas/contract.js';

describe('generated CLI contract', () => {
  it('matches the committed generated artifact', async () => {
    const generated = JSON.parse(await readFile('docs/guides/cli-contract.generated.json', 'utf8'));
    expect(generated).toEqual(buildCliContract());
  });

  it('contains all plan schemas and live capability requirements', () => {
    expect(CONTRACT_SCHEMA_NAMES).toEqual(['flashcards', 'wiki', 'workspace']);
    for (const name of CONTRACT_SCHEMA_NAMES) expect(contractSchema(name)).toBeDefined();
    const contract = buildCliContract();
    expect(contract.requiredCapabilities.flashcards.create).toContain(
      'namespace:rem.createTreeWithMarkdown'
    );
    expect(contract.requiredCapabilities.wiki.pages).toContain('namespace:rem.createRem');
    expect(contract.bridgeActions).not.toContain('transaction_begin');
    expect(contract.output).toMatchObject({
      schemaVersion: 2,
      successStream: 'stdout',
      failureStream: 'stderr',
    });
    expect(contract.exitCodes.unknownOutcome).toBe(5);
  });
});
