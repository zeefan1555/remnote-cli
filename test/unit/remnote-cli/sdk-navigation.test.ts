import { describe, expect, it } from 'vitest';
import {
  navigationCatalog,
  localSdkCapabilities,
  localSdkNavigation,
  navigationCapability,
  type CapabilityResult,
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

  it('disambiguates future duplicate navigation paths by capability ID', () => {
    const result: CapabilityResult = {
      catalogSchemaVersion: 1,
      sdkVersion: 'future',
      sdkCatalogHash: 'a'.repeat(64),
      capabilities: [
        {
          id: 'namespace:app.getPlatform',
          target: 'namespace',
          namespace: 'app',
          method: 'getPlatform',
          signatures: [],
          status: 'supported',
          mode: 'read',
        },
        {
          id: 'namespace:app.pluginTrack',
          target: 'namespace',
          namespace: 'app',
          method: 'pluginTrack',
          signatures: [],
          status: 'supported',
          mode: 'read',
        },
        {
          id: 'namespace:plugin.track',
          target: 'namespace',
          namespace: 'plugin',
          method: 'track',
          signatures: [],
          status: 'supported',
          mode: 'read',
        },
      ],
    };

    const navigation = navigationCatalog(result);
    const paths = navigation.capabilities.map(({ group, command }) => `${group}:${command}`);
    expect(new Set(paths).size).toBe(paths.length);
    expect(navigation.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'namespace:app.getPlatform', command: 'get-platform' }),
        expect.objectContaining({
          id: 'namespace:app.pluginTrack',
          command: 'plugin-track--namespace-app-plugin-track',
        }),
        expect.objectContaining({
          id: 'namespace:plugin.track',
          command: 'plugin-track--namespace-plugin-track',
        }),
      ])
    );
  });
});
