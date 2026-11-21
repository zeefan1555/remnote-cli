import { describe, expect, it, vi } from 'vitest';
import {
  dispatchRemoteAction,
  REMOTE_ACTION_DEFINITIONS,
  REMOTE_ACTION_NAMES,
} from '../../../src/remnote-cli/client/remote-actions.js';

describe('fixed Bridge action registry', () => {
  it('registers exactly status, capabilities and SDK calls', () => {
    expect(Object.values(REMOTE_ACTION_NAMES).sort()).toEqual([
      'get_sdk_capabilities',
      'get_status',
      'sdk_call',
    ]);
    expect(
      Object.fromEntries(
        Object.entries(REMOTE_ACTION_DEFINITIONS).map(([name, definition]) => [
          name,
          definition.effect,
        ])
      )
    ).toEqual({
      get_status: 'read',
      get_sdk_capabilities: 'capability',
      sdk_call: 'sdk',
    });
  });

  it('binds each action to its typed handler', async () => {
    const sendFrame = vi.fn(async (_action, payload) => payload);
    const transport = { sendFrame };
    await expect(dispatchRemoteAction(transport, 'get_status', {}, 1000)).resolves.toEqual({});
    await expect(
      dispatchRemoteAction(transport, 'get_sdk_capabilities', {}, 1000)
    ).resolves.toEqual({});
    await expect(
      dispatchRemoteAction(transport, 'sdk_call', { capability: 'namespace:app.getPlatform' }, 1000)
    ).resolves.toEqual({
      capability: 'namespace:app.getPlatform',
      args: [],
      allowDestructive: false,
    });
    expect(sendFrame.mock.calls.map(([action]) => action)).toEqual([
      'get_status',
      'get_sdk_capabilities',
      'sdk_call',
    ]);
  });

  it('rejects unknown actions and invalid payloads without calling transport', async () => {
    const sendFrame = vi.fn();
    await expect(dispatchRemoteAction({ sendFrame }, 'create_note', {}, 1000)).rejects.toThrow(
      'Unknown Bridge action'
    );
    await expect(
      dispatchRemoteAction({ sendFrame }, 'sdk_call', { capability: '' }, 1000)
    ).rejects.toThrow();
    expect(sendFrame).not.toHaveBeenCalled();
  });
});
