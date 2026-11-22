import { describe, expect, it } from 'vitest';
import {
  localSdkCapabilities,
  localSdkNavigation,
  navigationCapability,
} from '../../../src/remnote-cli/client/sdk-capabilities.js';

describe('SDK navigation', () => {
  it('derives 286 unique CLI paths offline from versioned SDK facts', () => {
    const facts = localSdkCapabilities();
    const navigation = localSdkNavigation();

    expect(facts.catalogSchemaVersion).toBe(1);
    expect(facts.sdkVersion).toBe('0.0.46');
    expect(navigation.capabilities).toHaveLength(286);
    expect(new Set(navigation.capabilities.map(({ id }) => id)).size).toBe(286);
    expect(
      new Set(navigation.capabilities.map(({ group, command }) => `${group}:${command}`)).size
    ).toBe(286);
    expect(new Set(navigation.capabilities.map(({ group }) => group)).size).toBe(19);
  });

  it('maps object, query, builder and plugin capabilities without Bridge fields', () => {
    expect(
      navigationCapability({
        id: 'rem:getText',
        target: 'rem',
        method: 'getText',
        signatures: [],
        status: 'supported',
        mode: 'read',
      })
    ).toMatchObject({ group: 'rem', command: 'object-get-text' });
    expect(
      navigationCapability({
        id: 'query:text',
        target: 'query',
        method: 'text',
        signatures: [],
        status: 'supported',
        mode: 'read',
      })
    ).toMatchObject({ group: 'search', command: 'query-text' });
    expect(
      navigationCapability({
        id: 'namespace:richText.builder.text',
        target: 'namespace',
        namespace: 'richText.builder',
        method: 'text',
        signatures: [],
        status: 'unsupported',
        mode: 'read',
      })
    ).toMatchObject({ group: 'richText', command: 'builder-text' });
    expect(
      navigationCapability({
        id: 'namespace:plugin.track',
        target: 'namespace',
        namespace: 'plugin',
        method: 'track',
        signatures: [],
        status: 'unsupported',
        mode: 'read',
      })
    ).toMatchObject({ group: 'app', command: 'plugin-track' });
  });
});
