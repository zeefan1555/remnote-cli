import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliTestClient } from '../../integration/cli/cli-test-client.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
beforeEach(() => vi.mocked(spawn).mockReset());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function childProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
  return proc;
}

async function close(
  proc: ReturnType<typeof childProcess>,
  code: number | null,
  signal: NodeJS.Signals | null = null
) {
  const ended = Promise.all([once(proc.stdout, 'end'), once(proc.stderr, 'end')]);
  proc.stdout.end();
  proc.stderr.end();
  await ended;
  proc.emit('close', code, signal);
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
      const pending = new CliTestClient().run(['status']);
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
        signal: null,
        json: { value },
      });
      expect(vi.mocked(spawn).mock.calls[0][2]).not.toHaveProperty('timeout');
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
        signal: null,
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
    expect(await pending).toEqual({
      stdout,
      stderr,
      exitCode: 2,
      signal: null,
      json: { value: 'A测😀Z' },
    });
  });

  it.each([0, 9])('preserves empty output and close exit code %s', async (code) => {
    const proc = childProcess();
    const pending = new CliTestClient().run(['status']);
    await close(proc, code);
    expect(await pending).toEqual({
      stdout: '',
      stderr: '',
      exitCode: code,
      signal: null,
      json: null,
    });
    expect(vi.mocked(spawn).mock.calls[0][2]).not.toHaveProperty('timeout');
  });

  it('does not kill a pending command after the old 70-second process timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const proc = childProcess();
    vi.mocked(spawn).mockImplementationOnce((_command, _args, options) => {
      if (options?.timeout) setTimeout(() => proc.kill('SIGTERM'), options.timeout);
      return proc as unknown as ReturnType<typeof spawn>;
    });
    const pending = new CliTestClient().run(['sync', 'apply', 'synthetic-vault']);
    const settled = vi.fn();
    void pending.then(settled);
    await vi.advanceTimersByTimeAsync(70_001);
    expect(settled).not.toHaveBeenCalled();
    await close(proc, 0);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(await pending).toMatchObject({ exitCode: 0, signal: null });
    expect(vi.mocked(spawn).mock.calls[0][2]).not.toHaveProperty('timeout');
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'preserves %s and partial output in the receipt',
    async (signal) => {
      const proc = childProcess();
      const pending = new CliTestClient().run(['status']);
      proc.stdout.write('{"partial":true}');
      proc.stderr.write('original diagnostic');
      await close(proc, null, signal);
      const result = await pending;
      expect(result).toMatchObject({
        stdout: '{"partial":true}',
        exitCode: null,
        signal,
        json: { partial: true },
      });
      expect(result.stderr).toContain('original diagnostic');
      expect(result.stderr).toContain(`terminated by signal ${signal}`);
      expect(result.stderr).toContain('Do not automatically retry');
    }
  );

  it('retains an unknown close outcome instead of inventing exit code 1', async () => {
    const proc = childProcess();
    const pending = new CliTestClient().run(['status']);
    await close(proc, null);
    expect(await pending).toMatchObject({
      exitCode: null,
      signal: null,
      stderr: expect.stringContaining('without an exit code or signal'),
    });
  });

  it('reports signal termination from runExpectSuccess even with valid JSON output', async () => {
    const proc = childProcess();
    const pending = new CliTestClient().runExpectSuccess(['status']);
    const expected = expect(pending).rejects.toThrow('terminated by signal SIGTERM');
    proc.stdout.write('{"ok":true}');
    await close(proc, null, 'SIGTERM');
    await expected;
  });

  it('does not accept signal termination as an expected ordinary command error', async () => {
    const proc = childProcess();
    const pending = new CliTestClient().runExpectError(['unknown-command']);
    const expected = expect(pending).rejects.toThrow('terminated by signal SIGTERM');
    await close(proc, null, 'SIGTERM');
    await expected;
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

describe('integration --command exit reporting', () => {
  it.each([
    { code: 7, signal: null, expectedCode: 7 },
    { code: null, signal: 'SIGTERM' as const, expectedCode: 143 },
    { code: null, signal: null, expectedCode: 1 },
  ])(
    'reports close $code / $signal without losing the cause',
    async ({ code, signal, expectedCode }) => {
      const argv = process.argv;
      const exitCode = process.exitCode;
      const proc = childProcess();
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        process.argv = [process.execPath, 'synthetic-runner', '--yes', '--command', 'status'];
        process.exitCode = 0;
        vi.resetModules();
        await import('../../integration/cli/run-integration.js');
        await close(proc, code, signal);
        await Promise.resolve();
        expect(process.exitCode).toBe(expectedCode);
        if (signal) expect(error).toHaveBeenCalledWith(expect.stringContaining(signal));
        else if (code === null)
          expect(error).toHaveBeenCalledWith(
            expect.stringContaining('without an exit code or signal')
          );
        else expect(error).not.toHaveBeenCalled();
      } finally {
        process.argv = argv;
        process.exitCode = exitCode;
      }
    }
  );
});
