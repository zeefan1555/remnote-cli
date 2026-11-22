import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

function runCheck(source: string) {
  return spawnSync(process.execPath, ['scripts/sync-sdk-facts.mjs', source, '--check'], {
    cwd: resolve(import.meta.dirname, '../..'),
    encoding: 'utf8',
  });
}

describe('SDK facts sync', () => {
  it('accepts the committed facts in check mode', () => {
    const source = resolve('src/remnote-cli/spec/sdk-facts.generated.json');
    const result = runCheck(source);
    expect(result.status).toBe(0);
  });

  it('rejects a changed hash without rewriting generated files', async () => {
    directory = await mkdtemp(join(tmpdir(), 'remnote-sdk-facts-'));
    const source = resolve('src/remnote-cli/spec/sdk-facts.generated.json');
    const value = JSON.parse(await readFile(source, 'utf8'));
    value.sdkCatalogHash = '0'.repeat(64);
    const changed = join(directory, 'sdk-facts.json');
    await writeFile(changed, JSON.stringify(value, null, 2) + '\n');

    const result = runCheck(changed);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('hash does not match');
  });
});
