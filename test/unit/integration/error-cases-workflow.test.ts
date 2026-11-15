import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { CliTestClient } from '../../integration/cli/cli-test-client.js';
import { errorCasesWorkflow } from '../../integration/cli/workflows/06-error-cases.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    throw new Error('Native CLI calls are forbidden in this unit test');
  }),
}));
afterEach(() => vi.restoreAllMocks());

it.each([
  { exitCode: 1, signal: null, accepted: true },
  { exitCode: 9, signal: null, accepted: true },
  { exitCode: 0, signal: null, accepted: false },
  { exitCode: null, signal: 'SIGTERM' as const, accepted: false },
  { exitCode: null, signal: null, accepted: false },
])(
  'accepts only ordinary command errors, not close $exitCode / $signal',
  async ({ exitCode, signal, accepted }) => {
    const cli = new CliTestClient();
    // Keep the real runExpectError contract; only replace the process boundary.
    const run = vi.spyOn(cli, 'run').mockResolvedValue({
      stdout: '',
      stderr: [
        signal ? `CLI process terminated by signal ${signal}` : 'synthetic diagnostic',
        '--append --title',
        'looks like a flag but was passed as an option value',
        'Alias cannot be both added and removed',
      ].join('\n'),
      exitCode,
      signal,
      // Even a previously emitted matching preview must not disguise termination.
      json: { status: 'incomplete', complete: false, created: [] },
    });
    const result = await errorCasesWorkflow({ cli, runId: 'unit-lifecycle' }, {});
    expect(result.steps).toHaveLength(11);
    expect(result.steps.filter((_, index) => index !== 3).map((step) => step.passed)).toEqual(
      Array(10).fill(accepted)
    );
    // Empty search explicitly accepts only exit 0 or 1, never null.
    expect(result.steps[3].passed).toBe(exitCode === 0 || exitCode === 1);
    if (signal) expect(result.steps[0].error).toContain(signal);
    expect(run).toHaveBeenCalledTimes(11);
    expect(spawn).not.toHaveBeenCalled();
  }
);
