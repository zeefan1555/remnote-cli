import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPairing } from '../../../src/remnote-cli/client/connection-config.js';
import { parseBatchInput } from '../../../src/remnote-cli/commands/batch.js';
import { DirectClient } from '../../../src/remnote-cli/client/direct-client.js';
import { MockRemNotePlugin } from '../../helpers/business-mocks.js';

const wire = vi.hoisted(() => ({
  open: vi.fn(),
  request: vi.fn(),
  close: vi.fn(),
  constructed: vi.fn(),
  plugin: undefined as MockRemNotePlugin | undefined,
}));
vi.mock('../../../src/remnote-cli/client/connection.js', () => ({
  Connection: class {
    timings = { connectionMs: 1, sdkCalls: 0, sdkMs: 1 };
    constructor(config: unknown) {
      wire.constructed(config);
    }
    open = wire.open;
    request = wire.request;
    close = wire.close;
  },
}));
vi.mock('../../../src/remnote-cli/client/remote-sdk.js', () => ({ remoteSdk: () => wire.plugin }));

import { createProgram } from '../../../src/remnote-cli/cli.js';

const directories: string[] = [];

async function batchFile(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'remnote-cli-batch-'));
  directories.push(directory);
  const path = join(directory, 'commands.json');
  await writeFile(path, contents, 'utf8');
  return path;
}

describe('batch input', () => {
  it('accepts a JSON array, a commands object, and JSONL', () => {
    expect(parseBatchInput('[{"argv":["read","a"]}]')).toEqual([{ argv: ['read', 'a'] }]);
    expect(parseBatchInput('{"commands":[{"argv":["status"]}]}')).toEqual([{ argv: ['status'] }]);
    expect(parseBatchInput('{"argv":["read","a"]}\n{"argv":["read","b"]}\n')).toEqual([
      { argv: ['read', 'a'] },
      { argv: ['read', 'b'] },
    ]);
    expect(() => parseBatchInput('')).toThrow(/empty/);
    expect(() => parseBatchInput('{"argv":[]}')).toThrow(/argv/);
  });
});

