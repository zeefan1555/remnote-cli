import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../../src/remnote-cli/cli.js';
import { DirectClient } from '../../../src/remnote-cli/client/direct-client.js';
import * as sync from '../../../src/business/workspace/workspace.js';
import * as contentInput from '../../../src/remnote-cli/commands/content-input.js';

vi.mock('../../../src/business/workspace/workspace.js', () => ({
  importWorkspace: vi.fn(async () => ({ complete: true })),
  lintWorkspace: vi.fn(async () => ({ ok: true })),
  statusWorkspace: vi.fn(async () => ({ complete: true })),
  diffWorkspace: vi.fn(async () => ({ changes: [] })),
  pushWorkspace: vi.fn(async () => ({ status: 'unchanged' })),
  recoverWorkspace: vi.fn(async () => ({ complete: true, remoteWrites: 0 })),
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
describe('sync command interface', () => {
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
  it('defaults sync DIR to three-way preview and requires explicit apply options', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const backend = vi.spyOn(DirectClient.prototype, 'workspaceBackend');
    for (const [options, expected] of [
      [[], {}],
      [['--apply'], { apply: true }],
      [['--apply', '--plan-hash', 'a'.repeat(64)], { apply: true, planHash: 'a'.repeat(64) }],
    ] as const) {
      await createProgram('test').parseAsync([
        'node',
        'remnote-cli',
        'sync',
        '/private/tmp/sync',
        ...options,
      ]);
      expect(sync.pushWorkspace).toHaveBeenLastCalledWith(
        '/private/tmp/sync',
        expect.any(Function),
        expected
      );
    }
    expect(backend).not.toHaveBeenCalled();
    const command = createProgram('test').commands.find((item) => item.name() === 'sync')!;
    expect(command.commands.map((item) => item.name())).toEqual([
      'read',
      'save',
      'import',
      'status',
      'lint',
      'diff',
      'recover',
    ]);
  });
});
