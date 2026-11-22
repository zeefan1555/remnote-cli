import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

function run(target: string) {
  return spawnSync(process.execPath, [resolve('scripts/check-command-references.mjs'), target], {
    cwd: resolve('.'),
    encoding: 'utf8',
  });
}

describe('command reference check', () => {
  it('passes on the repository documentation and Skill examples', () => {
    expect(run('.').status).toBe(0);
  });

  it('fails on a stale command path in documentation or batch argv', async () => {
    directory = await mkdtemp(join(tmpdir(), 'remnote-command-refs-'));
    await writeFile(
      join(directory, 'stale.md'),
      'remnote-cli create "Legacy"\n\n{"argv":["read","REM_ID"]}\n\nremnote-cli schema powerup.get\n'
    );
    const result = run(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('stale command path');
    expect(result.stderr).toContain('create');
    expect(result.stderr).toContain('read');
    expect(result.stderr).toContain('powerup.get');
    expect(result.stderr).toContain('rem powerup get');
  });
});
