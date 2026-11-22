import { describe, expect, it, vi } from 'vitest';
import { RemAdapter } from '../../../src/business/rem-adapter.js';
import { DirectClient } from '../../../src/remnote-cli/client/direct-client.js';
import { EXIT } from '../../../src/remnote-cli/output/errors.js';
import { MockCard, MockRemNotePlugin } from '../../helpers/business-mocks.js';
import { parseFailure, parseSuccess, runCliForTest } from '../../helpers/run-cli.js';

describe('native Rem card commands', () => {
  it.each([
    ['card'],
    ['card', 'apply', '--plan', '-', '--idempotency-key', 'old-plan'],
    ['card', 'review-stats', 'r'],
    ['flashcards', 'apply'],
    ['apply'],
    ['task', 'apply'],
  ])('rejects the removed public command %j before connecting', async (...args) => {
    const execute = vi.spyOn(DirectClient.prototype, 'execute');
    const result = await runCliForTest(args);
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(result.stdout).toBe('');
    expect(parseFailure(result.stderr)).toMatchObject({
      type: 'usage',
      subtype: 'unknown_subcommand',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['card', 'card.apply', 'card.review-stats', 'flashcards', 'task.apply'])(
    'does not discover a removed command schema %s',
    async (path) => {
      const result = await runCliForTest(['schema', path]);
      expect(result.exitCode).toBe(EXIT.USAGE);
      expect(parseFailure(result.stderr)).toMatchObject({ subtype: 'unknown_command_schema' });
    }
  );

  it('keeps native Rem actions and low-level SDK card inspection in help', async () => {
    const root = await runCliForTest(['--help']);
    expect(root.stdout).not.toMatch(/^\s+card(?:\s|$)/m);
    expect(root.stdout).not.toMatch(/^\s+(?:apply|task|flashcards)(?:\s|$)/m);
    for (const args of [
      ['rem', 'create', '--help'],
      ['rem', 'update', '--help'],
      ['rem', 'update-answer', '--help'],
      ['rem', 'inspect', '--help'],
      ['sdk', 'card', '--help'],
      ['batch', '--help'],
    ]) {
      const result = await runCliForTest(args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(`Usage: remnote-cli ${args.slice(0, -1).join(' ')}`);
    }
  });

  it('reads native card and review facts through rem inspect --fields cards,rawCards', async () => {
    const plugin = new MockRemNotePlugin();
    const rem = plugin.addTestRem('question', 'Question');
    const history = [{ date: 200, score: 1, responseTime: 10, scheduled: 100 }];
    rem.setCardsMock([
      new MockCard('native-card', 'question', 'forward', 100, history, 300, 0, 200),
    ]);
    const adapter = new RemAdapter(plugin as never);
    vi.spyOn(DirectClient.prototype, 'execute').mockImplementation(async (action, payload) => {
      expect(action).toBe('inspect_state');
      return adapter.inspectState(payload as Parameters<RemAdapter['inspectState']>[0]);
    });

    const result = await runCliForTest([
      'rem',
      'inspect',
      'question',
      '--fields',
      'cards,rawCards',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(parseSuccess(result.stdout)).toMatchObject({
      complete: true,
      errors: [],
      rems: [
        {
          id: 'question',
          cards: [
            { id: 'native-card', type: 'forward', due: 300, nextRepetition: 300, historyLength: 1 },
          ],
          rawCards: [
            {
              id: 'native-card',
              remId: 'question',
              type: 'forward',
              createdAt: 100,
              repetitionHistory: history,
              lastRepetitionTime: 200,
              nextRepetitionTime: 300,
              timesWrongInRow: 0,
            },
          ],
        },
      ],
    });
  });
});
