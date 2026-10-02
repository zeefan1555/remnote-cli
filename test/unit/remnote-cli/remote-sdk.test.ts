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
      id: 'rem:getAliases',
      target: 'rem',
      method: 'getAliases',
      group: 'rem',
      command: 'object-get-aliases',
      signatures: [],
      status: 'supported',
      mode: 'read',
      materialize: 'aliasText',
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
            : payload.capability === 'rem:getAliases'
              ? [{ text: ['Alias'] }]
              : payload.capability === 'namespace:date.getDailyDoc'
                ? { $type: 'date', value: '2026-10-02T00:00:00.000Z' }
                : { $type: 'undefined' },
    }));
    const sdk = remoteSdk({ request } as never, catalog(), false);
    const child = (await sdk.rem.findOne('r'))!,
      parent = (await sdk.rem.findOne('p'))!;
    expect(child._id).toBe('r');
    expect(child.text).toEqual(['Title']);
    expect(await child.getAliases()).toEqual([{ text: ['Alias'] }]);
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

  it('refuses native transactions before any callback or request runs', async () => {
    const request = vi.fn(async () => ({}));
    const sdk = remoteSdk({ request } as never, catalog(), false);
    const callback = vi.fn(async () => 42);
    await expect(sdk.app.transaction(callback)).rejects.toThrow(
      'Native transactions are unavailable'
    );
    expect(callback).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
