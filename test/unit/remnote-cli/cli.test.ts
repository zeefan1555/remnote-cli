import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { createProgram } from '../../../src/remnote-cli/cli.js';
import { EXIT } from '../../../src/remnote-cli/output/errors.js';
import { runCliForTest } from '../../helpers/run-cli.js';

describe('createProgram', () => {
  it('creates a configured Command instance', () => {
    const program = createProgram('0.1.0');

    expect(program).toBeInstanceOf(Command);
    expect(program.name()).toBe('remnote-cli');
    expect(program.description()).toContain('Direct RemNote SDK');
  });

  it('registers all expected subcommands', () => {
    const program = createProgram('0.1.0');
    const commandNames = program.commands.map((c) => c.name());

    expect(commandNames).not.toContain('daemon');
    expect(commandNames).not.toContain('pair');
    expect(commandNames).toEqual(
      expect.arrayContaining([
        'rem',
        'card',
        'table',
        'todo',
        'media',
        'journal',
        'batch',
        'status',
        'doctor',
        'schema',
        'contract',
        'sdk',
      ])
    );
    expect(
      commandNames.filter((name) =>
        ['create', 'read', 'update', 'search', 'read-table', 'get-media'].includes(name)
      )
    ).toEqual([]);
    expect(commandNames).toContain('todo');
    expect(commandNames).not.toContain('wiki');
    expect(commandNames).not.toContain('sync');
    expect(commandNames).toContain('sdk');
    expect(commandNames).not.toContain('sdk-capabilities');
    expect(commandNames).not.toContain('sdk-app');
    expect(commandNames.filter((name) => name.startsWith('sdk-'))).toHaveLength(0);
    const sdk = program.commands.find((command) => command.name() === 'sdk');
    const sdkCommandNames = sdk?.commands.map((command) => command.name());
    expect(sdkCommandNames).toContain('capabilities');
    expect(sdkCommandNames).toContain('call');
    expect(sdkCommandNames).toContain('app');
    expect(sdkCommandNames).toContain('rem');
    expect(sdkCommandNames).toContain('rich-text');
    expect(sdkCommandNames).toContain('window');
    expect(sdkCommandNames).toHaveLength(21);
    expect(commandNames).toContain('status');
    expect(commandNames).toContain('contract');
  });

  it('has global --text and --json options', () => {
    const program = createProgram('0.1.0');
    const optionNames = program.options.map((o) => o.long);

    expect(optionNames).toContain('--json');
    expect(optionNames).toContain('--text');
    expect(optionNames).not.toContain('--port');
    expect(optionNames).not.toContain('--kb-id');
    expect(optionNames).not.toContain('--allow-destructive');
    expect(optionNames).not.toContain('--mcp-url');
    expect(optionNames).not.toContain('--control-port');
    expect(optionNames).toContain('--verbose');
  });

  it('does not register daemon lifecycle commands', () => {
    const program = createProgram('0.1.0');
    const daemonCmd = program.commands.find((c) => c.name() === 'daemon');
    expect(daemonCmd).toBeUndefined();
  });

  it('rejects the removed search-by-tag transport timeout flag', async () => {
    const program = createProgram('test');
    program.commands
      .find((command) => command.name() === 'rem')!
      .commands.find((command) => command.name() === 'search-by-tag')!
      .exitOverride()
      .configureOutput({ writeErr: () => {} });
    await expect(
      program.parseAsync([
        'node',
        'remnote-cli',
        'rem',
        'search-by-tag',
        '--tag-id',
        'tag',
        '--timeout-ms',
        '30000',
      ])
    ).rejects.toMatchObject({ code: 'commander.unknownOption' });
  });

  it('returns one structured usage error without leaking Commander stderr', async () => {
    const result = await runCliForTest(['rem', 'read', '--depth']);

    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      schemaVersion: 2,
      ok: false,
      error: {
        type: 'usage',
        subtype: 'commander.optionMissingArgument',
      },
    });
  });
});
