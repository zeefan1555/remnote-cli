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
import { describe, expect, it, vi, type MockInstance } from 'vitest';
import { DirectClient } from '../../../src/remnote-cli/client/direct-client.js';
import { runCliForTest } from '../../helpers/run-cli.js';

async function runTextCommand(
  args: string[],
  result: unknown
): Promise<{ output: string; executeSpy: MockInstance }> {
  const executeSpy = vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue(result);
  const cliResult = await runCliForTest(['--text', ...args]);
  return { output: cliResult.stdout.trimEnd(), executeSpy };
}

describe('command text output', () => {
  const TEST_PLUGIN_VERSION = '1.2.3';
  const TEST_CLI_VERSION = '1.2.3-test';

  it('formats create results with created Rem IDs', async () => {
    const { output, executeSpy } = await runTextCommand(['rem', 'create', 'Inbox'], {
      remIds: ['rem-1', 'rem-2'],
      titles: ['Inbox', ''],
    });

    expect(output).toContain('Created: Inbox (ID: rem-1)');
    expect(output).toContain('Created: (untitled) (ID: rem-2)');
    executeSpy.mockRestore();
  });

  it('formats empty create results', async () => {
    const { output, executeSpy } = await runTextCommand(['rem', 'create', 'Inbox'], { remIds: [] });

    expect(output).toBe('No Rems created.');
    executeSpy.mockRestore();
  });

  it('formats update results with and without created Rems', async () => {
    const withRems = await runTextCommand(
      ['rem', 'children', 'insert', 'rem-1', '--content', 'Body', '--position', 'last'],
      {
        remIds: ['child-1'],
        titles: ['Child'],
      }
    );
    expect(withRems.output).toBe('Updated/Created: Child (ID: child-1)');
    withRems.executeSpy.mockRestore();

    const withoutRems = await runTextCommand(['rem', 'update', 'rem-1', '--title', 'Renamed'], {
      remIds: [],
    });
    expect(withoutRems.output).toBe('Updated note rem-1 (no Rems created)');
    withoutRems.executeSpy.mockRestore();
  });

  it('formats split write results with created Rems', async () => {
    const insertResult = await runTextCommand(
      ['rem', 'children', 'insert', 'rem-1', '--content', 'Body', '--position', 'first'],
      {
        remIds: ['child-1'],
        titles: ['Child'],
      }
    );
    expect(insertResult.output).toBe('Updated/Created: Child (ID: child-1)');
    insertResult.executeSpy.mockRestore();

    const replaceResult = await runTextCommand(
      ['rem', 'children', 'replace', 'rem-1', '--content', 'Body'],
      {
        remIds: ['child-1'],
        titles: ['Child'],
      }
    );
    expect(replaceResult.output).toBe('Updated/Created: Child (ID: child-1)');
    replaceResult.executeSpy.mockRestore();

    const tagResult = await runTextCommand(
      ['rem', 'tags', 'update', 'rem-1', '--add-tag-ids', 'tag-1'],
      {
        remIds: ['rem-1'],
        titles: [''],
      }
    );
    expect(tagResult.output).toBe('Updated/Created: (untitled) (ID: rem-1)');
    tagResult.executeSpy.mockRestore();
  });

  it('formats document-status results', async () => {
    const { output, executeSpy } = await runTextCommand(
      ['rem', 'document', 'status', 'rem-1', '--document'],
      {
        remId: 'rem-1',
        title: 'Project Plan',
        oldRemType: 'concept',
        newRemType: 'document',
        newIsDocument: true,
        dryRun: true,
        changed: false,
      }
    );

    expect(output).toBe(
      'Dry-run document status: Project Plan (rem-1) concept -> document; isDocument=true'
    );
    executeSpy.mockRestore();
  });

  it('formats applied document-status results', async () => {
    const updated = await runTextCommand(
      ['rem', 'document', 'status', 'rem-1', '--document', '--apply'],
      {
        remId: 'rem-1',
        title: 'Project Plan',
        oldRemType: 'text',
        newRemType: 'document',
        newIsDocument: true,
        dryRun: false,
        changed: true,
      }
    );
    expect(updated.output).toBe(
      'Updated document status: Project Plan (rem-1) text -> document; isDocument=true'
    );
    updated.executeSpy.mockRestore();

    const unchanged = await runTextCommand(
      ['rem', 'document', 'status', 'rem-1', '--document', '--apply'],
      {
        remId: 'rem-1',
        title: 'Project Plan',
        oldRemType: 'document',
        newRemType: 'document',
        newIsDocument: true,
        dryRun: false,
        changed: false,
      }
    );
    expect(unchanged.output).toBe(
      'Document status unchanged: Project Plan (rem-1) document -> document; isDocument=true'
    );
    unchanged.executeSpy.mockRestore();
  });

  it('formats journal results with and without created Rems', async () => {
    const withRems = await runTextCommand(['journal', 'append', 'Entry'], {
      remIds: ['journal-1'],
      titles: ['Daily note'],
    });
    expect(withRems.output).toBe('Journal entry added: Daily note (ID: journal-1)');
    withRems.executeSpy.mockRestore();

    const withoutRems = await runTextCommand(['journal', 'append', 'Entry'], { remIds: [] });
    expect(withoutRems.output).toBe('No journal entry Rems created.');
    withoutRems.executeSpy.mockRestore();
  });

  it('formats status results with optional metadata', async () => {
    const { output, executeSpy } = await runTextCommand(['status'], {
      connected: true,
      pluginVersion: TEST_PLUGIN_VERSION,
      cliVersion: TEST_CLI_VERSION,
      knowledgeBaseId: 'test-kb',
      knowledgeBaseName: 'Test',
      protocolVersion: 2,
    });

    expect(output).toContain(`Bridge: Connected (plugin v${TEST_PLUGIN_VERSION})`);
    expect(output).toContain(`CLI: v${TEST_CLI_VERSION}`);
    expect(output).toContain('KB: Test (test-kb)');
    expect(output).toContain('Protocol: 2');
    executeSpy.mockRestore();
  });

  it('formats table results with columns and rows', async () => {
    const { output, executeSpy } = await runTextCommand(['table', 'read', '--title', 'Projects'], {
      tableName: 'Projects',
      tableId: 'table-1',
      columns: [
        { name: 'Status', type: 'text', propertyId: 'status' },
        { name: 'Priority', type: 'number', propertyId: 'priority' },
      ],
      rowsReturned: 1,
      totalRows: 3,
      rows: [{ name: 'Launch', values: { status: 'Active', priority: '1' } }],
    });

    expect(output).toContain('Table: Projects [table-1]');
    expect(output).toContain('Columns: Status (text), Priority (number)');
    expect(output).toContain('Rows: 1/3');
    expect(output).toContain('Name | Status | Priority');
    expect(output).toContain('Launch | Active | 1');
    executeSpy.mockRestore();
  });

  it('formats outline and todo workflow results', async () => {
    const outline = await runTextCommand(['rem', 'outline', 'collapse', '--today'], {
      rootRemId: 'daily-1',
      rootTitle: 'Today',
      collapsed: true,
      dryRun: true,
      scanned: 10,
      eligible: 3,
      changed: 2,
      items: [],
    });
    expect(outline.output).toContain('Preview collapse for Today [daily-1]');
    expect(outline.output).toContain('changed=2');
    outline.executeSpy.mockRestore();

    const todos = await runTextCommand(['todo', 'list', '--root-id', 'root', '--status', 'all'], {
      status: 'all',
      scanned: 1,
      todos: [
        {
          remId: 'todo-1',
          title: 'Finish task',
          todoStatus: 'Unfinished',
        },
      ],
    });
    expect(todos.output).toContain('Finish task [todo-1] native=Unfinished');
    todos.executeSpy.mockRestore();
  });

  it('formats SDK capability discovery', async () => {
    const { output, executeSpy } = await runTextCommand(['sdk', 'capabilities'], {
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
    });

    expect(output).toContain('RemNote SDK 0.0.46: 1 capabilities');
    expect(output).toContain(
      'sdk rem object-get-text: capability=rem:getText status=supported mode=read'
    );
    executeSpy.mockRestore();
  });

  it('shows generated SDK group and method help offline', async () => {
    const capabilities = {
      catalogSchemaVersion: 1,
      sdkVersion: '0.0.46',
      capabilities: [
        {
          id: 'rem:collapse',
          target: 'rem',
          method: 'collapse',
          signatures: ['collapse: (portalId: string) => Promise<boolean>'],
          summary: 'Collapse this Rem in a portal.',
          status: 'supported',
          mode: 'write',
        },
      ],
    };

    const group = await runTextCommand(['sdk', 'rem'], capabilities);
    expect(group.output).toContain('Usage: remnote-cli sdk rem [options] [command]');
    expect(group.output).toContain('object-collapse');
    expect(group.executeSpy).not.toHaveBeenCalled();
    group.executeSpy.mockRestore();

    const method = await runTextCommand(['sdk', 'rem', 'object-collapse', '--help'], capabilities);
    expect(method.output).toContain('Capability: rem:collapse');
    expect(method.output).toContain('collapse: (portal: RemId | RemObject | undefined)');
    expect(method.output).toContain('--target-id REM_ID');
    expect(method.executeSpy).not.toHaveBeenCalled();
    method.executeSpy.mockRestore();
  });

  it('shows unsupported SDK method help without invoking it', async () => {
    const capabilities = {
      catalogSchemaVersion: 1,
      sdkVersion: '0.0.46',
      capabilities: [
        {
          id: 'namespace:event.addListener',
          target: 'namespace',
          namespace: 'event',
          method: 'addListener',
          signatures: ['addListener: (event: string, callback: CallbackFn) => void'],
          status: 'unsupported',
          mode: 'write',
          reason: 'Event listeners require a persistent callback.',
        },
      ],
    };
    const { output, executeSpy } = await runTextCommand(
      ['sdk', 'event', 'add-listener', '--help'],
      capabilities
    );
    expect(output).toContain('Status: unsupported');
    expect(output).toContain('Reason: Event listeners require a persistent callback.');
    expect(executeSpy).not.toHaveBeenCalled();
    executeSpy.mockRestore();
  });

  it('formats search results with aliases and parent title without parent ID', async () => {
    const { output, executeSpy } = await runTextCommand(['rem', 'search', 'plan'], {
      results: [
        {
          remId: 'rem-1',
          title: 'Plan',
          remType: 'concept',
          aliases: ['Strategy', 'Roadmap'],
          parentTitle: 'Workspace',
        },
      ],
    });

    expect(output).toContain('1. [concept] Plan (aka: Strategy, Roadmap) <- Workspace [rem-1]');
    expect(output).toContain('Paging: complete=true, pages=1, items=1');
    executeSpy.mockRestore();
  });

  it('formats card search review counts', async () => {
    const { output, executeSpy } = await runTextCommand(
      ['rem', 'search', 'TQQQ', '--cards-only', '--include-review-stats'],
      {
        results: [
          {
            remId: 'card-rem-1',
            title: 'What is TQQQ?',
            headline: 'What is TQQQ?',
            remType: 'text',
            cards: [
              {
                cardId: 'card-1',
                repetitionHistory: [{ date: 100, score: 1 }],
              },
            ],
          },
        ],
      }
    );

    expect(output).toContain('cards: 1, repetitions: 1');
    executeSpy.mockRestore();
  });

  it('formats search paging metadata in text output', async () => {
    const { output, executeSpy } = await runTextCommand(['rem', 'search', 'plan'], {
      results: [
        {
          remId: 'rem-1',
          title: 'Plan',
          remType: 'text',
        },
      ],
      hasMore: true,
      nextCursor: 'search:v1:id:1:hash',
      truncated: true,
      truncationReason: 'cursor_snapshot_limit',
    });

    expect(output).toContain('1. Plan [rem-1]');
    expect(output).toContain('Next cursor: search:v1:id:1:hash');
    expect(output).toContain('Results truncated: cursor_snapshot_limit');
    executeSpy.mockRestore();
  });
});
