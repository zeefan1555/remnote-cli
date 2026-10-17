import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectClient } from '../../../src/remnote-cli/client/direct-client.js';
import { createProgram } from '../../../src/remnote-cli/cli.js';

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

function capture() {
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
  vi.spyOn(DirectClient.prototype, 'close').mockResolvedValue(undefined);
  return logs;
}

describe('inspect and assert commands', () => {
  it('inspects many ids in one execute and exits 0 when a rule fails without --strict', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remnote-state-cmd-'));
    const rules = join(directory, 'rules.json');
    await writeFile(
      rules,
      JSON.stringify({
        schemaVersion: 1,
        rules: [
          {
            id: 'code-line',
            path: 'rems[0].elements.backText.counts.code',
            op: 'equals',
            expect: 1,
          },
        ],
      }),
      'utf8'
    );
    const execute = vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({
      schemaVersion: 1,
      complete: true,
      truncated: false,
      rems: [{ id: 'answer', elements: { backText: { counts: { code: 0 } } } }],
      errors: [],
    });
    const logs = capture();
    await createProgram('0.1.0-test').parseAsync(
      [
        'node',
        'remnote-cli',
        'inspect',
        'answer',
        'other',
        '--expect',
        rules,
        '--fields',
        'elements',
      ],
      { from: 'node' }
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('inspect_state', {
      remIds: ['answer', 'other'],
      descendants: 0,
      fields: ['elements'],
    });
    const output = JSON.parse(logs.join('\n'));
    expect(output.assertions.rules[0]).toEqual({
      id: 'code-line',
      status: 'fail',
      actual: 0,
      expected: 1,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 1 for a failed rule only when --strict is set', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remnote-state-strict-'));
    const rules = join(directory, 'rules.json');
    await writeFile(
      rules,
      JSON.stringify({
        schemaVersion: 1,
        remIds: ['answer'],
        rules: [{ id: 'hash', path: 'rems[0].cards[0].hash', op: 'hashEquals', expect: 'stable' }],
      }),
      'utf8'
    );
    vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({
      complete: true,
      rems: [{ id: 'answer', cards: [{ hash: 'changed' }] }],
    });
    capture();
    await createProgram('0.1.0-test').parseAsync(
      ['node', 'remnote-cli', 'assert', '--file', rules, '--strict'],
      { from: 'node' }
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await createProgram('0.1.0-test').parseAsync(
      ['node', 'remnote-cli', 'assert', '--file', rules],
      { from: 'node' }
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('evaluates --against without opening a bridge and still exits 1 on a bad rules file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remnote-state-against-'));
    const rules = join(directory, 'rules.json');
    const inspect = join(directory, 'inspect.json');
    await writeFile(
      rules,
      JSON.stringify({
        schemaVersion: 1,
        rules: [
          { id: 'portal', path: 'rems[0].portal.portalType', op: 'equals', expect: 'searchPortal' },
        ],
      }),
      'utf8'
    );
    await writeFile(
      inspect,
      JSON.stringify({ rems: [{ portal: { portalType: 'searchPortal' } }] }),
      'utf8'
    );
    const execute = vi.spyOn(DirectClient.prototype, 'execute');
    const logs = capture();
    await createProgram('0.1.0-test').parseAsync(
      ['node', 'remnote-cli', 'assert', '--file', rules, '--against', inspect],
      { from: 'node' }
    );
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(logs.join('\n')).rules[0].status).toBe('pass');
    await createProgram('0.1.0-test').parseAsync(
      ['node', 'remnote-cli', 'assert', '--file', join(directory, 'missing.json')],
      { from: 'node' }
    );
    expect(process.exitCode).toBe(1);
  });

  it('reports an incomplete read and exits 1 under --strict even when rules pass', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remnote-state-incomplete-'));
    const rules = join(directory, 'rules.json');
    await writeFile(
      rules,
      JSON.stringify({
        schemaVersion: 1,
        remIds: ['answer'],
        rules: [{ id: 'text', path: 'rems[0].markdown', op: 'equals', expect: 'See' }],
      }),
      'utf8'
    );
    vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({
      complete: false,
      errors: [{ message: 'batch_read_failed: timeout' }],
      rems: [{ id: 'answer', markdown: 'See', errors: [{ field: 'cards', message: 'nope' }] }],
    });
    const logs = capture();
    await createProgram('0.1.0-test').parseAsync(
      ['node', 'remnote-cli', 'assert', '--file', rules, '--strict'],
      { from: 'node' }
    );
    const report = JSON.parse(logs.join('\n'));
    expect(report.ok).toBe(false);
    expect(report.complete).toBe(false);
    expect(report.errors).toEqual([
      { message: 'batch_read_failed: timeout' },
      { id: 'answer', field: 'cards', message: 'nope' },
    ]);
    expect(report.rules[0].status).toBe('pass');
    expect(process.exitCode).toBe(1);
  });

  it('sends powerup and slot codes from powerup get', async () => {
    const execute = vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({
      remId: 'portal',
      powerup: 'sp',
      slot: 'f',
      as: 'value',
      value: ['open'],
    });
    capture();
    await createProgram('0.1.0-test').parseAsync(
      [
        'node',
        'remnote-cli',
        'powerup',
        'get',
        '--rem',
        'portal',
        '--powerup',
        'sp',
        '--slot',
        'f',
      ],
      { from: 'node' }
    );
    expect(execute).toHaveBeenCalledWith('powerup_get', {
      remId: 'portal',
      powerup: 'sp',
      slot: 'f',
      as: 'value',
    });
  });
});
