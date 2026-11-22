import { describe, it, expect, vi } from 'vitest';
import { DirectClient } from '../../../src/remnote-cli/client/direct-client.js';
import { runCliForTest } from '../../helpers/run-cli.js';

describe('status command', () => {
  it('uses get_status bridge action', async () => {
    const executeSpy = vi
      .spyOn(DirectClient.prototype, 'execute')
      .mockResolvedValue({ connected: true, pluginVersion: '0.0.0-test' });
    await runCliForTest(['status']);

    expect(executeSpy).toHaveBeenCalledWith('get_status', {});
    executeSpy.mockRestore();
  });
  it('prints the independent plugin identity, protocol, SDK and exact KB', async () => {
    const execute = vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({
      connected: true,
      pluginVersion: '0.25.0',
      pluginId: 'remnote-cli-bridge',
      protocolVersion: 2,
      sdkVersion: '0.0.46',
      knowledgeBaseId: 'kb',
      knowledgeBaseName: 'Test',
    });
    try {
      const output = await runCliForTest(['--text', 'status']);
      expect(output.stdout).toContain('Plugin ID: remnote-cli-bridge');
      expect(output.stdout).toContain('SDK: 0.0.46');
      expect(output.stdout).toContain('KB: Test (kb)');
    } finally {
      execute.mockRestore();
    }
  });
});
