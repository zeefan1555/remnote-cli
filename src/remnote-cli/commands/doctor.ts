import type { Command } from 'commander';
import { createCommandClient } from '../client/command-client.js';
import { runDoctor, type DoctorReport } from '../diagnostics/doctor.js';
import { CliFailure } from '../output/errors.js';
import { formatResult, type OutputFormat } from '../output/formatter.js';
import { emit, fail } from '../output/runtime.js';
import type { CommandCatalog } from '../spec/command-spec.js';

function formatDoctorText(data: unknown): string {
  const report = data as DoctorReport;
  return [
    ...report.checks.map(
      (check) => '[' + check.status.toUpperCase() + '] ' + check.id + ': ' + check.message
    ),
    '',
    'Summary: pass=' +
      report.summary.pass +
      ' warn=' +
      report.summary.warn +
      ' fail=' +
      report.summary.fail +
      ' skip=' +
      report.summary.skip,
  ].join('\n');
}

export function registerDoctorCommand(program: Command, catalog: CommandCatalog): void {
  catalog
    .action(program, 'doctor', {
      description: 'Run read-only CLI, Bridge, SDK, state and journal diagnostics',
      risk: 'read',
      bridge: 'optional',
    })
    .option('--offline', 'Check local installation and state without opening the Bridge')
    .addHelpText(
      'after',
      [
        '',
        'Doctor never writes RemNote data or local state.',
        'Exit 0 means no failing checks. Warnings and skips do not fail the command.',
        'Use --offline to inspect Node, command policy and local state without RemNote running.',
      ].join('\n')
    )
    .action(async (options: { offline?: boolean }) => {
      const format: OutputFormat = program.opts().text ? 'text' : 'json';
      const client = options.offline ? undefined : createCommandClient(program, { persist: false });
      client?.disablePersistence();
      try {
        const report = await runDoctor({
          program,
          client,
          offline: options.offline === true,
        });
        if (report.ok) emit(program, formatResult(report, format, formatDoctorText));
        else
          fail(
            program,
            new CliFailure('configuration', 'doctor_failed', 'Doctor found failing checks', {
              details: report,
            })
          );
      } finally {
        await client?.close();
      }
    });
}
