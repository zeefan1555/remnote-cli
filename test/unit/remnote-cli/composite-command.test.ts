import { describe, it, expect, vi } from 'vitest';
import { createProgram } from '../../../src/remnote-cli/cli.js';
import { DirectClient } from '../../../src/remnote-cli/client/direct-client.js';
import { readContentFileOrStdin } from '../../../src/remnote-cli/commands/content-input.js';
import { EXIT } from '../../../src/remnote-cli/output/errors.js';
import { summarizeReceipt } from '../../../src/remnote-cli/output/receipt-summary.js';
import { parseFailure, parseSuccess, runCliForTest } from '../../helpers/run-cli.js';

vi.mock('../../../src/remnote-cli/commands/content-input.js', () => ({
  readContentFileOrStdin: vi.fn(),
}));

const inspect = { schemaVersion: 1, remIds: ['r'] };
const receipt = {
  schemaVersion: 1,
  requestId: 'request',
  readWindow: { startedAt: 'start', finishedAt: 'end' },
  complete: true,
  truncation: null,
  objects: [],
  scopes: [],
  checks: [],
  errors: [],
};
const plans = {
  flashcards: {
    schemaVersion: 1,
    reusedCardRemIds: ['card'],
  },
  wiki: {
    schemaVersion: 1,
    wikiRootId: 'wiki',
    partitionRemId: 'part',
    indexRemId: 'index',
    logRemId: 'log',
    pages: [{ key: 'p', title: 'Page', nodes: [], summary: ['Summary'] }],
  },
};
const taskReceipt = {
  schemaVersion: 1,
  kind: 'flashcards',
  batchKey: 'batch',
  planHash: 'a'.repeat(64),
  ids: { 'card:c': 'r' },
  facts: [{ remId: 'r', textHash: 'a'.repeat(64), cardIds: ['c'], reviewHash: 'b'.repeat(64) }],
  status: 'preview',
  complete: true,
  created: [],
  updated: [],
  reused: [],
  skipped: [],
  steps: [],
  checks: [],
  readWindow: { startedAt: 'start', finishedAt: 'end' },
  errors: [],
};

