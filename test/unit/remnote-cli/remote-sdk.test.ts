import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { remoteSdk } from '../../../src/remnote-cli/client/remote-sdk.js';
import {
  verifiedCatalog,
  type Capability,
  type CapabilityResult,
} from '../../../src/remnote-cli/client/sdk-capabilities.js';

function catalog(): CapabilityResult {
  const capabilities: Capability[] = [
    {
      id: 'namespace:rem.findOne',
      namespace: 'rem',
      target: 'namespace',
      method: 'findOne',
      group: 'rem',
      command: 'find-one',
      signatures: [],
      status: 'supported',
      mode: 'read',
    },
    {
      id: 'namespace:richText.rem',
      namespace: 'richText',
      target: 'namespace',
      method: 'rem',
      group: 'richText',
      command: 'rem',
      signatures: [],
      status: 'supported',
      mode: 'read',
      materialize: 'richText',
    },
    {
      id: 'rem:setParent',
      target: 'rem',
      method: 'setParent',
      group: 'rem',
      command: 'set-parent',
      signatures: [],
      status: 'supported',
      mode: 'write',
    },
    {
      id: 'namespace:date.getDailyDoc',
      namespace: 'date',
      target: 'namespace',
      method: 'getDailyDoc',
      group: 'date',
      command: 'get-daily-doc',
      signatures: [],
      status: 'supported',
      mode: 'write',
    },
    {
      id: 'namespace:event.addListener',
      namespace: 'event',
      target: 'namespace',
      method: 'addListener',
      group: 'event',
      command: 'add-listener',
      signatures: [],
      status: 'unsupported',
      mode: 'write',
    },
  ];
  const data = { sdkVersion: '0.0.46', capabilities };
  return {
    ...data,
    sdkCatalogHash: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
  };
}
describe('remote SDK values', () => {
  it('validates the live catalog digest, schema and unique capability identities', () => {
    const source = catalog();
    expect(verifiedCatalog(source)).toEqual(source);
    expect(() => verifiedCatalog({ ...source, sdkCatalogHash: '0'.repeat(64) })).toThrow('hash');
    expect(() =>
      verifiedCatalog({ ...source, capabilities: [...source.capabilities, source.capabilities[0]] })
    ).toThrow();
    expect(() => verifiedCatalog({ ...source, extra: true })).toThrow();
  });

  it('materializes immutable Rem snapshots with explicit refs, dates and undefined values', async () => {
    const request = vi.fn(async (_, payload) => ({
      capability: payload.capability,
      value:
        payload.capability === 'namespace:rem.findOne'
          ? { $type: 'rem', id: payload.args[0], text: ['Title'], parent: 'root' }
          : payload.capability === 'namespace:richText.rem'
            ? [{ i: 'q', _id: 'r' }]
            : payload.capability === 'namespace:date.getDailyDoc'
              ? { $type: 'date', value: '2026-10-02T00:00:00.000Z' }
              : { $type: 'undefined' },
    }));
    const sdk = remoteSdk({ request } as never, catalog(), false);
    const child = (await sdk.rem.findOne('r'))!,
      parent = (await sdk.rem.findOne('p'))!;
    expect(child._id).toBe('r');
    expect(child.text).toEqual(['Title']);
    expect(await child.setParent(parent, undefined)).toBeUndefined();
    expect(request).toHaveBeenLastCalledWith(
      'sdk_call',
      expect.objectContaining({
        capability: 'rem:setParent',
        targetId: 'r',
        args: [{ $ref: 'rem', id: 'p' }, { $type: 'undefined' }],
        allowDestructive: false,
      })
    );
    expect(await sdk.richText.rem('r').value()).toEqual([{ i: 'q', _id: 'r' }]);
    const date = new Date('2026-10-02T00:00:00.000Z');
    expect(await sdk.date.getDailyDoc(date)).toEqual(date);
    expect(request).toHaveBeenLastCalledWith(
      'sdk_call',
      expect.objectContaining({ args: [{ $type: 'date', value: date.toISOString() }] })
    );
    expect(sdk.event).toBeUndefined();
    await expect(child.setParent((() => {}) as never)).rejects.toThrow('Callbacks');
    request.mockResolvedValueOnce({ capability: 'other', value: null });
    await expect(sdk.rem.findOne('r')).rejects.toThrow('mismatch');
  });

  it('waits for transaction commit acknowledgement and aborts local failures', async () => {
    const request = vi.fn(async () => ({}));
    const sdk = remoteSdk({ request } as never, catalog(), false);
    expect(await sdk.app.transaction(async () => 42)).toBe(42);
    expect(request.mock.calls).toEqual([
      ['transaction_begin', {}],
      ['transaction_end', { commit: true }],
    ]);
    request.mockClear();
    await expect(
      sdk.app.transaction(async () => {
        throw new Error('failed write');
      })
    ).rejects.toThrow('failed write');
    expect(request).toHaveBeenLastCalledWith('transaction_end', { commit: false });
    request
      .mockImplementationOnce(async () => ({}))
      .mockRejectedValueOnce(new Error('unknown commit'));
    await expect(sdk.app.transaction(async () => 42)).rejects.toThrow('unknown commit');
  });
});
