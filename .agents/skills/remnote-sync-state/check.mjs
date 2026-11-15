import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const area = dirname(fileURLToPath(import.meta.url));
const root = resolve(area, '../../..');
const version = '1.7.4';
const checksum = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88';
const java = process.env.REMNOTE_SYNC_JAVA ?? 'java';
const cases = [
  ['SyncState', 'safe', null],
  ['SyncState', 'overview', null],
  ['SyncState', 'replay', 'NoBlindReplay'],
  ['SyncState', 'replay-create', 'NoDuplicateCreate'],
  ['SyncState', 'replay-id', 'PersistedIdentityRetained'],
  ['SyncState', 'skip-observation', 'OnlyExactObservedPublication'],
  ['SyncState', 'skip-input', 'PublicationInputBound'],
  ['ReadSetScope', 'readset-safe', null],
  ['ReadSetScope', 'readset-overview', null],
  ['ReadSetScope', 'readset-narrow-initial', 'FullInitialCoverage'],
  ['ReadSetScope', 'readset-narrow-final', 'FullFinalCoverage'],
  ['ReadSetScope', 'readset-drop-old-target', 'TouchedPostCoverage'],
  ['ReadSetScope', 'readset-cached-card', 'ObservedCardIdentityPreserved'],
  ['ReadSetScope', 'readset-cached-history', 'ObservedReviewHistoryPreserved'],
  ['ReadSetScope', 'readset-cached-facts', 'FreshRelationshipObservation'],
  ['PublicationWindow', 'window', 'FreshAtPublication'],
];

async function run() {
  const javaVersion = spawnSync(java, ['-version'], { encoding: 'utf8' });
  const major = /version "(?:1\.)?(\d+)/.exec(javaVersion.stderr ?? '')?.[1];
  if (javaVersion.status !== 0 || !major || Number(major) < 11)
    throw new Error('Java 11+ is required. Set REMNOTE_SYNC_JAVA to its java binary.');

  const jar =
    process.env.REMNOTE_SYNC_TLC_JAR ??
    join(root, 'node_modules/.cache/remnote-sync-state', `tla2tools-${version}.jar`);
  let bytes;
  try {
    bytes = await readFile(jar);
  } catch (error) {
    if (error.code !== 'ENOENT' || process.env.REMNOTE_SYNC_TLC_JAR) throw error;
    const response = await fetch(
      `https://github.com/tlaplus/tlaplus/releases/download/v${version}/tla2tools.jar`
    );
    if (!response.ok) throw new Error(`TLC download returned HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== checksum)
      throw new Error('Downloaded TLC checksum mismatch; no verifier was executed.');
    await mkdir(dirname(jar), { recursive: true, mode: 0o700 });
    await writeFile(jar, bytes, { flag: 'wx', mode: 0o600 });
  }
  if (createHash('sha256').update(bytes).digest('hex') !== checksum)
    throw new Error('TLC checksum mismatch; no verifier was executed.');

  const out = await mkdtemp(join(tmpdir(), 'remnote-sync-state-'));
  console.log(`Evidence: ${out}`);
  for (const model of new Set(cases.map(([model]) => model)))
    await copyFile(join(area, `${model}.tla`), join(out, `${model}.tla`));

  for (const [model, name, broken] of cases) {
    await copyFile(join(area, `${name}.cfg`), join(out, `${name}.cfg`));
    const result = spawnSync(
      java,
      [
        '-Xmx512m',
        '-XX:+UseParallelGC',
        `-Djava.io.tmpdir=${out}`,
        '-cp',
        jar,
        'tlc2.TLC',
        '-workers',
        '1',
        '-seed',
        '1',
        '-fp',
        '0',
        '-config',
        `${name}.cfg`,
        '-metadir',
        join(out, `states-${name}`),
        `${model}.tla`,
      ],
      { cwd: out, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    await writeFile(join(out, `${name}.log`), output);
    const valid = broken
      ? result.status === 12 && output.includes(`Invariant ${broken} is violated.`)
      : result.status === 0 &&
        output.includes('Model checking completed. No error has been found.');
    if (!valid) throw new Error(`${name} produced an unexpected result. Read ${out}/${name}.log`);
    const count = /\d+ states generated, \d+ distinct states found[^\n]*/.exec(output)?.[0];
    console.log(`${name}: ${broken ? `expected counterexample ${broken}` : 'PASS'}; ${count}`);
  }

  const result = spawnSync(
    process.execPath,
    [
      join(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      'test/unit/business/workspace.test.ts',
      'test/unit/business/workspace-state-contract.test.ts',
      'test/unit/business/workspace-readset.test.ts',
      '--maxWorkers=1',
      '--testNamePattern',
      'rejects an uncertain create without|reuses a known empty orphan|recognizes an already-applied uncertain setter|does not retry an uncertain setter|resumes a confirmed-after uncertain tag write|never retries unknown writes|persists a returned create ID|writes native tags|sync state model implementation witnesses|mutation graph readsets|rejects stale external lint|same-apply native Card evidence|changed known sealed Card IDs|does not substitute sealed facts|refuses final publication when|full selected native guard|removed Tag target|rejects independent Cards on a new answer',
    ],
    { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  await writeFile(join(out, 'implementation.log'), output);
  if (result.status !== 0) {
    process.stdout.write(output);
    throw new Error(`Implementation regression failed. Read ${out}/implementation.log`);
  }
  process.stdout.write(output);
  console.log('PASS: model invariants, failing variants, implementation regressions.');
  console.log(
    'Expected limitation: observation is not a transaction or publication-time freshness.'
  );
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
