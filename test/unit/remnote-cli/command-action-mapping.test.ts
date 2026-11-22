vi.mock('../../../src/remnote-cli/client/sdk-capabilities.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/remnote-cli/client/sdk-capabilities.js')>();
  return {
    ...actual,
    getSdkCapabilities: async (client: DirectClient) => ({
      ...((await client.execute('get_sdk_capabilities', {})) as Record<string, unknown>),
      sdkCatalogHash: 'a'.repeat(64),
    }),
  };
});
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectClient } from '../../../src/remnote-cli/client/direct-client.js';
import { EXIT } from '../../../src/remnote-cli/output/errors.js';
import * as contentInput from '../../../src/remnote-cli/commands/content-input.js';
import { parseFailure, parseSuccess, runCliForTest } from '../../helpers/run-cli.js';

const tempDirs: string[] = [];

async function createTempContentFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'remnote-cli-command-map-'));
  tempDirs.push(dir);
  const path = join(dir, 'content.md');
  await writeFile(path, content, 'utf8');
  return path;
}

async function runCommand(args: string[], result: unknown = { ok: true }): Promise<MockInstance> {
  const executeSpy = vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue(result);
  await runCliForTest(args);
  return executeSpy;
}

describe('command bridge action mapping', () => {
  it.each(['update', 'update-answer'])('reads --content - as stdin for %s', async (command) => {
    const read = vi
      .spyOn(contentInput, 'readContentFileOrStdin')
      .mockResolvedValue('From stdin\nSee [[id:source]]');
    const args = [
      'rem',
      command,
      'answer',
      '--content',
      '-',
      '--expected-text-hash',
      'a'.repeat(64),
    ];
    if (command === 'update-answer') args.push('--card-id', 'question');
    const executeSpy = await runCommand(args);
    expect(executeSpy).toHaveBeenCalledWith(
      command === 'update' ? 'update_note' : 'update_answer',
      expect.objectContaining({ content: 'From stdin\nSee [[id:source]]' })
    );
    expect(read).toHaveBeenCalledWith('-');
    executeSpy.mockRestore();
    read.mockRestore();
  });
  it('maps safe own-text updates and native reference content without a public segment format', async () => {
    const executeSpy = await runCommand([
      'rem',
      'update',
      'question',
      '--content',
      'See [[id:source]]',
      '--expected-text-hash',
      'a'.repeat(64),
    ]);
    expect(executeSpy).toHaveBeenCalledWith('update_note', {
      remId: 'question',
      content: 'See [[id:source]]',
      expectedTextHash: 'a'.repeat(64),
    });
    executeSpy.mockRestore();
  });

  it('maps the answer update to its exact card-generating parent', async () => {
    const executeSpy = await runCommand([
      'rem',
      'update-answer',
      'answer',
      '--card-id',
      'question',
      '--content',
      'New answer',
      '--expected-text-hash',
      'a'.repeat(64),
    ]);
    expect(executeSpy).toHaveBeenCalledWith('update_answer', {
      remId: 'answer',
      cardId: 'question',
      content: 'New answer',
      expectedTextHash: 'a'.repeat(64),
    });
    executeSpy.mockRestore();
  });

  it.each([
    ['--add-aliases', 'Added'],
    ['--remove-aliases', 'Removed'],
    ['--add-aliases', 'Added', '--remove-aliases', 'Removed'],
  ])(
    'rejects content combined with alias flags before bridge execution: %j',
    async (...aliases) => {
      const executeSpy = vi
        .spyOn(DirectClient.prototype, 'execute')
        .mockResolvedValue({ ok: true });
      const result = await runCliForTest([
        'rem',
        'update',
        'question',
        '--content',
        'New',
        '--expected-text-hash',
        'a'.repeat(64),
        ...aliases,
      ]);
      expect(result.exitCode).toBe(EXIT.USAGE);
      expect(parseFailure(result.stderr).type).toBe('usage');
      expect(executeSpy).not.toHaveBeenCalled();
      executeSpy.mockRestore();
    }
  );

  it.each([
    ['rem', 'update', 'question', '--content', 'New'],
    ['rem', 'update', 'question', '--content', 'New', '--expected-text-hash', 'A'.repeat(64)],
    ['rem', 'update-answer', 'answer', '--content', 'New', '--expected-text-hash', 'a'.repeat(64)],
    ['rem', 'update-answer', 'answer', '--card-id', 'question', '--content', 'New'],
  ])('rejects incomplete or malformed updates at the command boundary: %j', async (...args) => {
    const executeSpy = vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({ ok: true });
    const result = await runCliForTest(args);
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(parseFailure(result.stderr).type).toBe('usage');
    expect(executeSpy).not.toHaveBeenCalled();
    executeSpy.mockRestore();
  });
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('maps create command to create_note', async () => {
    const executeSpy = await runCommand([
      'rem',
      'create',
      'Test Title',
      '--content',
      'Body',
      '--tag-ids',
      'tag-rem-id-a',
      'tag-rem-id-b',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('create_note', {
      title: 'Test Title',
      content: 'Body',
      tagRemIds: ['tag-rem-id-a', 'tag-rem-id-b'],
    });
    executeSpy.mockRestore();
  });

  it('maps create --content-file to create_note content payload', async () => {
    const filePath = await createTempContentFile('Body from file');
    const executeSpy = await runCommand(['rem', 'create', 'Title', '--content-file', filePath]);
    expect(executeSpy).toHaveBeenCalledWith('create_note', {
      title: 'Title',
      content: 'Body from file',
    });
    executeSpy.mockRestore();
  });

  it('maps create command with title positional and --content opt', async () => {
    const executeSpy = await runCommand(['rem', 'create', 'Title', '--content', 'Body']);
    expect(executeSpy).toHaveBeenCalledWith('create_note', {
      title: 'Title',
      content: 'Body',
    });
    executeSpy.mockRestore();
  });

  it('maps create command with title positional and --content opt', async () => {
    const executeSpy = await runCommand(['rem', 'create', 'Title', '--content', 'Body']);
    expect(executeSpy).toHaveBeenCalledWith('create_note', {
      title: 'Title',
      content: 'Body',
    });
    executeSpy.mockRestore();
  });

  it('maps create --as-document to create_note asDocument payload', async () => {
    const executeSpy = await runCommand(['rem', 'create', 'Title', '--as-document']);
    expect(executeSpy).toHaveBeenCalledWith('create_note', {
      title: 'Title',
      asDocument: true,
    });
    executeSpy.mockRestore();
  });

  it('maps create --aliases to create_note aliases', async () => {
    const executeSpy = await runCommand([
      'rem',
      'create',
      'Original Title',
      '--aliases',
      'Pôvodný názov',
      '원래 제목',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('create_note', {
      title: 'Original Title',
      aliases: ['Pôvodný názov', '원래 제목'],
    });
    executeSpy.mockRestore();
  });

  it('maps create command with title-only positional args', async () => {
    const executeSpy = await runCommand(['rem', 'create', 'Title']);
    expect(executeSpy).toHaveBeenCalledWith('create_note', {
      title: 'Title',
    });
    executeSpy.mockRestore();
  });

  it('maps create command with --title flag', async () => {
    const executeSpy = await runCommand(['rem', 'create', '--title', 'Flag Title']);
    expect(executeSpy).toHaveBeenCalledWith('create_note', {
      title: 'Flag Title',
    });
    executeSpy.mockRestore();
  });

  it('maps create command with content-only (--content)', async () => {
    const executeSpy = await runCommand(['rem', 'create', '--content', 'Body']);
    expect(executeSpy).toHaveBeenCalledWith('create_note', {
      content: 'Body',
    });
    executeSpy.mockRestore();
  });

  it('maps create command with no args (bridge-side error)', async () => {
    const executeSpy = await runCommand(['rem', 'create']);
    expect(executeSpy).toHaveBeenCalledWith('create_note', {});
    executeSpy.mockRestore();
  });

  it('maps create command with no args (bridge-side error)', async () => {
    const executeSpy = await runCommand(['rem', 'create']);
    expect(executeSpy).toHaveBeenCalledWith('create_note', {});
    executeSpy.mockRestore();
  });

  it('maps read command to read_note', async () => {
    const executeSpy = await runCommand(['rem', 'read', 'abc123', '--depth', '2']);
    expect(executeSpy).toHaveBeenCalledWith('read_note', { remId: 'abc123', depth: 2 });
    executeSpy.mockRestore();
  });

  it('maps several read ids to one read_note call keyed by remIds', async () => {
    const executeSpy = await runCommand([
      'rem',
      'read',
      'abc123',
      'def456',
      '--content-mode',
      'none',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('read_note', {
      remIds: ['abc123', 'def456'],
      depth: 5,
      contentMode: 'none',
    });
    executeSpy.mockRestore();
  });

  it('maps review-stats command to get_review_stats', async () => {
    const executeSpy = await runCommand(['card', 'review-stats', 'rem-1', 'rem-2']);
    expect(executeSpy).toHaveBeenCalledWith('get_review_stats', {
      remIds: ['rem-1', 'rem-2'],
    });
    executeSpy.mockRestore();
  });

  it('maps review-stats scope selectors', async () => {
    const todaySpy = await runCommand(['card', 'review-stats', '--today']);
    expect(todaySpy).toHaveBeenCalledWith('get_review_stats', { today: true });
    todaySpy.mockRestore();

    const rootSpy = await runCommand(['card', 'review-stats', '--root-id', 'root-1']);
    expect(rootSpy).toHaveBeenCalledWith('get_review_stats', { rootRemId: 'root-1' });
    rootSpy.mockRestore();

    const tagSpy = await runCommand(['card', 'review-stats', '--tag-id', 'tag-1']);
    expect(tagSpy).toHaveBeenCalledWith('get_review_stats', { tagRemId: 'tag-1' });
    tagSpy.mockRestore();
  });

  it('maps outline and todo workflow commands', async () => {
    const outlineSpy = await runCommand(['rem', 'outline', 'collapse', '--today', '--apply']);
    expect(outlineSpy).toHaveBeenCalledWith('set_outline_collapsed', {
      collapsed: true,
      dryRun: false,
      today: true,
    });
    outlineSpy.mockRestore();

    const listSpy = await runCommand(['todo', 'list', '--root-id', 'root', '--status', 'all']);
    expect(listSpy).toHaveBeenCalledWith('list_todos', {
      status: 'all',
      rootRemId: 'root',
    });
    listSpy.mockRestore();

    const scopedListSpy = await runCommand(['todo', 'list', '--root-id', 'root']);
    expect(scopedListSpy).toHaveBeenCalledWith('list_todos', {
      status: 'unfinished',
      rootRemId: 'root',
    });
    scopedListSpy.mockRestore();

    const missingRoot = await runCliForTest(['todo', 'list']);
    expect(missingRoot.exitCode).toBe(EXIT.USAGE);
    expect(parseFailure(missingRoot.stderr).subtype).toBe('commander.missingMandatoryOptionValue');

    const completeSpy = await runCommand(['todo', 'complete', 'todo-1', '--apply']);
    expect(completeSpy).toHaveBeenCalledWith('update_todo', {
      remId: 'todo-1',
      finished: true,
      dryRun: false,
    });
    completeSpy.mockRestore();

    const reopenSpy = await runCommand(['todo', 'reopen', 'todo-1']);
    expect(reopenSpy).toHaveBeenCalledWith('update_todo', {
      remId: 'todo-1',
      finished: false,
      dryRun: true,
    });
    reopenSpy.mockRestore();
  });

  it('maps sdk capabilities to get_sdk_capabilities', async () => {
    const result = {
      catalogSchemaVersion: 1,
      sdkVersion: '0.0.46',
      capabilities: [
        {
          id: 'rem:getText',
          target: 'rem',
          method: 'getText',
          signatures: ['getText: () => Promise<RichTextInterface>'],
          status: 'supported',
          mode: 'read',
        },
      ],
    };
    const executeSpy = await runCommand(['sdk', 'capabilities', '--group', 'rem'], result);
    expect(executeSpy).toHaveBeenCalledWith('get_sdk_capabilities', {});
    executeSpy.mockRestore();
  });

  it('lists live capabilities when future navigation names collide', async () => {
    const executeSpy = vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({
      catalogSchemaVersion: 1,
      sdkVersion: 'future',
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
    });

    const result = await runCliForTest(['sdk', 'capabilities']);
    const data = parseSuccess(result.stdout) as {
      capabilities: Array<{ group: string; command: string }>;
    };
    const paths = data.capabilities.map(({ group, command }) => `${group}:${command}`);
    expect(result.exitCode).toBe(0);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual(
      expect.arrayContaining([
        'app:get-platform',
        expect.stringMatching(/^app:plugin-track--namespace-app-plugin-track-/),
        expect.stringMatching(/^app:plugin-track--namespace-plugin-track-/),
      ])
    );
    executeSpy.mockRestore();
  });

  it('maps an sdk rem object command to sdk_call', async () => {
    const capabilities = {
      catalogSchemaVersion: 1,
      sdkVersion: '0.0.46',
      capabilities: [
        {
          id: 'rem:setText',
          target: 'rem',
          method: 'setText',
          signatures: ['setText: (text: RichTextInterface) => Promise<void>'],
          status: 'supported',
          mode: 'write',
        },
      ],
    };
    const executeSpy = await runCommand(
      ['sdk', 'rem', 'object-set-text', '--target-id', 'rem-1', '--args-json', '["Title"]'],
      capabilities
    );
    expect(executeSpy).toHaveBeenNthCalledWith(1, 'get_sdk_capabilities', {});
    expect(executeSpy).toHaveBeenNthCalledWith(2, 'sdk_call', {
      capability: 'rem:setText',
      expectedCatalogHash: 'a'.repeat(64),
      targetId: 'rem-1',
      args: ['Title'],
    });
    executeSpy.mockRestore();
  });

  it('refuses a specific SDK action when the live mode contradicts local risk metadata', async () => {
    const catalog = {
      catalogSchemaVersion: 1,
      sdkVersion: 'future',
      capabilities: [
        {
          id: 'rem:getChildrenRem',
          target: 'rem',
          method: 'getChildrenRem',
          signatures: [],
          status: 'supported',
          mode: 'write',
        },
      ],
    };
    const executeSpy = vi
      .spyOn(DirectClient.prototype, 'execute')
      .mockImplementation(async (action) =>
        action === 'get_sdk_capabilities' ? catalog : { unexpected: true }
      );

    const result = await runCliForTest([
      'sdk',
      'rem',
      'object-get-children-rem',
      '--target-id',
      'rem-1',
      '--args-json',
      '[]',
    ]);
    expect(result.exitCode).toBe(EXIT.NOT_FOUND_OR_CONFLICT);
    expect(parseFailure(result.stderr)).toMatchObject({ subtype: 'sdk_catalog_mismatch' });
    expect(executeSpy).not.toHaveBeenCalledWith('sdk_call', expect.anything());
    executeSpy.mockRestore();
  });

  it('maps an SDK namespace command args file to sdk_call', async () => {
    const filePath = await createTempContentFile('[{"value":1}]');
    const capabilities = {
      catalogSchemaVersion: 1,
      sdkVersion: '0.0.46',
      capabilities: [
        {
          id: 'namespace:messaging.broadcast',
          target: 'namespace',
          namespace: 'messaging',
          method: 'broadcast',
          signatures: ['broadcast: (message: unknown) => Promise<void>'],
          status: 'supported',
          mode: 'write',
        },
      ],
    };
    const executeSpy = await runCommand(
      ['sdk', 'messaging', 'broadcast', '--args-file', filePath],
      capabilities
    );
    expect(executeSpy).toHaveBeenNthCalledWith(1, 'get_sdk_capabilities', {});
    expect(executeSpy).toHaveBeenNthCalledWith(2, 'sdk_call', {
      capability: 'namespace:messaging.broadcast',
      expectedCatalogHash: 'a'.repeat(64),
      args: [{ value: 1 }],
    });
    executeSpy.mockRestore();
  });

  it('passes explicit destructive approval through an SDK command', async () => {
    const capabilities = {
      catalogSchemaVersion: 1,
      sdkVersion: '0.0.46',
      capabilities: [
        {
          id: 'card:remove',
          target: 'card',
          method: 'remove',
          signatures: ['remove: () => Promise<void>'],
          status: 'supported',
          mode: 'destructive',
        },
      ],
    };
    const executeSpy = await runCommand(
      ['sdk', 'card', 'object-remove', '--target-id', 'card-1', '--allow-destructive'],
      capabilities
    );
    expect(executeSpy).toHaveBeenNthCalledWith(2, 'sdk_call', {
      capability: 'card:remove',
      expectedCatalogHash: 'a'.repeat(64),
      targetId: 'card-1',
      allowDestructive: true,
    });
    executeSpy.mockRestore();
  });

  it('calls a supported live capability through the raw sdk call escape hatch', async () => {
    const capabilities = {
      catalogSchemaVersion: 1,
      sdkVersion: '0.0.46',
      capabilities: [
        {
          id: 'rem:remove',
          target: 'rem',
          method: 'remove',
          signatures: ['remove: () => Promise<void>'],
          status: 'supported',
          mode: 'destructive',
        },
      ],
    };
    const executeSpy = await runCommand(
      ['sdk', 'call', 'rem:remove', '--target-id', 'rem-1', '--allow-destructive'],
      capabilities
    );
    expect(executeSpy).toHaveBeenNthCalledWith(1, 'get_sdk_capabilities', {});
    expect(executeSpy).toHaveBeenNthCalledWith(2, 'sdk_call', {
      capability: 'rem:remove',
      expectedCatalogHash: 'a'.repeat(64),
      targetId: 'rem-1',
      allowDestructive: true,
    });
    executeSpy.mockRestore();
  });

  it('rejects conflicting SDK argument sources before calling sdk_call', async () => {
    const filePath = await createTempContentFile('[]');
    const executeSpy = vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({
      catalogSchemaVersion: 1,
      sdkVersion: '0.0.46',
      capabilities: [
        {
          id: 'namespace:app.getPlatform',
          target: 'namespace',
          namespace: 'app',
          method: 'getPlatform',
          signatures: ['getPlatform: () => Promise<Platform>'],
          status: 'supported',
          mode: 'read',
        },
      ],
    });
    try {
      const output = await runCliForTest([
        'sdk',
        'app',
        'get-platform',
        '--args-json',
        '[]',
        '--args-file',
        filePath,
      ]);
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(output.stderr).toContain('Cannot use --args-json and --args-file together');
      expect(output.exitCode).toBe(EXIT.USAGE);
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('passes through structured read content mode', async () => {
    const executeSpy = await runCommand(['rem', 'read', 'abc123', '--content-mode', 'structured']);
    expect(executeSpy).toHaveBeenCalledWith('read_note', {
      remId: 'abc123',
      depth: 5,
      contentMode: 'structured',
    });
    executeSpy.mockRestore();
  });

  it('requests media metadata from read', async () => {
    const executeSpy = await runCommand(['rem', 'read', 'abc123', '--include-media-metadata']);
    expect(executeSpy).toHaveBeenCalledWith('read_note', {
      remId: 'abc123',
      depth: 5,
      includeMediaMetadata: true,
    });
    executeSpy.mockRestore();
  });

  it('maps get-media and writes image bytes to the requested path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'remnote-cli-media-'));
    tempDirs.push(dir);
    const outputPath = join(dir, 'image.png');
    const data = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    const executeSpy = await runCommand(
      [
        'media',
        'get',
        'abc123',
        '--field',
        'text',
        '--media-id',
        'media_1234',
        '--output',
        outputPath,
        '--max-inline-bytes',
        '1024',
        '--force',
      ],
      { data, mimeType: 'image/png', sizeBytes: 8, mediaId: 'media_1234' }
    );

    expect(executeSpy).toHaveBeenCalledWith('get_media', {
      remId: 'abc123',
      field: 'text',
      mediaId: 'media_1234',
      maxInlineBytes: 1024,
    });
    expect(await readFile(outputPath)).toEqual(Buffer.from(data, 'base64'));
    executeSpy.mockRestore();
  });

  it('maps search command to search with content rendering options', async () => {
    const executeSpy = await runCommand([
      'rem',
      'search',
      'ml',
      '--content-mode',
      'markdown',
      '--depth',
      '1',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('search', {
      query: 'ml',
      limit: 50,
      contentMode: 'markdown',
      depth: 1,
    });
    executeSpy.mockRestore();
  });

  it('passes through search parent-id option', async () => {
    const executeSpy = await runCommand(['rem', 'search', 'ml', '--parent-id', 'parentRemId123']);
    expect(executeSpy).toHaveBeenCalledWith('search', {
      query: 'ml',
      limit: 50,
      parentRemId: 'parentRemId123',
    });
    executeSpy.mockRestore();
  });

  it('passes through card filtering and review facts options', async () => {
    const executeSpy = await runCommand([
      'rem',
      'search',
      'TQQQ',
      '--cards-only',
      '--include-review-stats',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('search', {
      query: 'TQQQ',
      limit: 50,
      cardsOnly: true,
      includeReviewStats: true,
    });
    executeSpy.mockRestore();
  });

  it('passes through structured search content mode', async () => {
    const executeSpy = await runCommand([
      'rem',
      'search',
      'folders',
      '--content-mode',
      'structured',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('search', {
      query: 'folders',
      limit: 50,
      contentMode: 'structured',
    });
    executeSpy.mockRestore();
  });

  it('passes through search cursor', async () => {
    const executeSpy = await runCommand([
      'rem',
      'search',
      'folders',
      '--cursor',
      'search:v1:id:2:hash',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('search', {
      query: 'folders',
      limit: 50,
      cursor: 'search:v1:id:2:hash',
    });
    executeSpy.mockRestore();
  });

  it('maps search-by-tag command to search_by_tag with content rendering options', async () => {
    const executeSpy = await runCommand([
      'rem',
      'search-by-tag',
      '--tag-id',
      'daily-tag-rem-id',
      '--content-mode',
      'markdown',
      '--depth',
      '2',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('search_by_tag', {
      tagRemId: 'daily-tag-rem-id',
      limit: 50,
      contentMode: 'markdown',
      depth: 2,
    });
    executeSpy.mockRestore();
  });

  it('passes through structured search-by-tag content mode', async () => {
    const executeSpy = await runCommand([
      'rem',
      'search-by-tag',
      '--tag-id',
      'project-tag-rem-id',
      '--content-mode',
      'structured',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('search_by_tag', {
      tagRemId: 'project-tag-rem-id',
      limit: 50,
      contentMode: 'structured',
    });
    executeSpy.mockRestore();
  });

  it('passes through tagged search-by-tag result mode', async () => {
    const executeSpy = await runCommand([
      'rem',
      'search-by-tag',
      '--tag-id',
      'project-tag-rem-id',
      '--result-mode',
      'tagged',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('search_by_tag', {
      tagRemId: 'project-tag-rem-id',
      limit: 50,
      resultMode: 'tagged',
    });
    executeSpy.mockRestore();
  });

  it('passes through search-by-tag cursor', async () => {
    const executeSpy = await runCommand([
      'rem',
      'search-by-tag',
      '--tag-id',
      'project-tag-rem-id',
      '--cursor',
      'search_by_tag:v1:id:2:hash',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('search_by_tag', {
      tagRemId: 'project-tag-rem-id',
      limit: 50,
      cursor: 'search_by_tag:v1:id:2:hash',
    });
    executeSpy.mockRestore();
  });

  it('maps list-children command to list_children with traversal options', async () => {
    const executeSpy = await runCommand([
      'rem',
      'children',
      'list',
      'parent123',
      '--limit',
      '25',
      '--view',
      'compact',
      '--ancestor-depth',
      '3',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('list_children', {
      parentRemId: 'parent123',
      limit: 25,
      view: 'compact',
      ancestorDepth: 3,
    });
    executeSpy.mockRestore();
  });

  it('maps several list-children parents to one list_children call', async () => {
    const executeSpy = await runCommand([
      'rem',
      'children',
      'list',
      'parent-a',
      'parent-b',
      '--limit',
      '10',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('list_children', {
      parentRemIds: ['parent-a', 'parent-b'],
      limit: 10,
    });
    executeSpy.mockRestore();
  });

  it('maps list-children cursor pagination', async () => {
    const executeSpy = await runCommand([
      'rem',
      'children',
      'list',
      'parent123',
      '--cursor',
      'list_children:v1:parent123:50:hash',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('list_children', {
      parentRemId: 'parent123',
      limit: 50,
      cursor: 'list_children:v1:parent123:50:hash',
    });
    executeSpy.mockRestore();
  });

  it('maps update command with --title flag', async () => {
    const executeSpy = await runCommand(['rem', 'update', 'abc123', '--title', 'New Title']);
    expect(executeSpy).toHaveBeenCalledWith('update_note', {
      remId: 'abc123',
      title: 'New Title',
    });
    executeSpy.mockRestore();
  });

  it('maps update alias flags without requiring a title', async () => {
    const executeSpy = await runCommand([
      'rem',
      'update',
      'abc123',
      '--add-aliases',
      'New Alias',
      '日本語',
      '--remove-aliases',
      'Old Alias',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('update_note', {
      remId: 'abc123',
      addAliases: ['New Alias', '日本語'],
      removeAliases: ['Old Alias'],
    });
    executeSpy.mockRestore();
  });

  it('maps insert-children to insert_children payload', async () => {
    const executeSpy = await runCommand([
      'rem',
      'children',
      'insert',
      'parent123',
      '--content',
      'Inserted content',
      '--position',
      'first',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('insert_children', {
      parentRemId: 'parent123',
      content: 'Inserted content',
      position: 'first',
    });
    executeSpy.mockRestore();
  });

  it('maps insert-children --content-file before sibling to insert_children payload', async () => {
    const filePath = await createTempContentFile('Insert from file');
    const executeSpy = await runCommand([
      'rem',
      'children',
      'insert',
      'parent123',
      '--content-file',
      filePath,
      '--position',
      'before',
      '--sibling-rem-id',
      'sibling123',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('insert_children', {
      parentRemId: 'parent123',
      content: 'Insert from file',
      position: 'before',
      siblingRemId: 'sibling123',
    });
    executeSpy.mockRestore();
  });

  it('maps replace-children --content-file to replace_children payload', async () => {
    const filePath = await createTempContentFile('Replace from file');
    const executeSpy = await runCommand([
      'rem',
      'children',
      'replace',
      'parent123',
      '--content-file',
      filePath,
    ]);
    expect(executeSpy).toHaveBeenCalledWith('replace_children', {
      parentRemId: 'parent123',
      content: 'Replace from file',
    });
    executeSpy.mockRestore();
  });

  it('maps update-tags to update_tags payload', async () => {
    const executeSpy = await runCommand([
      'rem',
      'tags',
      'update',
      'abc123',
      '--add-tag-ids',
      'tag1',
      'tag2',
      '--remove-tag-ids',
      'tag3',
      '--allow-destructive',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('update_tags', {
      remId: 'abc123',
      addTagRemIds: ['tag1', 'tag2'],
      removeTagRemIds: ['tag3'],
    });
    executeSpy.mockRestore();
  });

  it('keeps help as literal journal content', async () => {
    const executeSpy = await runCommand(['journal', 'append', '--content', 'help']);
    expect(executeSpy).toHaveBeenCalledWith(
      'append_journal',
      expect.objectContaining({ content: 'help' })
    );
    executeSpy.mockRestore();
  });

  it('maps set-property --value to set_property payload', async () => {
    const executeSpy = await runCommand([
      'rem',
      'property',
      'set',
      'abc123',
      '--tag-id',
      'tag1',
      '--property-id',
      'prop1',
      '--value',
      'People',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('set_property', {
      remId: 'abc123',
      tagRemId: 'tag1',
      propertyRemId: 'prop1',
      value: { kind: 'text', text: 'People' },
    });
    executeSpy.mockRestore();
  });

  it('maps set-property --rem-reference-id to set_property payload', async () => {
    const executeSpy = await runCommand([
      'rem',
      'property',
      'set',
      'abc123',
      '--tag-id',
      'tag1',
      '--property-id',
      'prop1',
      '--rem-reference-id',
      'option1',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('set_property', {
      remId: 'abc123',
      tagRemId: 'tag1',
      propertyRemId: 'prop1',
      value: { kind: 'rem_reference', remId: 'option1' },
    });
    executeSpy.mockRestore();
  });

  it('maps set-property --clear to set_property payload', async () => {
    const executeSpy = await runCommand([
      'rem',
      'property',
      'set',
      'abc123',
      '--tag-id',
      'tag1',
      '--property-id',
      'prop1',
      '--clear',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('set_property', {
      remId: 'abc123',
      tagRemId: 'tag1',
      propertyRemId: 'prop1',
      value: { kind: 'clear' },
    });
    executeSpy.mockRestore();
  });

  it('formats set-property text output', async () => {
    const executeSpy = vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({
      remId: 'abc123',
      propertyRemId: 'prop1',
      valueKind: 'rem_reference',
    });
    try {
      const output = await runCliForTest([
        '--text',
        'rem',
        'property',
        'set',
        'abc123',
        '--tag-id',
        'tag1',
        '--property-id',
        'prop1',
        '--rem-reference-id',
        'option1',
      ]);

      expect(output.stdout.trimEnd()).toBe('Set property: prop1 on abc123 (rem_reference)');
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('rejects set-property without a value option', async () => {
    const executeSpy = vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({ ok: true });

    try {
      const output = await runCliForTest([
        'rem',
        'property',
        'set',
        'abc123',
        '--tag-id',
        'tag1',
        '--property-id',
        'prop1',
      ]);

      expect(executeSpy).not.toHaveBeenCalled();
      expect(output.stderr).toContain(
        'Provide exactly one of --value, --rem-reference-id, or --clear'
      );
      expect(output.exitCode).toBe(EXIT.USAGE);
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('rejects set-property with multiple value options', async () => {
    const executeSpy = vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({ ok: true });

    try {
      const output = await runCliForTest([
        'rem',
        'property',
        'set',
        'abc123',
        '--tag-id',
        'tag1',
        '--property-id',
        'prop1',
        '--value',
        'People',
        '--clear',
      ]);

      expect(executeSpy).not.toHaveBeenCalled();
      expect(output.stderr).toContain(
        'Provide exactly one of --value, --rem-reference-id, or --clear'
      );
      expect(output.exitCode).toBe(EXIT.USAGE);
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('maps move-note to dry-run move_note by default', async () => {
    const executeSpy = await runCommand([
      'rem',
      'move',
      'rem123',
      '--new-parent-rem-id',
      'parent456',
      '--expected-old-parent-rem-id',
      'old-parent',
      '--ancestor-depth',
      '4',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('move_note', {
      remId: 'rem123',
      newParentRemId: 'parent456',
      dryRun: true,
      expectedOldParentRemId: 'old-parent',
      ancestorDepth: 4,
    });
    executeSpy.mockRestore();
  });

  it('maps rem delete preview and guarded apply', async () => {
    const preview = await runCommand(['rem', 'delete', 'rem-1']);
    expect(preview).toHaveBeenCalledWith('delete_rem', { remId: 'rem-1', dryRun: true });
    preview.mockRestore();

    const apply = await runCommand([
      'rem',
      'delete',
      'rem-1',
      '--apply',
      '--expected-title',
      'Expected title',
      '--allow-destructive',
    ]);
    expect(apply).toHaveBeenCalledWith('delete_rem', {
      remId: 'rem-1',
      dryRun: false,
      expectedTitle: 'Expected title',
    });
    apply.mockRestore();
  });

  it('maps move-note --apply with sibling position', async () => {
    const executeSpy = await runCommand([
      'rem',
      'move',
      'rem123',
      '--new-parent-rem-id',
      'parent456',
      '--position',
      'before',
      '--sibling-rem-id',
      'sibling789',
      '--apply',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('move_note', {
      remId: 'rem123',
      newParentRemId: 'parent456',
      dryRun: false,
      position: 'before',
      siblingRemId: 'sibling789',
    });
    executeSpy.mockRestore();
  });

  it('maps set-document-status to dry-run set_document_status by default', async () => {
    const executeSpy = await runCommand([
      'rem',
      'document',
      'status',
      'rem123',
      '--document',
      '--expected-old-rem-type',
      'concept',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('set_document_status', {
      remId: 'rem123',
      isDocument: true,
      dryRun: true,
      expectedOldRemType: 'concept',
    });
    executeSpy.mockRestore();
  });

  it('maps set-document-status --apply with --no-document', async () => {
    const executeSpy = await runCommand([
      'rem',
      'document',
      'status',
      'rem123',
      '--no-document',
      '--apply',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('set_document_status', {
      remId: 'rem123',
      isDocument: false,
      dryRun: false,
    });
    executeSpy.mockRestore();
  });

  it('rejects set-document-status without an explicit target status', async () => {
    const executeSpy = vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({ ok: true });

    try {
      const output = await runCliForTest(['rem', 'document', 'status', 'rem123']);

      expect(executeSpy).not.toHaveBeenCalled();
      expect(output.stderr).toContain('Provide --document or --no-document');
      expect(output.exitCode).toBe(EXIT.USAGE);
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('maps journal command with positional content', async () => {
    const executeSpy = await runCommand([
      'journal',
      'append',
      'Positional Entry',
      '--no-timestamp',
      '--tag-ids',
      'journal-tag-rem-id',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('append_journal', {
      content: 'Positional Entry',
      timestamp: false,
      tagRemIds: ['journal-tag-rem-id'],
    });
    executeSpy.mockRestore();
  });

  it('maps journal --content to append_journal', async () => {
    const executeSpy = await runCommand(['journal', 'append', '--content', 'Entry from flag']);
    expect(executeSpy).toHaveBeenCalledWith('append_journal', {
      content: 'Entry from flag',
      timestamp: true,
    });
    executeSpy.mockRestore();
  });

  it('maps journal --content-file to append_journal', async () => {
    const filePath = await createTempContentFile('Journal from file');
    const executeSpy = await runCommand(['journal', 'append', '--content-file', filePath]);
    expect(executeSpy).toHaveBeenCalledWith('append_journal', {
      content: 'Journal from file',
      timestamp: true,
    });
    executeSpy.mockRestore();
  });

  it('maps read-table command to read_table', async () => {
    const executeSpy = await runCommand(['table', 'read', '--title', 'My Table']);
    expect(executeSpy).toHaveBeenCalledWith('read_table', {
      tableTitle: 'My Table',
      limit: 50,
      offset: 0,
    });
    executeSpy.mockRestore();
  });

  it('maps read-table command with --limit option', async () => {
    const executeSpy = await runCommand(['table', 'read', '--title', 'My Table', '--limit', '20']);
    expect(executeSpy).toHaveBeenCalledWith('read_table', {
      tableTitle: 'My Table',
      limit: 20,
      offset: 0,
    });
    executeSpy.mockRestore();
  });

  it('maps read-table command with --offset option', async () => {
    const executeSpy = await runCommand(['table', 'read', '--title', 'My Table', '--offset', '10']);
    expect(executeSpy).toHaveBeenCalledWith('read_table', {
      tableTitle: 'My Table',
      limit: 50,
      offset: 10,
    });
    executeSpy.mockRestore();
  });

  it('maps read-table command with --properties filter', async () => {
    const executeSpy = await runCommand([
      'table',
      'read',
      '--title',
      'My Table',
      '--properties',
      'Status,Priority',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('read_table', {
      tableTitle: 'My Table',
      limit: 50,
      offset: 0,
      propertyFilter: ['Status', 'Priority'],
    });
    executeSpy.mockRestore();
  });

  it('maps read-table command with Rem ID as table identifier', async () => {
    const executeSpy = await runCommand(['table', 'read', '--rem-id', 'abc123-rem-id']);
    expect(executeSpy).toHaveBeenCalledWith('read_table', {
      tableRemId: 'abc123-rem-id',
      limit: 50,
      offset: 0,
    });
    executeSpy.mockRestore();
  });

  it('maps read-table command with all options combined', async () => {
    const executeSpy = await runCommand([
      'table',
      'read',
      '--title',
      'Table',
      '--limit',
      '10',
      '--offset',
      '5',
      '--properties',
      'Name',
    ]);
    expect(executeSpy).toHaveBeenCalledWith('read_table', {
      tableTitle: 'Table',
      limit: 10,
      offset: 5,
      propertyFilter: ['Name'],
    });
    executeSpy.mockRestore();
  });
});
