import type { Command } from 'commander';
import { asCliFailure, errorData, exitCodeForFailure, type CliFailure, EXIT } from './errors.js';
import type { OutputFormat } from './formatter.js';
import { sanitizeTerminalText } from './formatter.js';

export interface CliRuntimeIO {
  out(text: string): void;
  err(text: string): void;
  setExitCode(code: number): void;
}

export interface CliRuntime {
  readonly format: OutputFormat;
  setFormat(format: OutputFormat): void;
  out(text: string): void;
  err(text: string): void;
  setExitCode(code: number): void;
  getExitCode(): number | undefined;
  success(data: unknown, textFormatter?: (data: unknown) => string): void;
  failure(error: unknown): CliFailure;
}

export interface BufferedCliRuntime extends CliRuntime {
  stdout(): string;
  stderr(): string;
}

class Runtime implements CliRuntime {
  private currentFormat: OutputFormat;
  private exitCode: number | undefined;

  constructor(
    initialFormat: OutputFormat,
    private readonly io: CliRuntimeIO
  ) {
    this.currentFormat = initialFormat;
  }

  get format(): OutputFormat {
    return this.currentFormat;
  }

  setFormat(format: OutputFormat): void {
    this.currentFormat = format;
  }

  out(text: string): void {
    this.io.out(text);
  }

  err(text: string): void {
    this.io.err(text);
  }

  setExitCode(code: number): void {
    this.exitCode = code;
    this.io.setExitCode(code);
  }

  getExitCode(): number | undefined {
    return this.exitCode;
  }

  success(data: unknown, textFormatter?: (data: unknown) => string): void {
    const rendered =
      this.currentFormat === 'json'
        ? JSON.stringify({ schemaVersion: 2, ok: true, data }, null, 2)
        : sanitizeTerminalText(textFormatter?.(data) ?? fallbackText(data));
    this.out(rendered + '\n');
  }

  failure(error: unknown): CliFailure {
    const failure = asCliFailure(error);
    const rendered =
      this.currentFormat === 'json'
        ? JSON.stringify(
            {
              schemaVersion: 2,
              ok: false,
              error: errorData(failure),
            },
            null,
            2
          )
        : sanitizeTerminalText(
            [
              'Error [' + failure.type + '/' + failure.subtype + ']: ' + failure.message,
              failure.hint ? 'Hint: ' + failure.hint : '',
            ]
              .filter(Boolean)
              .join('\n')
          );
    this.err(rendered + '\n');
    this.setExitCode(exitCodeForFailure(failure));
    return failure;
  }
}

function fallbackText(data: unknown): string {
  if (data === null || data === undefined) return String(data);
  if (typeof data === 'object')
    return Object.entries(data)
      .map(
        ([key, value]) =>
          key + ': ' + (typeof value === 'object' ? JSON.stringify(value) : String(value))
      )
      .join('\n');
  return String(data);
}

export function createCliRuntime(initialFormat: OutputFormat, io: CliRuntimeIO): CliRuntime {
  return new Runtime(initialFormat, io);
}

export function createProcessRuntime(initialFormat: OutputFormat = 'json'): CliRuntime {
  return createCliRuntime(initialFormat, {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    setExitCode: (code) => {
      process.exitCode = code;
    },
  });
}

export function createBufferedRuntime(initialFormat: OutputFormat = 'json'): BufferedCliRuntime {
  let stdout = '';
  let stderr = '';
  let exitCode: number | undefined;
  const runtime = createCliRuntime(initialFormat, {
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  return {
    ...runtime,
    get format() {
      return runtime.format;
    },
    out: (text) => runtime.out(text),
    err: (text) => runtime.err(text),
    setFormat: (format) => runtime.setFormat(format),
    setExitCode: (code) => runtime.setExitCode(code),
    getExitCode: () => exitCode ?? runtime.getExitCode(),
    success: (data, textFormatter) => runtime.success(data, textFormatter),
    failure: (error) => runtime.failure(error),
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

const runtimes = new WeakMap<Command, CliRuntime>();

function configureCommandTree(command: Command, runtime: CliRuntime): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (text) => runtime.out(text),
    writeErr: () => undefined,
  });
  for (const child of command.commands) configureCommandTree(child, runtime);
}

export function bindRuntime(command: Command, runtime: CliRuntime): void {
  runtimes.set(command, runtime);
  command.hook('preAction', (_thisCommand, actionCommand) => {
    runtime.setFormat(actionCommand.optsWithGlobals().text ? 'text' : 'json');
    for (const key of ['kbId', 'allowDestructive']) {
      const value = actionCommand.getOptionValue(key);
      if (value !== undefined) command.setOptionValue(key, value);
    }
  });
  configureCommandTree(command, runtime);
  for (const child of command.commands) runtimes.set(child, runtime);
}

export function runtimeFor(command: Command): CliRuntime {
  let current: Command | null = command;
  while (current) {
    const runtime = runtimes.get(current);
    if (runtime) return runtime;
    current = current.parent;
  }
  throw new Error('CLI runtime is not attached to this command');
}

export function emit(command: Command, text: string): void {
  const runtime = runtimeFor(command);
  runtime.out(text.endsWith('\n') ? text : text + '\n');
}

export function fail(command: Command, error: unknown): CliFailure {
  return runtimeFor(command).failure(error);
}

export function finishProgram(runtime: CliRuntime): number {
  const exitCode = runtime.getExitCode() ?? EXIT.SUCCESS;
  runtime.setExitCode(exitCode);
  return exitCode;
}
