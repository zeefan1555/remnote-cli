import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemAdapter } from '../../../src/business/rem-adapter.js';
import { DirectClient } from '../../../src/remnote-cli/client/direct-client.js';
import { createProgram } from '../../../src/remnote-cli/cli.js';
import { MockRemNotePlugin } from '../../helpers/business-mocks.js';

function adapter(plugin: MockRemNotePlugin): RemAdapter {
  return new RemAdapter(plugin as never, { acceptWriteOperations: false, autoTagEnabled: false });
}

describe('multi-id reads', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('returns read and list-children results keyed by id and keeps per-id errors', async () => {
    const plugin = new MockRemNotePlugin();
    const parent = plugin.addTestRem('parent', 'Parent');
    const child = plugin.addTestRem('child', 'Child');
    await child.setParent(parent);
    plugin.addTestRem('other', 'Other');
    const notes = adapter(plugin);
    await expect(notes.readNote({ remId: 'missing' })).rejects.toThrow('Note not found: missing');
    const read = await notes.readNotes({ remIds: ['child', 'missing'], contentMode: 'none' });
    expect(read.results.child).toMatchObject({ remId: 'child', title: 'Child' });
    expect(read.results.missing).toEqual({ error: 'Note not found: missing' });
    const listed = await notes.listChildrenMany({ parentRemIds: ['parent', 'other', 'missing'] });
    expect(listed.results.parent).toMatchObject({ totalChildren: 1 });
    expect(listed.results.other).toMatchObject({ totalChildren: 0 });
    expect(listed.results.missing).toEqual({ error: 'Parent note not found: missing' });
  });

  it('keeps a __proto__ id in multi-id results through JSON', async () => {
    const plugin = new MockRemNotePlugin();
    plugin.addTestRem('child', 'Child');
    const notes = adapter(plugin);
    const read = await notes.readNotes({ remIds: ['__proto__', 'child'], contentMode: 'none' });
    const listed = await notes.listChildrenMany({ parentRemIds: ['__proto__'] });
    const readJson = JSON.parse(JSON.stringify(read)) as {
      results: Record<string, { error?: string; remId?: string; title?: string }>;
    };
    const listedJson = JSON.parse(JSON.stringify(listed)) as {
      results: Record<string, { error?: string }>;
    };
    expect(Object.hasOwn(read.results, '__proto__')).toBe(true);
    expect(Object.hasOwn(readJson.results, '__proto__')).toBe(true);
    expect(readJson.results['__proto__']).toEqual({ error: 'Note not found: __proto__' });
    expect(readJson.results.child).toMatchObject({ remId: 'child', title: 'Child' });
    expect(Object.hasOwn(listed.results, '__proto__')).toBe(true);
    expect(listedJson.results['__proto__']).toEqual({
      error: 'Parent note not found: __proto__',
    });
    expect(Object.prototype).not.toHaveProperty('error');
  });

  it('prints every multi-read result and exits nonzero when one id fails', async () => {
    vi.spyOn(DirectClient.prototype, 'execute').mockResolvedValue({
      results: {
        a: { remId: 'a', title: 'A' },
        b: { error: 'Note not found: b' },
      },
    });
    vi.spyOn(DirectClient.prototype, 'close').mockResolvedValue(undefined);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    await createProgram('0.1.0-test').parseAsync(['node', 'remnote-cli', 'read', 'a', 'b'], {
      from: 'node',
    });
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(logs.join('\n')).results).toMatchObject({
      a: { title: 'A' },
      b: { error: 'Note not found: b' },
    });
  });
});
