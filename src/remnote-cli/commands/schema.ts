import type { Command } from 'commander';
import { formatResult, type OutputFormat } from '../output/formatter.js';
import { emit } from '../output/runtime.js';
import { buildCommandSpecs, commandSpec, type CommandCatalog } from '../spec/command-spec.js';
import { CliFailure } from '../output/errors.js';

export function registerSchemaCommand(program: Command, catalog: CommandCatalog): void {
  catalog
    .action(program, 'schema [command-path...]', {
      description: 'Print the offline command schema and risk metadata',
      risk: 'read',
      bridge: 'none',
    })
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  remnote-cli schema',
        '  remnote-cli schema search',
        '  remnote-cli schema powerup get',
        '  remnote-cli schema sdk rem',
      ].join('\n')
    )
    .action((pathParts: string[] | undefined) => {
      const format: OutputFormat = program.opts().text ? 'text' : 'json';
      const specs = buildCommandSpecs(program);
      const value =
        pathParts && pathParts.length > 0
          ? commandSpecAt(specs, pathParts.join(' '))
          : {
              schemaVersion: 2,
              commands: specs.map((spec) => ({
                path: spec.path,
                kind: spec.kind,
                helpSection: spec.helpSection,
                ...(spec.kind === 'action'
                  ? {
                      risk: spec.risk,
                      bridge: spec.bridge,
                      dynamic: spec.dynamic,
                    }
                  : {}),
              })),
            };
      emit(
        program,
        formatResult(value, format, (data) => JSON.stringify(data, null, 2))
      );
    });
}

function commandSpecAt(specs: ReturnType<typeof buildCommandSpecs>, path: string) {
  try {
    return commandSpec(specs, path);
  } catch (error) {
    if (error instanceof Error)
      throw new CliFailure('usage', 'unknown_command_schema', error.message, { cause: error });
    throw error;
  }
}
