import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Command } from 'commander';
import { createCommandClient, runWithCommandClient } from '../client/command-client.js';
import {
  CLI_ERROR_TYPES,
  CliFailure,
  EXIT,
  errorData,
  type CliErrorData,
  type CliErrorType,
} from '../output/errors.js';
import { formatResult, type OutputFormat } from '../output/formatter.js';
import { createBufferedRuntime, emit, fail } from '../output/runtime.js';
import { createProgram, runProgram } from '../cli.js';
import type { CommandCatalog } from '../spec/command-spec.js';

const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_BATCH_COMMANDS = 100;
const CONNECTION_FLAGS = ['--kb-id', '--allow-destructive', '--verbose'];

export interface BatchCommandResult {
  index: number;
  argv: string[];
  ok: boolean;
  exitCode: number;
  result?: unknown;
  error?: CliErrorData;
}

export interface BatchOutput {
  schemaVersion: 2;
  count: number;
  ok: boolean;
  stoppedEarly: boolean;
  results: BatchCommandResult[];
}

interface BatchItem {
  argv: string[];
}

interface ParsedOutput {
  result?: unknown;
  error?: CliErrorData;
}

async function readBatch(pathOrDash: string, stdin: Readable = process.stdin): Promise<string> {
  if (pathOrDash === '-') {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > MAX_BATCH_BYTES) throw new Error('Batch input exceeds 1 MB limit');
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const buffer = await readFile(pathOrDash);
  if (buffer.byteLength > MAX_BATCH_BYTES) throw new Error('Batch input exceeds 1 MB limit');
  return buffer.toString('utf8');
}

function commandItem(value: unknown): BatchItem {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Each batch command must be an object with an argv string array');
  const argv = (value as { argv?: unknown }).argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((arg) => typeof arg !== 'string'))
    throw new Error('Each batch command needs a non-empty argv string array');
  return { argv };
}

export function parseBatchInput(text: string): BatchItem[] {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Batch input is empty');
  let commands: BatchItem[];
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (Array.isArray(value)) commands = value.map(commandItem);
    else if (
      value &&
      typeof value === 'object' &&
      Array.isArray((value as { commands?: unknown }).commands)
    )
      commands = (value as { commands: unknown[] }).commands.map(commandItem);
    else commands = [commandItem(value)];
  } catch (error) {
    if (error instanceof SyntaxError) {
      const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
      commands = lines.map((line, index) => {
        try {
          return commandItem(JSON.parse(line));
        } catch {
          throw new Error('Invalid JSONL batch command on line ' + (index + 1));
        }
      });
    } else throw error;
  }
  if (commands.length === 0) throw new Error('Batch input contains no commands');
  if (commands.length > MAX_BATCH_COMMANDS)
    throw new Error('Batch input exceeds ' + MAX_BATCH_COMMANDS + ' commands');
  return commands;
}

function argvProblem(argv: string[]): CliErrorData | undefined {
  if (argv[0] === 'batch')
    return errorData(
      new CliFailure('usage', 'nested_batch', 'batch cannot contain another batch command')
    );
  for (const arg of argv) {
    if (arg === '-')
      return errorData(
        new CliFailure('usage', 'batch_stdin', 'Batch commands cannot read stdin; pass file paths')
      );
    const flag = arg.split('=', 1)[0];
    if (CONNECTION_FLAGS.includes(flag))
      return errorData(
        new CliFailure(
          'usage',
          'connection_flag_scope',
          flag + ' belongs on the batch command, not an inner command'
        )
      );
  }
  return undefined;
}

function isCliErrorType(value: unknown): value is CliErrorType {
  return typeof value === 'string' && CLI_ERROR_TYPES.some((candidate) => candidate === value);
}

function parseCliError(value: unknown): CliErrorData | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !isCliErrorType(record.type) ||
    typeof record.subtype !== 'string' ||
    typeof record.message !== 'string' ||
    typeof record.retryable !== 'boolean'
  )
    return undefined;
  return {
    type: record.type,
    subtype: record.subtype,
    message: record.message,
    ...(typeof record.hint === 'string' ? { hint: record.hint } : {}),
    retryable: record.retryable,
    ...(record.details === undefined ? {} : { details: record.details }),
  };
}

function parseOutput(text: string): ParsedOutput {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text.length === 0 ? {} : { result: text };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { result: value };
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 2) return { result: value };
  if (record.ok === true && Object.hasOwn(record, 'data')) return { result: record.data };
  if (record.ok === false) {
    const error = parseCliError(record.error);
    if (error) return { error };
  }
  return { result: value };
}

