import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Command, CommanderError } from 'commander';
import { createCommandClient, runWithCommandClient } from '../client/command-client.js';
import { EXIT } from '../config.js';
import { formatError, formatResult, type OutputFormat } from '../output/formatter.js';

const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_BATCH_COMMANDS = 100;
const CONNECTION_FLAGS = ['--port', '--kb-id', '--allow-destructive', '--verbose'];

export interface BatchCommandResult {
  index: number;
  argv: string[];
  ok: boolean;
  exitCode: number;
  result?: unknown;
  error?: string;
}

export interface BatchOutput {
  schemaVersion: 1;
  count: number;
  ok: boolean;
  stoppedEarly: boolean;
  results: BatchCommandResult[];
}

interface BatchItem {
  argv: string[];
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
          throw new Error(`Invalid JSONL batch command on line ${index + 1}`);
        }
      });
    } else throw error;
  }
  if (commands.length === 0) throw new Error('Batch input contains no commands');
  if (commands.length > MAX_BATCH_COMMANDS)
    throw new Error(`Batch input exceeds ${MAX_BATCH_COMMANDS} commands`);
  return commands;
}

function argvProblem(argv: string[]): string | undefined {
  if (argv[0] === 'batch') return 'batch cannot contain another batch command';
  for (const arg of argv) {
    if (arg === '-') return 'Batch commands cannot read stdin; pass file paths';
    const flag = arg.split('=', 1)[0];
    if (CONNECTION_FLAGS.includes(flag))
      return `${flag} belongs on the batch command, not an inner command`;
  }
  return undefined;
}

/**
 * `.command()` copies `_exitCallback` and the output writers at creation time.
 * Setting them only on the root leaves subcommand help and usage errors on `process.exit`.
 */
function bindCommand(
  command: Command,
  writeOut: (text: string) => void,
  writeErr: (text: string) => void
): void {
  command.exitOverride();
  command.configureOutput({ writeOut, writeErr });
  for (const child of command.commands) bindCommand(child, writeOut, writeErr);
}

async function runArgv(
  argv: string[],
  index: number,
  version: string
): Promise<BatchCommandResult> {
  const problem = argvProblem(argv);
  if (problem) return { index, argv, ok: false, exitCode: EXIT.ERROR, error: problem };
  let stdout = '';
  let stderr = '';
  const previousExit = process.exitCode;
  process.exitCode = undefined;
  const log = console.log;
  const errorLog = console.error;
  console.log = (...args: unknown[]) => {
    stdout += `${args.map((value) => String(value)).join(' ')}\n`;
  };
  console.error = (...args: unknown[]) => {
    stderr += `${args.map((value) => String(value)).join(' ')}\n`;
  };
  let thrown: unknown;
  try {
    const { createProgram } = await import('../cli.js');
    const program = createProgram(version);
    bindCommand(
      program,
      (text) => {
        stdout += text;
      },
      (text) => {
        stderr += text;
      }
    );
    await program.parseAsync(['node', 'remnote-cli', ...argv], { from: 'node' });
  } catch (error) {
    thrown = error;
  } finally {
    console.log = log;
    console.error = errorLog;
  }
  const commanderCode = thrown instanceof CommanderError ? thrown.exitCode : undefined;
  const exitCode = commanderCode ?? process.exitCode ?? (thrown ? EXIT.ERROR : EXIT.SUCCESS);
  process.exitCode = previousExit;
  const text = stdout.trim();
  let result: unknown = text.length > 0 ? text : undefined;
  if (text) {
    try {
      result = JSON.parse(text);
    } catch {
      result = text;
    }
  }
  const thrownText =
    thrown instanceof CommanderError && thrown.exitCode === EXIT.SUCCESS
      ? ''
      : thrown instanceof Error
        ? thrown.message
        : thrown
          ? String(thrown)
          : '';
  const errorText = [stderr.trim(), thrownText && !stderr.includes(thrownText) ? thrownText : '']
    .filter(Boolean)
    .join('\n');
  const ok = exitCode === EXIT.SUCCESS;
  return {
    index,
    argv,
    ok,
    exitCode,
    ...(result !== undefined ? { result } : {}),
    ...(!ok && errorText ? { error: errorText } : {}),
  };
}

function formatBatchText(data: unknown): string {
  const batch = data as BatchOutput;
  return batch.results
    .map((item) => {
      const body =
        item.error ?? (item.result === undefined ? '' : JSON.stringify(item.result, null, 2));
      return `[${item.index}] exit ${item.exitCode} ${item.argv.join(' ')}${body ? `\n${body}` : ''}`;
    })
    .join('\n\n');
}

export function registerBatchCommand(program: Command, version: string): void {
  program
    .command('batch')
    .description('Run multiple commands over one bridge connection')
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
        'Connection flags (--port, --kb-id, --allow-destructive, --verbose) belong on batch. Inner commands must not read stdin.',
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
          schemaVersion: 1,
          count: results.length,
          ok: results.every((item) => item.ok),
          stoppedEarly,
          results,
        };
        console.log(formatResult(output, format, formatBatchText));
        if (!output.ok) process.exitCode = EXIT.ERROR;
      } catch (error) {
        console.error(formatError(error instanceof Error ? error.message : String(error), format));
        process.exitCode = EXIT.ERROR;
      } finally {
        client.release();
        await client.close();
      }
    });
}
