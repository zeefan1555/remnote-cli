import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CliTestClient } from '../../integration/cli/cli-test-client.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
beforeEach(() => vi.mocked(spawn).mockReset());

function childProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
  return proc;
}

async function close(proc: ReturnType<typeof childProcess>, code: number | null) {
  const ended = Promise.all([once(proc.stdout, 'end'), once(proc.stderr, 'end')]);
  proc.stdout.end();
  proc.stderr.end();
  await ended;
  proc.emit('close', code);
}

describe('CLI integration output capture', () => {
  for (const stream of ['stdout', 'stderr'] as const) {
    it.each([
      { text: '测', split: 1 },
      { text: '测', split: 2 },
      { text: '😀', split: 1 },
      { text: '😀', split: 2 },
      { text: '😀', split: 3 },
    ])(`decodes ${stream} across UTF-8 byte boundary $split in $text`, async ({ text, split }) => {
      const proc = childProcess();
      const pending = new CliTestClient().run(['status'], 1234);
      proc.stdout.write(' \n{"value":"');
      proc.stderr.write(' \n');
      const bytes = Buffer.from(text);
      proc[stream].write(bytes.subarray(0, split));
      proc[stream].write(bytes.subarray(split));
      proc.stdout.write('"} \n');
      proc.stderr.write(' \n');
      await close(proc, 0);
      const value = stream === 'stdout' ? text : '';
      expect(await pending).toEqual({
        stdout: JSON.stringify({ value }),
        stderr: stream === 'stderr' ? text : '',
        exitCode: 0,
        json: { value },
      });
      expect(vi.mocked(spawn).mock.calls[0][2]?.timeout).toBe(1234);
    });

    it(`flushes an incomplete ${stream} UTF-8 sequence at EOF`, async () => {
      const proc = childProcess();
      const pending = new CliTestClient().run(['status']);
      proc[stream].write(Buffer.from([0xe6, 0xb5]));
      await close(proc, 7);
      expect(await pending).toEqual({
        stdout: stream === 'stdout' ? '\uFFFD' : '',
        stderr: stream === 'stderr' ? '\uFFFD' : '',
        exitCode: 7,
        json: null,
      });
    });
  }

  it('keeps independent decoder state when both streams interleave one-byte chunks', async () => {
    const proc = childProcess();
    const pending = new CliTestClient().run(['status']);
    const stdout = JSON.stringify({ value: 'A测😀Z' });
    const stderr = 'B😀测Y';
    const outBytes = Buffer.from(stdout),
      errBytes = Buffer.from(stderr);
    for (let i = 0; i < Math.max(outBytes.length, errBytes.length); i++) {
      if (i < outBytes.length) proc.stdout.write(outBytes.subarray(i, i + 1));
      if (i < errBytes.length) proc.stderr.write(errBytes.subarray(i, i + 1));
    }
    await close(proc, 2);
    expect(await pending).toEqual({ stdout, stderr, exitCode: 2, json: { value: 'A测😀Z' } });
  });

  it.each([0, 9, null])('preserves empty output and close exit code %s', async (code) => {
    const proc = childProcess();
    const pending = new CliTestClient().run(['status']);
    await close(proc, code);
    expect(await pending).toEqual({ stdout: '', stderr: '', exitCode: code ?? 1, json: null });
    expect(vi.mocked(spawn).mock.calls[0][2]?.timeout).toBe(70000);
  });

  it('rejects a process error without inventing an exit result', async () => {
    const proc = childProcess();
    const pending = new CliTestClient().run(['status']);
    const expected = expect(pending).rejects.toThrow('synthetic spawn failure');
    proc.emit('error', new Error('synthetic spawn failure'));
    await expected;
    proc.stdout.destroy();
    proc.stderr.destroy();
  });
});
