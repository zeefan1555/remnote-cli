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
      'remnote-cli create "Legacy"\n\n{"argv":["read","REM_ID"]}\n\nremnote-cli schema powerup.get\n\nUse `update-tags` for legacy tags.\nUse `context --request request.json` first.\nUse `verify scope --expect rules.json` for proof.\n'
    );
    const result = run(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('stale command path');
    expect(result.stderr).toContain('create');
    expect(result.stderr).toContain('read');
    expect(result.stderr).toContain('powerup.get');
    expect(result.stderr).toContain('rem powerup get');
    expect(result.stderr).toContain('update-tags');
    expect(result.stderr).toContain('rem tags update');
    expect(result.stderr).toContain('verify scope');
    expect(result.stderr).toContain('rem verify scope');
    expect(result.stderr).toContain('stale command path "context"');
    expect(result.stderr).toContain('rem context');
  });

  it('accepts the journal group followed by its action', async () => {
    directory = await mkdtemp(join(tmpdir(), 'remnote-command-refs-'));
    await writeFile(
      join(directory, 'current.md'),
      'remnote-cli journal append "Current"\n\n{"argv":["journal","append","Current"]}\n'
    );
    expect(run(directory).status).toBe(0);
  });

  it('rejects removed card workflows and task schema discovery', async () => {
    directory = await mkdtemp(join(tmpdir(), 'remnote-command-refs-'));
    await writeFile(
      join(directory, 'removed.md'),
      'remnote-cli card apply --plan cards.json\nremnote-cli card review-stats REM_ID\nremnote-cli flashcards apply\nremnote-cli contract --schema flashcards\nUse `card apply` for cards.\n'
    );
    const result = run(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('card apply');
    expect(result.stderr).toContain('card review-stats');
    expect(result.stderr).toContain('flashcards');
    expect(result.stderr).toContain('contract --schema');
    expect(result.stderr).toContain('rem inspect');
  });

  it('accepts native Rem card commands and generic sdk card inspection', async () => {
    directory = await mkdtemp(join(tmpdir(), 'remnote-command-refs-'));
    await writeFile(
      join(directory, 'native.md'),
      'remnote-cli rem create --content "Question >> Answer"\nremnote-cli rem update REM_ID --content "Question"\nremnote-cli rem update-answer ANSWER_ID --card-id REM_ID\nremnote-cli rem inspect REM_ID --fields cards,rawCards\nremnote-cli sdk card --help\nremnote-cli schema sdk.card\n'
    );
    expect(run(directory).status).toBe(0);
  });
});
