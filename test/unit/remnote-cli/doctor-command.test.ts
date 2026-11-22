import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectClient } from '../../../src/remnote-cli/client/direct-client.js';
import { EXIT } from '../../../src/remnote-cli/output/errors.js';
import { buildCliContract } from '../../../src/schemas/contract.js';
import { parseFailure, parseSuccess, runCliForTest } from '../../helpers/run-cli.js';

interface DoctorReport {
  schemaVersion: number;
  ok: boolean;
  offline: boolean;
  checks: Array<{ id: string; status: string; details?: unknown }>;
  summary: { pass: number; warn: number; fail: number; skip: number };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function stateHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'remnote-doctor-'));
  temporaryDirectories.push(directory);
  const state = join(directory, 'state-home');
  await mkdir(state, { recursive: true, mode: 0o700 });
  await chmod(state, 0o700);
  vi.stubEnv('REMNOTE_CLI_STATE_HOME', state);
  return state;
}

function requiredCapabilityIds(): string[] {
  const ids = new Set<string>();
  function visit(value: unknown): void {
    if (typeof value === 'string') ids.add(value);
    else if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value && typeof value === 'object')
      for (const item of Object.values(value)) visit(item);
  }
  visit(buildCliContract().requiredCapabilities);
  return [...ids].sort();
}

function catalog() {
  const capabilities = requiredCapabilityIds().map((id) => ({
    id,
    target: 'namespace' as const,
    method: 'method',
    group: 'test',
    command: id.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    signatures: ['method: () => Promise<void>'],
    status: 'supported' as const,
    mode: 'read' as const,
  }));
  const sdkVersion = '0.0.46';
  const sdkCatalogHash = createHash('sha256')
    .update(JSON.stringify({ sdkVersion, capabilities }))
    .digest('hex');
  return { sdkVersion, sdkCatalogHash, capabilities };
}

function mockHealthyBridge(catalogValue: ReturnType<typeof catalog>): void {
  vi.spyOn(DirectClient.prototype, 'execute').mockImplementation(async (action) => {
    if (action === 'get_status')
      return {
        connected: true,
        pluginId: 'remnote-cli-bridge',
        pluginVersion: '0.25.0',
        protocolVersion: 2,
        sdkVersion: catalogValue.sdkVersion,
        sdkCatalogHash: catalogValue.sdkCatalogHash,
        knowledgeBaseId: 'kb',
        knowledgeBaseName: 'Test',
      };
    if (action === 'get_sdk_capabilities') return catalogValue;
    throw new Error('Unexpected doctor action: ' + action);
  });
}

describe('doctor command', () => {
  it('runs offline without constructing a client or accepting a damaged command tree', async () => {
    await stateHome();
    const execute = vi.spyOn(DirectClient.prototype, 'execute');

    const result = await runCliForTest(['doctor', '--offline']);
    const report = parseSuccess(result.stdout) as DoctorReport;

    expect(result.exitCode).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(report.offline).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'node', status: 'pass' }),
        expect.objectContaining({ id: 'state_directory', status: 'pass' }),
        expect.objectContaining({ id: 'command_contract', status: 'pass' }),
        expect.objectContaining({ id: 'bridge', status: 'skip' }),
      ])
    );
    expect(report.summary.fail).toBe(0);
  });

  it('reports a healthy live Bridge, SDK catalog and journal', async () => {
    const state = await stateHome();
    const catalogValue = catalog();
    mockHealthyBridge(catalogValue);
    const journalDirectory = join(state, 'state', createHash('sha256').update('kb').digest('hex'));
    await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
    await chmod(journalDirectory, 0o700);
    const journal = join(journalDirectory, 'journal.json');
    await writeFile(journal, '{"ok":true}', { mode: 0o600 });
    await chmod(journal, 0o600);

    const result = await runCliForTest(['doctor']);
    const report = parseSuccess(result.stdout) as DoctorReport;

    expect(result.exitCode).toBe(0);
    expect(report.offline).toBe(false);
    expect(report.summary.fail).toBe(0);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'bridge', status: 'pass' }),
        expect.objectContaining({ id: 'plugin', status: 'pass' }),
        expect.objectContaining({ id: 'protocol', status: 'pass' }),
        expect.objectContaining({ id: 'knowledge_base', status: 'pass' }),
        expect.objectContaining({ id: 'sdk_catalog', status: 'pass' }),
        expect.objectContaining({ id: 'capabilities', status: 'pass' }),
        expect.objectContaining({ id: 'journal', status: 'pass' }),
      ])
    );
  });

  it('returns a structured configuration failure when the Bridge is unavailable', async () => {
    await stateHome();
    vi.spyOn(DirectClient.prototype, 'execute').mockRejectedValue(
      new Error('Bridge connection refused')
    );

    const result = await runCliForTest(['doctor']);
    const failure = parseFailure(result.stderr);
    const report = failure.details as DoctorReport;

    expect(result.exitCode).toBe(EXIT.UNAVAILABLE);
    expect(failure.type).toBe('configuration');
    expect(report.summary.fail).toBeGreaterThan(0);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'bridge', status: 'fail' }),
        expect.objectContaining({ id: 'plugin', status: 'skip' }),
      ])
    );
  });

  it('detects malformed private journal files without modifying them', async () => {
    const state = await stateHome();
    const catalogValue = catalog();
    mockHealthyBridge(catalogValue);
    const journalDirectory = join(state, 'state', createHash('sha256').update('kb').digest('hex'));
    await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
    await chmod(journalDirectory, 0o700);
    const journal = join(journalDirectory, 'broken.json');
    await writeFile(journal, '{bad', { mode: 0o600 });
    await chmod(journal, 0o600);

    const result = await runCliForTest(['doctor']);
    const report = parseFailure(result.stderr).details as DoctorReport;
    const journalCheck = report.checks.find((check) => check.id === 'journal');

    expect(result.exitCode).toBe(EXIT.UNAVAILABLE);
    expect(journalCheck).toMatchObject({ status: 'fail' });
    expect(await import('node:fs/promises').then(({ readFile }) => readFile(journal, 'utf8'))).toBe(
      '{bad'
    );
  });

  it('prints human-readable diagnostics', async () => {
    await stateHome();
    const result = await runCliForTest(['--text', 'doctor', '--offline']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[PASS] node:');
    expect(result.stdout).toContain('Summary: pass=');
  });
});
