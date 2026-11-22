import { createHash } from 'node:crypto';
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
        {
          id: 'namespace:richText.toHTML',
          target: 'namespace',
          namespace: 'richText',
          method: 'toHTML',
          signatures: [],
          status: 'supported',
          mode: 'read',
        },
        {
          id: 'namespace:richText.toHtml',
          target: 'namespace',
          namespace: 'richText',
          method: 'toHtml',
          signatures: [],
          status: 'supported',
          mode: 'read',
        },
      ],
    };

    const navigation = navigationCatalog(result);
    const reversed = navigationCatalog({
      ...result,
      capabilities: [...result.capabilities].reverse(),
    });
    const paths = navigation.capabilities.map(({ group, command }) => `${group}:${command}`);
    const byId = new Map(
      navigation.capabilities.map(({ id, group, command }) => [id, `${group}:${command}`])
    );
    const reversedById = new Map(
      reversed.capabilities.map(({ id, group, command }) => [id, `${group}:${command}`])
    );
    const suffix = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 8);
    expect(new Set(paths).size).toBe(paths.length);
    expect(byId.get('namespace:app.getPlatform')).toBe('app:get-platform');
    expect(byId.get('namespace:app.pluginTrack')).toBe(
      `app:plugin-track--namespace-app-plugin-track-${suffix('namespace:app.pluginTrack')}`
    );
    expect(byId.get('namespace:plugin.track')).toBe(
      `app:plugin-track--namespace-plugin-track-${suffix('namespace:plugin.track')}`
    );
    expect(byId.get('namespace:richText.toHTML')).toBe(
      `richText:to-html--namespace-rich-text-to-html-${suffix('namespace:richText.toHTML')}`
    );
    expect(byId.get('namespace:richText.toHtml')).toBe(
      `richText:to-html--namespace-rich-text-to-html-${suffix('namespace:richText.toHtml')}`
    );
    expect(reversedById).toEqual(byId);
  });
});
