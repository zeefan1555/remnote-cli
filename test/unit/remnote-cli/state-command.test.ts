import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectClient } from '../../../src/remnote-cli/client/direct-client.js';
import { EXIT } from '../../../src/remnote-cli/output/errors.js';
import { InspectStateSchema } from '../../../src/schemas/state-schemas.js';
import { parseFailure, parseSuccess, runCliForTest } from '../../helpers/run-cli.js';

interface RuleResult {
  id: string;
  status: string;
  actual: unknown;
  expected: unknown;
}

interface RuleReport {
  ok?: boolean;
  complete?: boolean;
  errors?: unknown[];
  assertions?: { rules: RuleResult[] };
  rules?: RuleResult[];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('inspect and assert commands', () => {
  it('accepts explicit native audit fields through the CLI and strict schema', async () => {
    const fields = [
      'isDocument',
      'isFolder',
      'isTable',
      'isProperty',
      'isPowerup',
      'isPowerupSlot',
      'isPowerupProperty',
      'isPowerupEnum',
      'isPowerupPropertyListItem',
      'rawCards',
    ];
    expect(InspectStateSchema.safeParse({ remIds: ['root'], fields }).success).toBe(true);
    const execute = vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({
      schemaVersion: 1,
      complete: true,
      truncated: false,
      rems: [{ id: 'root', rawCards: [] }],
      errors: [],
    });
    vi.spyOn(DirectClient.prototype, 'close').mockResolvedValue(undefined);

    const result = await runCliForTest([
      'rem',
      'inspect',
      'root',
      '--fields',
      fields.join(','),
      '--strict',
    ]);

    expect(result.exitCode).toBe(0);
    expect(execute).toHaveBeenCalledWith('inspect_state', {
      remIds: ['root'],
      descendants: 0,
      fields,
    });
  });

  it('inspects many ids and succeeds without --strict when a rule fails', async () => {
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
    vi.spyOn(DirectClient.prototype, 'close').mockResolvedValue(undefined);

    const result = await runCliForTest([
      'rem',
      'inspect',
      'answer',
      'other',
      '--expect',
      rules,
      '--fields',
      'elements',
    ]);
    const output = parseSuccess(result.stdout) as RuleReport;

    expect(result.exitCode).toBe(0);
    expect(execute).toHaveBeenCalledWith('inspect_state', {
      remIds: ['answer', 'other'],
      descendants: 0,
      fields: ['elements'],
    });
    expect(output.assertions?.rules[0]).toEqual({
      id: 'code-line',
      status: 'fail',
      actual: 0,
      expected: 1,
    });
  });

  it('fails with a conflict only when --strict is set', async () => {
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
    vi.spyOn(DirectClient.prototype, 'close').mockResolvedValue(undefined);

    const strict = await runCliForTest(['rem', 'assert', '--file', rules, '--strict']);
    expect(strict.exitCode).toBe(EXIT.NOT_FOUND_OR_CONFLICT);
    expect(parseFailure(strict.stderr).subtype).toBe('strict_assertion_failed');

    const normal = await runCliForTest(['rem', 'assert', '--file', rules]);
    expect(normal.exitCode).toBe(0);
    expect((parseSuccess(normal.stdout) as RuleReport).rules?.[0]?.status).toBe('fail');
  });

  it('evaluates --against without opening a bridge and reports a missing input', async () => {
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

    const passed = await runCliForTest(['rem', 'assert', '--file', rules, '--against', inspect]);
    expect(execute).not.toHaveBeenCalled();
    expect((parseSuccess(passed.stdout) as RuleReport).rules?.[0]?.status).toBe('pass');

    const missing = await runCliForTest([
      'rem',
      'assert',
      '--file',
      join(directory, 'missing.json'),
    ]);
    expect(missing.exitCode).toBe(EXIT.NOT_FOUND_OR_CONFLICT);
    expect(missing.stderr).toContain('ENOENT');
  });

  it('reports an incomplete strict read in error details', async () => {
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
    vi.spyOn(DirectClient.prototype, 'close').mockResolvedValue(undefined);

    const result = await runCliForTest(['rem', 'assert', '--file', rules, '--strict']);
    const failure = parseFailure(result.stderr);
    const report = failure.details as RuleReport;

    expect(result.exitCode).toBe(EXIT.NOT_FOUND_OR_CONFLICT);
    expect(report.ok).toBe(false);
    expect(report.complete).toBe(false);
    expect(report.errors).toEqual([
      { message: 'batch_read_failed: timeout' },
      { id: 'answer', field: 'cards', message: 'nope' },
    ]);
    expect(report.rules?.[0]?.status).toBe('pass');
  });

  it('sends powerup and slot codes from powerup get', async () => {
    const execute = vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({
      remId: 'portal',
      powerup: 'sp',
      slot: 'f',
      as: 'value',
      value: ['open'],
    });

    const result = await runCliForTest([
      'rem',
      'powerup',
      'get',
      '--rem',
      'portal',
      '--powerup',
      'sp',
      '--slot',
      'f',
    ]);

    expect(result.exitCode).toBe(0);
    expect(execute).toHaveBeenCalledWith('powerup_get', {
      remId: 'portal',
      powerup: 'sp',
      slot: 'f',
      as: 'value',
    });
  });
});
