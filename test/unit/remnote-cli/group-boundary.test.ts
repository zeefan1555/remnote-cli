import { describe, expect, it } from 'vitest';
import { EXIT } from '../../../src/remnote-cli/output/errors.js';
import { parseFailure, runCliForTest } from '../../helpers/run-cli.js';

describe('command group boundaries', () => {
  it.each([[], ['--text']])('shows root help for command-less invocation %j', async (...args) => {
    const result = await runCliForTest(args);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: remnote-cli');
  });

  it('accepts combined short flags without rejecting them as a group flag', async () => {
    const result = await runCliForTest(['-Vh']);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('0.1.0-test');
  });

  it.each([
    [['rem']],
    [['card']],
    [['wiki']],
    [['table']],
    [['todo']],
    [['media']],
    [['journal']],
    [['sync']],
    [['sdk']],
    [['rem', 'powerup']],
    [['rem', 'outline']],
    [['rem', 'verify']],
  ])('shows help for bare group %j', async (group) => {
    const result = await runCliForTest(group);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(`Usage: remnote-cli ${group.join(' ')}`);
  });

  it('treats global output flags on a bare group as a successful help request', async () => {
    const result = await runCliForTest(['sync', '--text']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: remnote-cli sync');
  });

  it.each([
    { name: 'root help', args: ['help'] },
    { name: 'targeted root help', args: ['help', 'todo'] },
    { name: 'group help', args: ['card', 'help'] },
    { name: 'global flag before group help', args: ['--text', 'card', 'help'] },
    { name: 'global flag after group help', args: ['card', '--text', 'help'] },
  ])('delegates $name to Commander', async ({ args }) => {
    const result = await runCliForTest(args);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: remnote-cli');
  });

  it('returns ranked machine-readable suggestions for a typo', async () => {
    const result = await runCliForTest(['todo', 'lis']);
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(parseFailure(result.stderr)).toMatchObject({
      type: 'usage',
      subtype: 'unknown_subcommand',
      details: {
        commandPath: 'todo',
        suggestions: expect.arrayContaining(['list']),
        usage: 'todo',
      },
    });
  });

  it.each([
    [['create'], 'rem create'],
    [['flashcards', 'apply'], 'card apply'],
    [['read-table', '--rem-id', 'table'], 'table read'],
  ])('rejects legacy path %j with replacement %s', async (args, replacement) => {
    const result = await runCliForTest(args);
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(parseFailure(result.stderr)).toMatchObject({
      subtype: 'unknown_subcommand',
      details: { suggestions: expect.arrayContaining([replacement]) },
    });
  });

  it('reports a leaf-only flag without a subcommand', async () => {
    const result = await runCliForTest(['sync', '--plan-hash', 'hash']);
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(parseFailure(result.stderr)).toMatchObject({
      subtype: 'missing_subcommand',
      details: { commandPath: 'sync' },
    });
  });

  it('names the action that owns a legacy leaf flag', async () => {
    const result = await runCliForTest(['journal', '--content', 'Legacy entry']);
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(parseFailure(result.stderr)).toMatchObject({
      subtype: 'missing_subcommand',
      details: {
        commandPath: 'journal',
        suggestions: ['journal append'],
      },
    });
  });

  it('reports an unknown group flag', async () => {
    const result = await runCliForTest(['sync', '--unknown']);
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(parseFailure(result.stderr)).toMatchObject({
      subtype: 'unknown_group_flag',
      details: { commandPath: 'sync' },
    });
  });

  it('groups root help by purpose', async () => {
    const result = await runCliForTest(['--help']);
    const knowledge = result.stdout.indexOf('Knowledge commands:');
    const workflows = result.stdout.indexOf('Workflow commands:');
    const diagnostics = result.stdout.indexOf('Diagnostics and tooling:');
    const raw = result.stdout.indexOf('Raw SDK commands:');
    expect(knowledge).toBeGreaterThan(-1);
    expect(workflows).toBeGreaterThan(knowledge);
    expect(diagnostics).toBeGreaterThan(workflows);
    expect(raw).toBeGreaterThan(diagnostics);
  });
});
