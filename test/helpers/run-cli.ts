import { createProgram, runProgram } from '../../src/remnote-cli/cli.js';
import { createBufferedRuntime } from '../../src/remnote-cli/output/runtime.js';

export interface RunCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCliForTest(args: string[]): Promise<RunCliResult> {
  const runtime = createBufferedRuntime(args.includes('--text') ? 'text' : 'json');
  const program = createProgram('0.1.0-test', runtime);
  const exitCode = await runProgram(program, ['node', 'remnote-cli', ...args], runtime);
  return {
    stdout: runtime.stdout(),
    stderr: runtime.stderr(),
    exitCode,
  };
}

export function parseSuccess(stdout: string): unknown {
  const value: unknown = JSON.parse(stdout);
  if (
    !value ||
    typeof value !== 'object' ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 2 ||
    !('ok' in value) ||
    value.ok !== true ||
    !('data' in value)
  )
    throw new Error('Expected a successful CLI envelope');
  return value.data;
}

export function parseFailure(stdout: string): {
  type: string;
  subtype: string;
  message: string;
  retryable: boolean;
  details?: unknown;
} {
  const value: unknown = JSON.parse(stdout);
  if (
    !value ||
    typeof value !== 'object' ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 2 ||
    !('ok' in value) ||
    value.ok !== false ||
    !('error' in value) ||
    !value.error ||
    typeof value.error !== 'object' ||
    !('type' in value.error) ||
    typeof value.error.type !== 'string' ||
    !('subtype' in value.error) ||
    typeof value.error.subtype !== 'string' ||
    !('message' in value.error) ||
    typeof value.error.message !== 'string' ||
    !('retryable' in value.error) ||
    typeof value.error.retryable !== 'boolean'
  )
    throw new Error('Expected a failed CLI envelope');
  return {
    type: value.error.type,
    subtype: value.error.subtype,
    message: value.error.message,
    retryable: value.error.retryable,
    ...('details' in value.error ? { details: value.error.details } : {}),
  };
}
