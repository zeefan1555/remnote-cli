import { describe, expect, it, vi } from 'vitest';
import { RemAdapter } from '../../../src/business/rem-adapter.js';
import { DirectClient } from '../../../src/remnote-cli/client/direct-client.js';
import { EXIT } from '../../../src/remnote-cli/output/errors.js';
import { MockCard, MockRem, MockRemNotePlugin } from '../../helpers/business-mocks.js';
import { parseFailure, parseSuccess, runCliForTest } from '../../helpers/run-cli.js';

describe('native Rem card commands', () => {
  it.each([
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

  it.each(['card.apply', 'card.review-stats', 'flashcards', 'task.apply'])(
    'does not discover a removed command schema %s',
    async (path) => {
      const result = await runCliForTest(['schema', path]);
      expect(result.exitCode).toBe(EXIT.USAGE);
      expect(parseFailure(result.stderr)).toMatchObject({ subtype: 'unknown_command_schema' });
    }
  );

  it('exposes card create and keeps native Rem actions plus low-level SDK card help', async () => {
    const root = await runCliForTest(['--help']);
    expect(root.stdout).toMatch(/^\s+card\s+Create review cards/m);
    expect(root.stdout).not.toMatch(/^\s+(?:apply|task|flashcards)(?:\s|$)/m);
    for (const args of [
      ['card', '--help'],
      ['card', 'create', '--help'],
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

  it('guides agents through official card text without inventing a card type option', async () => {
    const result = await runCliForTest(['card', 'create', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Question >> Answer');
    expect(result.stdout).toContain('Question >>>');
    expect(result.stdout).toMatch(/--content '- Question >>>\n\s+- Why\n\s+- Reason/);
    expect(result.stdout).toContain('ordinary Markdown with real newlines');
    expect(result.stdout).toContain('creates and verifies an empty answer item');
    expect(result.stdout).toContain("RemNote's native parser determines");
    expect(result.stdout).toContain('https://help.remnote.com/en/articles/9252072');
    expect(result.stdout).not.toContain("$'");
    expect(result.stdout).not.toContain('--card-type');
    expect(result.stdout).not.toContain('--content-file');
    expect(result.stdout).not.toContain('card apply');
  });

  it('passes ordinary Markdown to create_card with blank answer sections preserved', async () => {
    const execute = vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({
      remIds: ['question'],
      titles: ['Question'],
    });
    const content =
      'Question >>>\n  - Why\n  - Reason\n\n  - How\n  - Action\n\n  - What\n  - Result\n\n  - 来源\n  - Evidence';
    const result = await runCliForTest([
      'card',
      'create',
      '--content',
      content,
      '--title',
      'Card batch',
      '--parent-id',
      'daily',
      '--tag-ids',
      'home-topic',
      'term-topic',
      '--kb-id',
      'kb',
    ]);
    expect(result.exitCode).toBe(0);
    expect(execute).toHaveBeenCalledWith('create_card', {
      content:
        'Question >>>\n  - Why\n  - Reason\n  -\n  - How\n  - Action\n  -\n  - What\n  - Result\n  -\n  - 来源\n  - Evidence',
      title: 'Card batch',
      parentId: 'daily',
      tagRemIds: ['home-topic', 'term-topic'],
    });
    execute.mockRestore();
  });

  it('collapses boundary blanks, ignores outer blanks, and accepts CRLF', async () => {
    const execute = vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({
      remIds: ['first', 'second'],
      titles: ['First', 'Second'],
    });
    const result = await runCliForTest([
      'card',
      'create',
      '--content',
      '\n\nFirst >>>\r\n\r\n  - Why\r\n  - Reason\r\n\r\n\r\n  - How\r\n  - Action\r\n\r\nSecond >>>\r\n  - Result\r\n\r\n',
    ]);
    expect(result.exitCode).toBe(0);
    expect(execute).toHaveBeenCalledWith('create_card', {
      content: 'First >>>\n  - Why\n  - Reason\n  -\n  - How\n  - Action\nSecond >>>\n  - Result',
    });
    execute.mockRestore();
  });

  it('drops Markdown blank lines between top-level cards', async () => {
    const execute = vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({
      remIds: ['first', 'second'],
      titles: ['First', 'Second'],
    });
    const result = await runCliForTest([
      'card',
      'create',
      '--content',
      'First >>>\n  - A\n\nSecond >>>\n  - B',
    ]);
    expect(result.exitCode).toBe(0);
    expect(execute).toHaveBeenCalledWith('create_card', {
      content: 'First >>>\n  - A\nSecond >>>\n  - B',
    });
    execute.mockRestore();
  });

  it('requires direct card content before opening a bridge session', async () => {
    const execute = vi.spyOn(DirectClient.prototype, 'execute');
    const result = await runCliForTest(['card', 'create']);
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(parseFailure(result.stderr)).toMatchObject({
      subtype: 'commander.missingMandatoryOptionValue',
    });
    expect(execute).not.toHaveBeenCalled();
    execute.mockRestore();
  });

  it('returns non-retryable unknown outcome with created IDs when marking a separator fails', async () => {
    const plugin = new MockRemNotePlugin();
    plugin.enableTaskSemantics();
    plugin.addTestRem('daily', 'Daily');
    const adapter = new RemAdapter(plugin as never);
    const execute = vi
      .spyOn(DirectClient.prototype, 'execute')
      .mockImplementation(async (action, payload) => {
        expect(action).toBe('create_card');
        return await adapter.createCard(payload);
      });
    const setter = vi
      .spyOn(MockRem.prototype, 'setIsCardItem')
      .mockRejectedValueOnce(new Error('setter failed'));
    try {
      const result = await runCliForTest([
        'card',
        'create',
        '--content',
        '- Question >>>\n  - One\n\n  - Two',
        '--parent-id',
        'daily',
      ]);
      expect(result.exitCode).toBe(EXIT.UNKNOWN_OUTCOME);
      expect(result.stdout).toBe('');
      expect(parseFailure(result.stderr)).toMatchObject({
        type: 'unknown_outcome',
        subtype: 'card_create_unverified',
        retryable: false,
        details: {
          recoveryKey: expect.stringMatching(/^additive:/),
          knownRemIds: expect.arrayContaining(['daily']),
        },
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(plugin.rem.createTreeWithMarkdown).toHaveBeenCalledTimes(1);
    } finally {
      setter.mockRestore();
      execute.mockRestore();
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