describe('batch command', () => {
  afterEach(async () => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  async function runBatch(args: string[]): Promise<Record<string, unknown>> {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await createProgram('0.1.0-test').parseAsync(['node', 'remnote-cli', 'batch', ...args], {
      from: 'node',
    });
    return JSON.parse(logs.at(-1) ?? '{}') as Record<string, unknown>;
  }

  it('runs every command on one retained client and can stop on error', async () => {
    const clients: DirectClient[] = [];
    let calls = 0;
    vi.spyOn(DirectClient.prototype, 'execute').mockImplementation(async function (
      this: DirectClient
    ) {
      clients.push(this);
      calls += 1;
      if (calls === 2) throw new Error('second failed');
      return { ok: true, call: calls };
    });
    const close = vi.spyOn(DirectClient.prototype, 'close');
    const path = await batchFile(
      [
        '{"argv":["read","a","--content-mode","none"]}',
        '{"argv":["read","missing"]}',
        '{"argv":["status"]}',
      ].join('\n')
    );
    const continued = await runBatch(['--file', path]);
    expect(continued.ok).toBe(false);
    expect(continued.count).toBe(3);
    expect(clients).toHaveLength(3);
    expect(new Set(clients).size).toBe(1);
    expect(close).toHaveBeenCalled();
    const stoppedClients: DirectClient[] = [];
    calls = 0;
    vi.spyOn(DirectClient.prototype, 'execute').mockImplementation(async function (
      this: DirectClient
    ) {
      stoppedClients.push(this);
      calls += 1;
      if (calls === 1) throw new Error('first failed');
      return { ok: true };
    });
    const stopped = await runBatch(['--file', path, '--stop-on-error']);
    expect(stopped.count).toBe(1);
    expect(stopped.stoppedEarly).toBe(true);
    expect(stoppedClients).toHaveLength(1);
  });

  it('rejects inner connection flags without opening a command', async () => {
    const execute = vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({ ok: true });
    const path = await batchFile('[{"argv":["--port","9","status"]}]');
    const output = await runBatch(['--file', path]);
    expect(output.ok).toBe(false);
    expect(JSON.stringify(output.results)).toMatch(/belongs on the batch command/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('reads and lists several ids over one bridge connection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remnote-cli-batch-conn-'));
    directories.push(directory);
    vi.stubEnv('REMNOTE_CLI_CONFIG', join(directory, 'connection.json'));
    await createPairing('kb');
    const data = { sdkVersion: '0.0.46', capabilities: [] };
    const sdkCatalogHash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    wire.open.mockResolvedValue({
      knowledgeBaseId: 'kb',
      acceptWriteOperations: true,
      acceptReplaceOperation: false,
      sdkCatalogHash,
      sdkVersion: '0.0.46',
    });
    wire.request.mockImplementation(async (action: string) =>
      action === 'get_sdk_capabilities' ? { ...data, sdkCatalogHash } : { connected: true }
    );
    const plugin = new MockRemNotePlugin();
    plugin.addTestRem('a', 'Alpha');
    plugin.addTestRem('b', 'Beta');
    const parent = plugin.addTestRem('parent', 'Parent');
    const other = plugin.addTestRem('other', 'Other');
    await plugin.addTestRem('child', 'Child').setParent(parent);
    await plugin.addTestRem('other-child', 'Other child').setParent(other);
    wire.plugin = plugin;
    const path = await batchFile(
      [
        '{"argv":["read","a","--content-mode","none"]}',
        '{"argv":["read","a","b","--content-mode","none"]}',
        '{"argv":["list-children","parent","--limit","10"]}',
        '{"argv":["list-children","parent","other","--limit","10"]}',
      ].join('\n')
    );
    const output = (await runBatch(['--file', path])) as {
      ok: boolean;
      results: Array<{ ok: boolean; result: Record<string, unknown> }>;
    };
    expect(output.ok).toBe(true);
    expect(output.results[0].result).toMatchObject({ remId: 'a', title: 'Alpha' });
    expect(output.results[0].result).not.toHaveProperty('results');
    expect(output.results[1].result.results).toMatchObject({
      a: { remId: 'a', title: 'Alpha' },
      b: { remId: 'b', title: 'Beta' },
    });
    expect(output.results[2].result).toMatchObject({ totalChildren: 1 });
    expect(output.results[2].result).not.toHaveProperty('results');
    const listed = output.results[3].result.results as Record<string, { totalChildren: number }>;
    expect(listed.parent.totalChildren).toBe(1);
    expect(listed.other.totalChildren).toBe(1);
    expect(wire.constructed).toHaveBeenCalledOnce();
    expect(wire.open).toHaveBeenCalledOnce();
    expect(wire.close).toHaveBeenCalledOnce();
  });

  it('keeps help and usage errors inside the envelope and continues', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit ${String(code)}`);
    }) as typeof process.exit);
    const leaked: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      leaked.push(String(chunk));
      return true;
    });
    const execute = vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({ ok: true });
    const close = vi.spyOn(DirectClient.prototype, 'close');
    const path = await batchFile(
      [
        '{"argv":["--version"]}',
        '{"argv":["--help"]}',
        '{"argv":["read","--help"]}',
        '{"argv":["read","--depth"]}',
        '{"argv":["flashcards"]}',
        '{"argv":["status"]}',
      ].join('\n')
    );
    const output = (await runBatch(['--file', path])) as {
      ok: boolean;
      count: number;
      results: Array<{ ok: boolean; exitCode: number; result?: unknown; error?: string }>;
    };
    expect(exit).not.toHaveBeenCalled();
    expect(output.count).toBe(6);
    expect(output.results[0]).toMatchObject({ ok: true, exitCode: 0, result: '0.1.0-test' });
    expect(output.results[1]).toMatchObject({ ok: true, exitCode: 0 });
    expect(String(output.results[1].result)).toMatch(/Direct RemNote SDK automation/);
    expect(output.results[1]).not.toHaveProperty('error');
    expect(output.results[2]).toMatchObject({ ok: true, exitCode: 0 });
    expect(String(output.results[2].result)).toMatch(/Read one or more notes/);
    expect(output.results[3]).toMatchObject({ ok: false, exitCode: 1 });
    expect(output.results[3].error).toMatch(/argument missing/);
    expect(output.results[4]).toMatchObject({ ok: false, exitCode: 1 });
    expect(output.results[5]).toMatchObject({ ok: true, exitCode: 0, result: { ok: true } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalled();
    expect(leaked.join('')).not.toMatch(
      /Direct RemNote SDK automation|0\.1\.0-test|argument missing/
    );
  });

  it('passes batch --allow-destructive to inner sdk calls and rejects the inner flag', async () => {
    const capability = {
      id: 'rem:setText',
      target: 'rem',
      method: 'setText',
      group: 'rem',
      command: 'object-set-text',
      signatures: ['setText: (text: RichTextInterface) => Promise<void>'],
      status: 'supported',
      mode: 'write',
    };
    const catalog = { sdkVersion: '0.0.46', capabilities: [capability] };
    const sdkCatalogHash = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
    const calls: Array<{ action: string; payload: Record<string, unknown> }> = [];
    vi.spyOn(DirectClient.prototype, 'execute').mockImplementation(async (action, payload) => {
      calls.push({ action, payload });
      if (action === 'get_sdk_capabilities') return { ...catalog, sdkCatalogHash };
      return { ok: true };
    });
    const path = await batchFile(
      '[{"argv":["sdk","rem","object-set-text","--target-id","rem-1","--args-json","[\\"Title\\"]"]}]'
    );
    const denied = (await runBatch(['--file', path])) as {
      ok: boolean;
      results: Array<{ result?: { allowDestructive?: boolean } }>;
    };
    expect(denied.ok).toBe(true);
    expect(calls.find((call) => call.action === 'sdk_call')?.payload).not.toHaveProperty(
      'allowDestructive'
    );
    calls.length = 0;
    const allowed = (await runBatch(['--allow-destructive', '--file', path])) as {
      ok: boolean;
    };
    expect(allowed.ok).toBe(true);
    expect(calls.find((call) => call.action === 'sdk_call')?.payload).toMatchObject({
      capability: 'rem:setText',
      targetId: 'rem-1',
      allowDestructive: true,
    });
    const inner = await batchFile(
      '[{"argv":["sdk","rem","object-set-text","--allow-destructive","--target-id","rem-1"]}]'
    );
    calls.length = 0;
    const rejected = (await runBatch(['--allow-destructive', '--file', inner])) as {
      ok: boolean;
      results: Array<{ error?: string }>;
    };
    expect(rejected.ok).toBe(false);
    expect(rejected.results[0].error).toMatch(/belongs on the batch command/);
    expect(calls).toEqual([]);
  });
});
