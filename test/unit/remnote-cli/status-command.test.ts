import { describe, it, expect, vi } from 'vitest';
import { DirectClient } from '../../../src/remnote-cli/client/direct-client.js';
import { createProgram } from '../../../src/remnote-cli/cli.js';

describe('status command', () => {
  it('uses get_status bridge action', async () => {
    const executeSpy = vi
      .spyOn(DirectClient.prototype, 'execute')
      .mockResolvedValue({ connected: true, pluginVersion: '0.0.0-test' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createProgram('0.1.0-test');

    await program.parseAsync(['node', 'remnote-cli', 'status'], { from: 'node' });

    expect(executeSpy).toHaveBeenCalledWith('get_status', {});
    executeSpy.mockRestore();
    logSpy.mockRestore();
  });
  it('prints the independent plugin identity, protocol, SDK and exact KB', async () => {
    const execute = vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({
      connected: true,
      pluginVersion: '0.24.0',
      pluginId: 'zeefan-remnote-sdk-bridge',
      protocolVersion: 1,
      sdkVersion: '0.0.46',
      knowledgeBaseId: 'kb',
      knowledgeBaseName: 'Test',
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await createProgram('test').parseAsync(['node', 'remnote-cli', '--text', 'status']);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('Plugin ID: zeefan-remnote-sdk-bridge')
      );
      expect(log).toHaveBeenCalledWith(expect.stringContaining('SDK: 0.0.46'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('KB: Test (kb)'));
    } finally {
      execute.mockRestore();
      log.mockRestore();
    }
  });
});