async function runArgv(
  argv: string[],
  index: number,
  version: string
): Promise<BatchCommandResult> {
  const problem = argvProblem(argv);
  if (problem) return { index, argv, ok: false, exitCode: EXIT.USAGE, error: problem };

  const runtime = createBufferedRuntime('json');
  const program = createProgram(version, runtime);
  const exitCode = await runProgram(program, ['node', 'remnote-cli', ...argv], runtime);
  const stdout = runtime.stdout().trim();
  const stderr = runtime.stderr().trim();
  const ok = exitCode === EXIT.SUCCESS;
  const parsedStdout = parseOutput(stdout);
  const parsedStderr = parseOutput(stderr);
  const parsed = !ok && parsedStderr.error ? parsedStderr : parsedStdout;
  const fallbackError =
    ok || stderr.length === 0
      ? undefined
      : errorData(new CliFailure('internal', 'batch_command_failed', stderr));
  return {
    index,
    argv,
    ok,
    exitCode,
    ...(parsed.result === undefined ? {} : { result: parsed.result }),
    ...(!ok && (parsed.error ?? fallbackError) ? { error: parsed.error ?? fallbackError } : {}),
  };
}

function formatBatchText(data: unknown): string {
  const batch = data as BatchOutput;
  return batch.results
    .map((item) => {
      const body =
        item.error !== undefined
          ? JSON.stringify(item.error, null, 2)
          : item.result === undefined
            ? ''
            : JSON.stringify(item.result, null, 2);
      return (
        '[' +
        item.index +
        '] exit ' +
        item.exitCode +
        ' ' +
        item.argv.join(' ') +
        (body ? '\n' + body : '')
      );
    })
    .join('\n\n');
}

export function registerBatchCommand(
  program: Command,
  catalog: CommandCatalog,
  version: string
): void {
  catalog
    .action(program, 'batch', {
      description: 'Run multiple commands over one bridge connection',
      risk: 'destructive',
      bridge: 'conditional',
    })
    .requiredOption(
      '--file <path|->',
      'JSON array, {commands:[{argv}]}, or JSONL of {argv} objects'
    )
    .option('--stop-on-error', 'Stop after the first command that fails')
    .addHelpText(
      'after',
      [
        '',
        'Each command is {"argv":["read","REM_ID"]}. argv is the command and its arguments, not the remnote-cli program name.',
        'A JSON array, a {commands:[...]} object, one JSON object, or JSONL (one object per line) are accepted.',
        'Connection flags (--kb-id, --allow-destructive, --verbose) belong on batch. Inner commands must not read stdin.',
        'batch --allow-destructive authorizes inner sdk calls. An inner argv that repeats the flag is rejected.',
        'Help, --version, and usage errors are per-command results. Exit code 0 is success and its text stays inside result.',
        'A failing command does not abort the rest of the batch unless --stop-on-error is set. The bridge closes afterwards.',
        'One loopback listener serves every command, in order. Later commands see earlier writes. Results are returned per command.',
        'Exit 0 only when every executed command succeeds. --stop-on-error keeps the results collected so far.',
        'Single-id read and list-children keep their existing JSON shape. Several IDs return results keyed by ID.',
      ].join('\n')
    )
    .action(async (opts: { file: string; stopOnError?: boolean }) => {
      const format: OutputFormat = program.opts().text ? 'text' : 'json';
      const client = createCommandClient(program);
      client.retain();
      try {
        const commands = parseBatchInput(await readBatch(opts.file));
        const results: BatchCommandResult[] = [];
        let stoppedEarly = false;
        await runWithCommandClient(client, async () => {
          for (let index = 0; index < commands.length; index++) {
            const item = await runArgv(commands[index].argv, index, version);
            results.push(item);
            if (!item.ok && opts.stopOnError) {
              stoppedEarly = index < commands.length - 1;
              break;
            }
          }
        });
        const output: BatchOutput = {
          schemaVersion: 2,
          count: results.length,
          ok: results.every((item) => item.ok),
          stoppedEarly,
          results,
        };
        if (output.ok) {
          const rendered =
            format === 'json'
              ? formatResult(output, 'json')
              : formatResult(output, 'text', formatBatchText);
          emit(program, rendered);
        } else {
          const unknown = results.some((item) => item.error?.type === 'unknown_outcome');
          fail(
            program,
            new CliFailure(
              unknown ? 'unknown_outcome' : 'conflict',
              unknown ? 'batch_write_unknown' : 'batch_failed',
              'One or more batch commands failed',
              { details: output, retryable: false }
            )
          );
        }
      } finally {
        client.release();
        await client.close();
      }
    });
}
