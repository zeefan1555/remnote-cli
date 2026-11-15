import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, '..', '..', '..');
const cliBin = join(projectRoot, 'dist', 'remnote-cli', 'index.js');

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  json: unknown;
}

/**
 * Spawns CLI commands and captures output.
 * All commands use --json by default for machine-parseable output.
 */
export class CliTestClient {
  /**
   * Run a CLI command and return the result.
   */
  async run(args: string[]): Promise<CliResult> {
    const fullArgs = [cliBin, '--json', ...args];

    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, fullArgs, {
        cwd: projectRoot,
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.setEncoding('utf8').on('data', (data) => (stdout += data));
      proc.stderr.setEncoding('utf8').on('data', (data) => (stderr += data));

      proc.on('close', (code, signal) => {
        if (signal || code === null) {
          const reason = signal
            ? `terminated by signal ${signal}`
            : 'closed without an exit code or signal';
          stderr = [
            stderr.trim(),
            `CLI process ${reason}; write outcomes may be unknown. Do not automatically retry.`,
          ]
            .filter(Boolean)
            .join('\n');
        }
        let json: unknown = null;
        try {
          json = JSON.parse(stdout.trim());
        } catch {
          // Not JSON output
        }
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code,
          signal,
          json,
        });
      });

      proc.on('error', reject);
    });
  }

  /**
   * Run a CLI command and expect JSON output. Throws if exit code != 0.
   */
  async runExpectSuccess(args: string[]): Promise<unknown> {
    const result = await this.run(args);
    if (result.exitCode === null) throw new Error(result.stderr);
    if (result.exitCode !== 0) {
      throw new Error(`CLI exited with code ${result.exitCode}: ${result.stderr || result.stdout}`);
    }
    if (result.json === null) {
      throw new Error(`Expected JSON output, got: ${result.stdout}`);
    }
    return result.json;
  }

  /**
   * Run a CLI command and expect ordinary failure (non-zero exit code, not a signal).
   */
  async runExpectError(args: string[]): Promise<CliResult> {
    const result = await this.run(args);
    if (result.exitCode === null) throw new Error(result.stderr);
    if (result.exitCode === 0) {
      throw new Error(`Expected non-zero exit code, got 0. Output: ${result.stdout}`);
    }
    return result;
  }
}
