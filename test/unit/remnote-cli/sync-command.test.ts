import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../../src/remnote-cli/cli.js';
import { DirectClient } from '../../../src/remnote-cli/client/direct-client.js';
import * as commandClient from '../../../src/remnote-cli/client/command-client.js';
import type { Command } from 'commander';
import * as sync from '../../../src/business/workspace/workspace.js';
import * as contentInput from '../../../src/remnote-cli/commands/content-input.js';
import * as format from '../../../src/business/workspace/format.js';
import * as relocate from '../../../src/business/workspace/relocate.js';
import * as baseline from '../../../src/business/workspace/baseline.js';
vi.mock('../../../src/business/workspace/baseline.js', () => ({
  alignWorkspaceBaseline: vi.fn(async () => ({ ok: true, remoteWrites: 0 })),
}));
vi.mock('../../../src/business/workspace/relocate.js', () => ({
  relocateWorkspace: vi.fn(async () => ({ ok: true, nativeWrites: 0 })),
}));
vi.mock('../../../src/business/workspace/format.js', () => ({
  formatWorkspace: vi.fn(async () => ({ complete: true, remoteWrites: 0 })),
}));

vi.mock('../../../src/business/workspace/workspace.js', () => ({
  importWorkspace: vi.fn(async () => ({ complete: true })),
  lintWorkspace: vi.fn(async () => ({ ok: true })),
  statusWorkspace: vi.fn(async () => ({ complete: true })),
  diffWorkspace: vi.fn(async () => ({ changes: [] })),
  pushWorkspace: vi.fn(async () => ({ status: 'unchanged' })),
  recoverWorkspace: vi.fn(async () => ({ complete: true, remoteWrites: 0 })),
  resumeWorkspace: vi.fn(async () => ({ complete: true, resumed: true })),
  readWorkspace: vi.fn(async () => ({
    content: 'source',
    fileHash: 'a'.repeat(64),
    remoteWrites: 0,
  })),
  saveWorkspace: vi.fn(async () => ({ status: 'saved', remoteWrites: 0 })),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function testProgram() {
  const program = createProgram('test');
  let output = '';
  function configure(command: Command) {
    command.exitOverride().configureOutput({
      writeOut: (value) => {
        output += value;
      },
      writeErr: (value) => {
        output += value;
      },
    });
    for (const child of command.commands) configure(child);
  }
  configure(program);
  return { program, output: () => output };
}

describe('sync command interface', () => {
  it('routes exact new-child baseline acceptance without invoking the publisher', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await testProgram().program.parseAsync([
      'node',
      'remnote-cli',
      'sync',
      'baseline-align',
      '/private/tmp/vault',
      '--path',
      'Day.md',
      '--accept-new-parent',
      'parent',
      '--accept-new-child',
      'one',
      '--accept-new-child',
      'two',
      '--apply',
      '--plan-hash',
      'a'.repeat(64),
    ]);
    expect(baseline.alignWorkspaceBaseline).toHaveBeenCalledExactlyOnceWith(
      '/private/tmp/vault',
      expect.any(Function),
      {
        paths: ['Day.md'],
        acceptNewParent: 'parent',
        acceptNewChild: ['one', 'two'],
        apply: true,
        planHash: 'a'.repeat(64),
      }
    );
    expect(sync.pushWorkspace).not.toHaveBeenCalled();
  });
  it('routes explicit baseline alignment preview with exact selected paths', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await testProgram().program.parseAsync([
      'node',
      'remnote-cli',
      'sync',
      'baseline-align',
      '/private/tmp/vault',
      '--path',
      'Day.md',
    ]);
    expect(baseline.alignWorkspaceBaseline).toHaveBeenCalledExactlyOnceWith(
      '/private/tmp/vault',
      expect.any(Function),
      { paths: ['Day.md'] }
    );
    expect(sync.pushWorkspace).not.toHaveBeenCalled();
  });
  it('requires an explicit exact hash before baseline alignment applies', async () => {
    await expect(
      testProgram().program.parseAsync([
        'node',
        'remnote-cli',
        'sync',
        'baseline-align',
        '/private/tmp/vault',
        '--apply',
      ])
    ).rejects.toThrow('requires --plan-hash');
    expect(baseline.alignWorkspaceBaseline).not.toHaveBeenCalled();
  });
  it('routes explicit relocation offline with both exact paths', async () => {
    const backend = vi.spyOn(DirectClient.prototype, 'workspaceBackend');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await testProgram().program.parseAsync([
      'node',
      'remnote-cli',
      'sync',
      'relocate',
      '/private/tmp/old',
      '/private/tmp/new',
    ]);
    expect(relocate.relocateWorkspace).toHaveBeenCalledExactlyOnceWith(
      '/private/tmp/old',
      '/private/tmp/new'
    );
    expect(backend).not.toHaveBeenCalled();
  });
  it('routes explicit resume with the original plan hash and no new selectors', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const close = vi.spyOn(DirectClient.prototype, 'close');
    await testProgram().program.parseAsync([
      'node',
      'remnote-cli',
      'sync',
      'resume',
      '/private/tmp/sync',
      '--plan-hash',
      'a'.repeat(64),
    ]);
    expect(sync.resumeWorkspace).toHaveBeenCalledExactlyOnceWith(
      '/private/tmp/sync',
      expect.any(Function),
      'a'.repeat(64)
    );
    expect(sync.pushWorkspace).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('routes explicit offline format without opening a native connection', async () => {
    const backend = vi.spyOn(DirectClient.prototype, 'workspaceBackend');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram('test').parseAsync([
      'node',
      'remnote-cli',
      'sync',
      'format',
      '/private/tmp/sync',
    ]);
    expect(format.formatWorkspace).toHaveBeenCalledWith('/private/tmp/sync');
    expect(backend).not.toHaveBeenCalled();
  });
  it('routes guarded local read/save without opening a native connection', async () => {
    const backend = vi.spyOn(DirectClient.prototype, 'workspaceBackend');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(contentInput, 'readContentFileOrStdin').mockResolvedValue('edited source');
    await createProgram('test').parseAsync([
      'node',
      'remnote-cli',
      'sync',
      'read',
      '/private/tmp/sync',
      'Note.md',
    ]);
    expect(sync.readWorkspace).toHaveBeenCalledWith('/private/tmp/sync', 'Note.md');
    await createProgram('test').parseAsync([
      'node',
      'remnote-cli',
      'sync',
      'save',
      '/private/tmp/sync',
      'Note.md',
      '--content-file',
      'edited.md',
      '--expected-file-hash',
      'a'.repeat(64),
    ]);
    expect(sync.saveWorkspace).toHaveBeenCalledWith(
      '/private/tmp/sync',
      'Note.md',
      'edited source',
      'a'.repeat(64)
    );
    expect(contentInput.readContentFileOrStdin).toHaveBeenCalledWith(
      'edited.md',
      process.stdin,
      4 * 1024 * 1024
    );
    expect(backend).not.toHaveBeenCalled();
  });
  it('exposes only sync, with no abandoned workspace alias', () => {
    const names = createProgram('test').commands.map((command) => command.name());
    expect(names).toContain('sync');
    expect(names).not.toContain('workspace');
  });
  it.each(['lint', 'status', 'diff'] as const)(
    'routes offline %s without opening a connection',
    async (name) => {
      const backend = vi.spyOn(DirectClient.prototype, 'workspaceBackend');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      await createProgram('test').parseAsync([
        'node',
        'remnote-cli',
        'sync',
        name,
        '/private/tmp/sync',
      ]);
      expect(backend).not.toHaveBeenCalled();
      expect(sync[`${name}Workspace`]).toHaveBeenCalled();
    }
  );
  it('passes official import, optional snapshots and exact editable root lazily', async () => {
    const backend = vi.spyOn(DirectClient.prototype, 'workspaceBackend');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await createProgram('test').parseAsync([
      'node',
      'remnote-cli',
      '--kb-id',
      'kb',
      'sync',
      'import',
      '/private/tmp/sync',
      '--export',
      'backup.rem',
      '--snapshot',
      'snapshot.json',
      '--editable-root-id',
      'root',
    ]);
    expect(sync.importWorkspace).toHaveBeenCalledWith(
      '/private/tmp/sync',
      'kb',
      expect.any(Function),
      { export: 'backup.rem', snapshot: 'snapshot.json', editableRootId: 'root' }
    );
    expect(backend).not.toHaveBeenCalled();
  });
  it.each([
    ['plan', [], { apply: false, scope: 'changed', paths: [] }],
    ['apply', [], { apply: true, scope: 'changed', paths: [] }],
    [
      'plan',
      ['--scope', 'all', '--path', 'Note.md', '--path', 'Folder'],
      { apply: false, scope: 'all', paths: ['Note.md', 'Folder'] },
    ],
    [
      'apply',
      ['--scope', 'all', '--path', 'Folder', '--plan-hash', 'a'.repeat(64)],
      { apply: true, scope: 'all', paths: ['Folder'], planHash: 'a'.repeat(64) },
    ],
    [
      'apply',
      ['--path', 'Folder', '--path', './Folder'],
      { apply: true, scope: 'changed', paths: ['Folder', './Folder'] },
    ],
  ] as const)('routes %s with selectors %j exactly once', async (name, options, expected) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const backend = vi.spyOn(DirectClient.prototype, 'workspaceBackend');
    const close = vi.spyOn(DirectClient.prototype, 'close');
    await testProgram().program.parseAsync([
      'node',
      'remnote-cli',
      'sync',
      name,
      '/private/tmp/sync',
      ...options,
    ]);
    expect(sync.pushWorkspace).toHaveBeenCalledTimes(1);
    expect(sync.pushWorkspace).toHaveBeenCalledWith(
      '/private/tmp/sync',
      expect.any(Function),
      expected
    );
    expect(backend).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('routes repeated diff paths offline without a scope selector', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const backend = vi.spyOn(DirectClient.prototype, 'workspaceBackend');
    await testProgram().program.parseAsync([
      'node',
      'remnote-cli',
      'sync',
      'diff',
      '/private/tmp/sync',
      '--path',
      'Note.md',
      '--path',
      'Folder',
    ]);
    expect(sync.diffWorkspace).toHaveBeenCalledExactlyOnceWith('/private/tmp/sync', {
      paths: ['Note.md', 'Folder'],
    });
    expect(sync.pushWorkspace).not.toHaveBeenCalled();
    expect(backend).not.toHaveBeenCalled();
  });

  it('registers sync as a pure group and retains the bounded subcommands', () => {
    const command = createProgram('test').commands.find((item) => item.name() === 'sync')!;
    expect(command.registeredArguments).toEqual([]);
    expect(command.options).toEqual([]);
    expect(command.commands.map((item) => item.name())).toEqual([
      'feedback',
      'plan',
      'apply',
      'baseline-align',
      'resume',
      'relocate',
      'read',
      'save',
      'import',
      'status',
      'lint',
      'diff',
      'recover',
      'format',
    ]);
  });

  it.each([[], ['plan'], ['apply'], ['delete']] as const)(
    'shows help for sync %j without invoking business',
    async (...subcommand) => {
      const { program, output } = testProgram();
      const client = vi.spyOn(commandClient, 'createCommandClient');
      await expect(
        program.parseAsync(['node', 'remnote-cli', 'sync', ...subcommand, '--help'])
      ).rejects.toMatchObject({ code: 'commander.helpDisplayed', exitCode: 0 });
      expect(output()).toContain('Usage: remnote-cli sync');
      expect(client).not.toHaveBeenCalled();
      expect(sync.pushWorkspace).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['/private/tmp/sync'],
    ['/private/tmp/sync', '--apply'],
    ['--apply'],
    ['--delete-id', 'card', '--scope-root', 'root'],
    ['pull', '/private/tmp/sync'],
    ['push', '/private/tmp/sync'],
    ['plan'],
    ['apply'],
    ['resume'],
    ['resume', '/private/tmp/sync'],
    ['resume', '/private/tmp/sync', '--plan-hash', 'a'.repeat(64), '--path', 'Note.md'],
    ['resume', '/private/tmp/sync', '--plan-hash', 'a'.repeat(64), '--scope', 'all'],
    ['resume', '/private/tmp/sync', '--plan-hash', 'a'.repeat(64), '--apply'],
    ['plan', '/private/tmp/sync', '--apply'],
    ['plan', '/private/tmp/sync', '--plan-hash', 'a'.repeat(64)],
    ['apply', '/private/tmp/sync', '--apply'],
    ['apply', '/private/tmp/sync', '--file', 'Note.md'],
    ['apply', '/private/tmp/sync', '--full'],
    ['plan', '/private/tmp/sync', '--scope', 'latest'],
    ['apply', '/private/tmp/sync', '--scope', 'latest'],
    ['apply', '/private/tmp/sync', '--scope'],
    ['apply', '/private/tmp/sync', '--path'],
    ['diff', '/private/tmp/sync', '--scope', 'all'],
    ['status', '/private/tmp/sync', '--path', 'Folder'],
    ['lint', '/private/tmp/sync', '--path', 'Folder'],
    ['delete', '/private/tmp/sync', '--id', 'card'],
    ['delete', '/private/tmp/sync', '--scope-root', 'root'],
    ['delete', '/private/tmp/sync', '--id', 'card', '--scope-root', 'root', '--apply'],
    ['delete', '/private/tmp/sync', '--id', 'card', '--scope-root', 'root', '--scope', 'all'],
    ['delete', '/private/tmp/sync', '--id', 'card', '--scope-root', 'root', '--path', 'Folder'],
    ['delete', '/private/tmp/sync', '--delete-id', 'card', '--scope-root', 'root'],
  ])(
    'rejects invalid/retired argv %j before creating a client or calling business',
    async (...argv) => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const client = vi.spyOn(commandClient, 'createCommandClient');
      const backend = vi.spyOn(DirectClient.prototype, 'workspaceBackend');
      await expect(
        testProgram()
          .program.parseAsync(['node', 'remnote-cli', 'sync', ...argv])
          .then(() => undefined)
      ).rejects.toMatchObject({ exitCode: 1 });
      expect(client).not.toHaveBeenCalled();
      expect(backend).not.toHaveBeenCalled();
      for (const operation of Object.values(sync)) expect(operation).not.toHaveBeenCalled();
      expect(format.formatWorkspace).not.toHaveBeenCalled();
    }
  );
});
