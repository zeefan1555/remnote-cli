import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/check-version.mjs');
const repository = resolve('.');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function run(args: string[] = [], cwd = repository) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

interface FixtureOptions {
  packageVersion?: string;
  lockVersion?: string;
  rootLockVersion?: string;
  changelogVersion?: string;
}

async function createFixture({
  packageVersion = '0.1.30',
  lockVersion = packageVersion,
  rootLockVersion = packageVersion,
  changelogVersion = packageVersion,
}: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'remnote-version-check-'));
  temporaryDirectories.push(directory);
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'fixture', version: packageVersion }) + '\n'
  );
  await writeFile(
    join(directory, 'package-lock.json'),
    JSON.stringify({
      name: 'fixture',
      version: lockVersion,
      lockfileVersion: 3,
      packages: { '': { name: 'fixture', version: rootLockVersion } },
    }) + '\n'
  );
  await writeFile(
    join(directory, 'CHANGELOG.md'),
    '# Changelog\n\n## [' + changelogVersion + '] - 2026-11-23\n'
  );
  return directory;
}

describe('version policy check', () => {
  it('passes on the current repository', () => {
    const result = run();

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('Version 0.1.31 is valid.');
    expect(result.stderr).toBe('');
  });

  it.each([
    ['0.1.1', '0.1.2'],
    ['0.1.30', '0.1.31'],
    ['0.42.99', '0.42.100'],
    ['0.1.100', '0.2.1'],
  ])('increments valid version %s to %s', (current, next) => {
    const result = run(['--next', current]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(next);
    expect(result.stderr).toBe('');
  });

  it.each(['0.0.1', '0.1.0', '0.1.101', '1.1.1', '0.01.1', '0.1.01', '0.1.1-rc.1'])(
    'rejects malformed version %s',
    (version) => {
      const result = run(['--next', version]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Invalid version "' + version + '"');
      expect(result.stderr).toContain('0.<positive-minor>.<1..100>');
    }
  );

  it.each<[string, FixtureOptions, string]>([
    ['lockfile', { lockVersion: '0.1.29' }, 'package-lock.json version'],
    ['root package', { rootLockVersion: '0.1.29' }, 'package-lock.json packages[""] version'],
  ])('rejects a %s version disagreement', async (_label, options, message) => {
    const directory = await createFixture(options);
    const result = run([], directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain('expected "0.1.30"');
  });

  it('rejects a missing changelog heading', async () => {
    const directory = await createFixture({ changelogVersion: '0.1.29' });
    const result = run([], directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CHANGELOG.md is missing heading "## [0.1.30]"');
  });
});
