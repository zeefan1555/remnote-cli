import { describe, it, expect, vi } from 'vitest';
import { createProgram } from '../../../src/remnote-cli/cli.js';
import { DirectClient } from '../../../src/remnote-cli/client/direct-client.js';
import { readContentFileOrStdin } from '../../../src/remnote-cli/commands/content-input.js';
import { EXIT } from '../../../src/remnote-cli/output/errors.js';
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
describe('inspection composite commands', () => {
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

    const output = await runCliForTest(['rem', 'verify', 'scope', '--expect', '-', '--summary']);
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

    const output = await runCliForTest(['rem', 'context', '--request', path]);

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

      const output = await runCliForTest(['rem', 'verify', 'scope', '--expect', '-']);

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

      const output = await runCliForTest(['rem', 'context', '--request', '-']);

      expect(output.exitCode).toBe(EXIT.NOT_FOUND_OR_CONFLICT);
      expect(parseFailure(output.stderr).subtype).toBe('receipt_incomplete');
    }
  );

  it.each(['{bad', '[]', '{"schemaVersion":1,"today":true}'])(
    'rejects invalid input before dispatch %#',
    async (input) => {
      vi.mocked(readContentFileOrStdin).mockResolvedValue(input);
      const execute = vi.spyOn(DirectClient.prototype, 'execute');

      const output = await runCliForTest(['rem', 'context', '--request', '-']);

      expect(execute).not.toHaveBeenCalled();
      expect(output.exitCode).toBe(EXIT.USAGE);
    }
  );

  it('leaf helps expose examples, checks, schemas and safety boundaries', () => {
    const program = createProgram('test');
    const output: string[] = [];
    for (const path of [
      ['rem', 'create'],
      ['rem', 'context'],
      ['rem', 'verify', 'scope'],
    ]) {
      let leaf = program;
      for (const name of path) leaf = leaf.commands.find((candidate) => candidate.name() === name)!;
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
      'never narrow away required',
    ])
      expect(text).toContain(phrase);
  });
});