describe('four composite commands', () => {
  it('keeps every recovery identity when an answer write succeeds before facts fail', () => {
    const partial = {
      ...taskReceipt,
      ids: {},
      facts: [],
      status: 'partial',
      complete: false,
      updated: [{ key: 'patch:p', remId: 'written-answer' }],
      steps: [{ key: 'patch:p', state: 'verified', remIds: ['written-answer'] }],
      errors: [{ code: 'operation_failed', message: 'Card facts read failed' }],
    };
    const summary = summarizeReceipt(partial);
    for (const field of [
      'created',
      'updated',
      'reused',
      'skipped',
      'steps',
      'ids',
      'facts',
      'errors',
    ] as const)
      expect(summary[field]).toEqual(partial[field]);
  });

  it.each(['flashcards', 'wiki'] as const)(
    'summarizes %s in failure details without losing recovery evidence',
    async (kind) => {
      vi.mocked(readContentFileOrStdin).mockResolvedValue(JSON.stringify(plans[kind]));
      const result = {
        ...taskReceipt,
        kind,
        status: 'partial',
        complete: false,
        verificationScope: 'affected_objects',
        checks: [
          { kind: 'parent', remId: 'r', status: 'passed' },
          { kind: 'references', remId: 'r', status: 'failed', message: 'Missing target' },
        ],
        errors: [{ code: 'incomplete', message: 'Failed proof' }],
      };
      vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue(result);

      const output = await runCliForTest([
        kind,
        'apply',
        '--plan',
        '-',
        '--idempotency-key',
        'batch',
        '--apply',
        '--summary',
      ]);
      const failure = parseFailure(output.stderr);
      const details = failure.details as Record<string, unknown>;

      expect(output.exitCode).toBe(EXIT.NOT_FOUND_OR_CONFLICT);
      expect(details.ids).toEqual(result.ids);
      expect(details.facts).toEqual(result.facts);
      expect(details.planHash).toBe(result.planHash);
      expect(details.verificationScope).toBe('affected_objects');
      expect(details.checks).toEqual([result.checks[1]]);
      expect((details.counts as { checks: number }).checks).toBe(2);
      expect(details.errors).toEqual(result.errors);
    }
  );

  it('verification summary omits bodies and history', async () => {
    vi.mocked(readContentFileOrStdin).mockResolvedValue(
      JSON.stringify({
        schemaVersion: 1,
        inspect,
        expectations: [{ kind: 'parent', remId: 'r', value: 'p' }],
      })
    );
    const result = {
      ...receipt,
      status: 'passed',
      objects: [
        {
          remId: 'r',
          textHash: 'hash',
          text: ['body'],
          cards: [{ cardId: 'c', repetitionHistory: [{ private: 'history' }] }],
        },
      ],
      scopes: [{ rootRemId: 'r', remIds: ['r'], complete: true }],
    };
    vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue(result);

    const output = await runCliForTest(['verify', 'scope', '--expect', '-', '--summary']);
    const data = parseSuccess(output.stdout) as {
      objects: unknown[];
      scopes: unknown[];
      counts: { objects: number };
    };

    expect(output.exitCode).toBe(0);
    expect(data.objects).toEqual([{ remId: 'r', textHash: 'hash', cardIds: ['c'] }]);
    expect(data.scopes).toEqual(result.scopes);
    expect(data.counts.objects).toBe(1);
  });

  it.each(['-', '/tmp/request.json'])('reads context from %s', async (path) => {
    vi.mocked(readContentFileOrStdin).mockResolvedValue(JSON.stringify(inspect));
    const execute = vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue(receipt);

    const output = await runCliForTest(['context', '--request', path]);

    expect(readContentFileOrStdin).toHaveBeenCalledWith(path);
    expect(execute).toHaveBeenCalledExactlyOnceWith('inspect_many', {
      ...inspect,
      maxRems: 1000,
      ancestorDepth: 20,
    });
    expect(parseSuccess(output.stdout)).toEqual(receipt);
  });

  it.each(['passed', 'failed', 'incomplete'])(
    'emits verify %s with the contract exit code',
    async (status) => {
      vi.mocked(readContentFileOrStdin).mockResolvedValue(
        JSON.stringify({
          schemaVersion: 1,
          inspect,
          expectations: [{ kind: 'parent', remId: 'r', value: 'p' }],
        })
      );
      vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({ ...receipt, status });

      const output = await runCliForTest(['verify', 'scope', '--expect', '-']);

      if (status === 'passed') {
        expect(output.exitCode).toBe(0);
        expect(parseSuccess(output.stdout)).toEqual({ ...receipt, status });
      } else {
        expect(output.exitCode).toBe(EXIT.NOT_FOUND_OR_CONFLICT);
        expect(parseFailure(output.stderr).details).toEqual({ ...receipt, status });
      }
    }
  );

  it.each([{ complete: false }, { errors: [{ code: 'failed', message: 'Read failed' }] }])(
    'context fails closed %#',
    async (value) => {
      vi.mocked(readContentFileOrStdin).mockResolvedValue(JSON.stringify(inspect));
      vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({ ...receipt, ...value });

      const output = await runCliForTest(['context', '--request', '-']);

      expect(output.exitCode).toBe(EXIT.NOT_FOUND_OR_CONFLICT);
      expect(parseFailure(output.stderr).subtype).toBe('receipt_incomplete');
    }
  );

  it.each(['{bad', '[]', '{"schemaVersion":1,"today":true}'])(
    'rejects invalid input before dispatch %#',
    async (input) => {
      vi.mocked(readContentFileOrStdin).mockResolvedValue(input);
      const execute = vi.spyOn(DirectClient.prototype, 'execute');

      const output = await runCliForTest(['context', '--request', '-']);

      expect(execute).not.toHaveBeenCalled();
      expect(output.exitCode).toBe(EXIT.USAGE);
    }
  );

  it.each(['flashcards', 'wiki'] as const)(
    'wraps %s inner plan and defaults preview',
    async (kind) => {
      vi.mocked(readContentFileOrStdin).mockResolvedValue(JSON.stringify(plans[kind]));
      const execute = vi
        .spyOn(DirectClient.prototype, 'execute')
        .mockResolvedValue({ ...taskReceipt, kind });

      const output = await runCliForTest([
        kind,
        'apply',
        '--plan',
        '-',
        '--idempotency-key',
        'batch',
      ]);

      expect(execute).toHaveBeenCalledExactlyOnceWith(kind + '_apply', {
        schemaVersion: 1,
        plan: plans[kind],
        idempotencyKey: 'batch',
        dryRun: true,
      });
      expect(parseSuccess(output.stdout)).toEqual({ ...taskReceipt, kind });
    }
  );

  it.each(['preview', 'verified', 'partial', 'unknown', 'incomplete', 'conflict'])(
    'applied receipt %s only succeeds for verified',
    async (status) => {
      vi.mocked(readContentFileOrStdin).mockResolvedValue(JSON.stringify(plans.flashcards));
      const execute = vi
        .spyOn(DirectClient.prototype, 'execute')
        .mockResolvedValue({ ...taskReceipt, status });

      const output = await runCliForTest([
        'flashcards',
        'apply',
        '--plan',
        '-',
        '--idempotency-key',
        'batch',
        '--apply',
      ]);

      expect(execute).toHaveBeenCalledWith('flashcards_apply', {
        schemaVersion: 1,
        plan: plans.flashcards,
        idempotencyKey: 'batch',
        dryRun: false,
      });
      if (status === 'verified') {
        expect(output.exitCode).toBe(0);
        expect(parseSuccess(output.stdout)).toEqual({ ...taskReceipt, status });
      } else {
        expect(output.exitCode).toBe(EXIT.NOT_FOUND_OR_CONFLICT);
        expect(parseFailure(output.stderr).details).toEqual({ ...taskReceipt, status });
      }
    }
  );

  it('never retries a failed apply', async () => {
    vi.mocked(readContentFileOrStdin).mockResolvedValue(JSON.stringify(plans.wiki));
    const execute = vi
      .spyOn(DirectClient.prototype, 'execute')
      .mockRejectedValue(new Error('Outcome unknown'));

    const output = await runCliForTest([
      'wiki',
      'apply',
      '--plan',
      '-',
      '--idempotency-key',
      'batch',
      '--apply',
    ]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(output.exitCode).toBe(EXIT.UNKNOWN_OUTCOME);
    expect(parseFailure(output.stderr).type).toBe('unknown_outcome');
  });

  it('leaf helps expose examples, checks, schemas and safety boundaries', () => {
    const program = createProgram('test');
    const output: string[] = [];
    for (const name of ['context', 'verify', 'flashcards', 'wiki']) {
      const command = program.commands.find((candidate) => candidate.name() === name)!;
      const leaf = command.commands[0] ?? command;
      leaf.configureOutput({ writeOut: (text) => output.push(text) });
      leaf.outputHelp();
    }
    const text = output.join('');
    for (const phrase of [
      '"schemaVersion":1',
      'parent',
      'ancestor',
      'remType',
      'tag',
      'powerup',
      'references',
      'children',
      'cardRemIds',
      'zeroCards',
      'dailyRemId',
      'Patch/reuse-only',
      'answerPatches',
      'expectedTextHash',
      'pageKey',
      'facts',
      'ids',
      'calendar freshness',
      'after midnight',
      'original recorded diary',
      'full bounded tree',
      'indexParentRemId',
      'never moves existing entries',
      'Foreign or conflicting parents fail before writes',
      'active knowledge base',
      'never narrow away required',
    ])
      expect(text).toContain(phrase);
  });
});
