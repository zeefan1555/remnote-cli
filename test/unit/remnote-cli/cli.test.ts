import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConnectionConfig } from '../../../src/remnote-cli/client/connection-config.js';
import { Command } from 'commander';
import { createProgram } from '../../../src/remnote-cli/cli.js';

describe('createProgram', () => {
  it('pairs with shared KB/port options without printing the secret or overwriting pairing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remnote-pair-command-'));
    const path = join(directory, 'connection.json');
    vi.stubEnv('REMNOTE_CLI_CONFIG', path);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const argv = ['node', 'remnote-cli', 'pair', '--kb-id', 'test-kb', '--port', '3004'];
    try {
      await createProgram('test').parseAsync(argv);
      const config = await readConnectionConfig(path);
      expect(config).toMatchObject({ knowledgeBaseId: 'test-kb', port: 3004 });
      expect(output.mock.calls.join()).not.toContain(config.token);
      await createProgram('test').parseAsync(argv);
      expect(process.exitCode).toBe(1);
      expect(await readConnectionConfig(path)).toEqual(config);
      await createProgram('test').parseAsync(['node', 'remnote-cli', 'pair']);
      expect(error.mock.calls.at(-1)?.[0]).toContain('requires --kb-id');
    } finally {
      process.exitCode = 0;
      output.mockRestore();
      error.mockRestore();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
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
    expect(commandNames).toContain('create');
    expect(commandNames).toContain('search');
    expect(commandNames).toContain('search-by-tag');
    expect(commandNames).not.toContain('search-tag');
    expect(commandNames).toContain('read');
    expect(commandNames).toContain('get-media');
    expect(commandNames).toContain('outline');
    expect(commandNames).toContain('todo');
    expect(commandNames).toContain('sdk');
    expect(commandNames).not.toContain('sdk-capabilities');
    expect(commandNames).not.toContain('sdk-app');
    expect(commandNames.filter((name) => name.startsWith('sdk-'))).toHaveLength(0);
    const sdk = program.commands.find((command) => command.name() === 'sdk');
    const sdkCommandNames = sdk?.commands.map((command) => command.name());
    expect(sdkCommandNames).toContain('capabilities');
    expect(sdkCommandNames).toContain('app');
    expect(sdkCommandNames).toContain('rem');
    expect(sdkCommandNames).toContain('rich-text');
    expect(sdkCommandNames).toContain('window');
    expect(sdkCommandNames).toHaveLength(20);
    expect(commandNames).toContain('update');
    expect(commandNames).toContain('set-document-status');
    expect(commandNames).toContain('journal');
    expect(commandNames).toContain('status');
  });

  it('has global --text and --json options', () => {
    const program = createProgram('0.1.0');
    const optionNames = program.options.map((o) => o.long);

    expect(optionNames).toContain('--json');
    expect(optionNames).toContain('--text');
    expect(optionNames).toContain('--port');
    expect(optionNames).toContain('--kb-id');
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
      .find((command) => command.name() === 'search-by-tag')!
      .exitOverride()
      .configureOutput({ writeErr: () => {} });
    await expect(
      program.parseAsync([
        'node',
        'remnote-cli',
        'search-by-tag',
        '--tag-id',
        'tag',
        '--timeout-ms',
        '30000',
      ])
    ).rejects.toMatchObject({ code: 'commander.unknownOption' });
  });
});
