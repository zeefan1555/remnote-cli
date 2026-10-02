import { readFile, rm } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { CliTestClient } from '../../integration/cli/cli-test-client.js';
import { flashcardsWorkflow } from '../../integration/cli/workflows/10-flashcards.js';

afterEach(() => vi.restoreAllMocks());

it('stops after a partial apply, preserving the exact plan/key without replaying the write', async () => {
  let directory = '';
  vi.spyOn(console, 'log').mockImplementation((value: string) => {
    if (value.startsWith('Flashcard evidence and recovery plan: ')) {
      directory = value.slice('Flashcard evidence and recovery plan: '.length);
    }
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const cli = new CliTestClient();
  const run = vi.spyOn(cli, 'run').mockImplementation(async (args) => {
    let json: unknown;
    let exitCode = 0;
    switch (args[0]) {
      case 'status':
        json = {
          connected: true,
          pluginId: 'zeefan-remnote-sdk-bridge',
          protocolVersion: 1,
          knowledgeBaseId: 'test-kb',
          sdkCatalogHash: 'a'.repeat(64),
          acceptWriteOperations: true,
          pluginVersion: '0.24.0',
          cliVersion: '0.24.0',
        };
        break;
      case 'search':
        json = {
          results: [
            {
              title: args[1],
              remId: args[1] === 'HOME' ? 'home' : 'tag',
              remType: args[1] === 'HOME' ? 'folder' : 'concept',
            },
            { title: args[1], remId: 'unrelated-same-title', remType: 'text' },
          ],
        };
        break;
      case 'sdk':
        json = args[1] === 'app' ? { value: 'app' } : { value: { id: 'daily' } };
        break;
      case 'context':
        json = {
          complete: true,
          errors: [],
          objects: [
            { remId: 'daily', remType: 'dailyDocument' },
            { remId: 'home', remType: 'folder' },
            { remId: 'tag', remType: 'concept', ancestorRemIds: ['home'] },
          ],
        };
        break;
      case 'flashcards':
        if (args.includes('--apply')) {
          json = { status: 'partial', complete: false, errors: [{ code: 'deadline' }] };
          exitCode = 1;
        } else {
          json = { status: 'preview', complete: true, errors: [], created: [] };
        }
        break;
      default:
        throw new Error(`Unexpected command: ${args.join(' ')}`);
    }
    return { json, exitCode, stdout: JSON.stringify(json), stderr: '' };
  });

  try {
    const result = await flashcardsWorkflow({ cli, runId: new Date().toISOString() }, 'test-tag');
    expect(result.steps.map((step) => step.passed)).toEqual([true, true, false]);
    const writes = run.mock.calls.filter(([args]) => args.includes('--apply'));
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toBe(70000);
    const batch = JSON.parse(await readFile(`${directory}/batch.json`, 'utf8'));
    const plan = JSON.parse(await readFile(batch.planPath, 'utf8'));
    expect(plan.newCards).toHaveLength(2);
    expect(writes[0][0]).toContain(batch.idempotencyKey);
    expect(plan).not.toHaveProperty('answerPatches');
  } finally {
    if (directory) await rm(directory, { recursive: true });
  }
});
