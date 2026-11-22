import type { Command } from 'commander';
import { formatResult, type OutputFormat } from '../output/formatter.js';
import { emit } from '../output/runtime.js';
import {
  buildCommandSpecs,
  commandSpec,
  type CommandCatalog,
  type BridgeRequirement,
  type CommandRisk,
  type CommandSpec,
} from '../spec/command-spec.js';
import { CliFailure } from '../output/errors.js';

function normalizePath(parts: string[] | undefined): string[] {
  return (parts ?? []).flatMap((part) => part.split('.')).filter(Boolean);
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

interface CommandTreeRow {
  name: string;
  path: string;
  kind: CommandSpec['kind'];
  description: string;
  helpSection: string;
  hidden: boolean;
  children?: CommandTreeRow[];
  risk?: CommandRisk;
  bridge?: BridgeRequirement;
  dynamic?: boolean;
}

function commandTree(specs: CommandSpec[], rootPath = ''): CommandTreeRow[] {
  const prefix = rootPath ? rootPath + ' ' : '';
  return specs
    .filter(
      (spec) =>
        spec.path.startsWith(prefix) &&
        spec.path.slice(prefix.length).split(' ').filter(Boolean).length === 1
    )
    .map((spec) => ({
      name: spec.path.slice(prefix.length).split(' ').at(-1)!,
      path: spec.path,
      kind: spec.kind,
      description: spec.description,
      helpSection: spec.helpSection,
      hidden: spec.hidden,
      ...(spec.kind === 'action'
        ? { risk: spec.risk, bridge: spec.bridge, dynamic: spec.dynamic }
        : { children: commandTree(specs, spec.path) }),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function completionCandidates(specs: CommandSpec[], parts: string[]) {
  if (parts.length === 0)
    return specs
      .filter((spec) => !spec.path.includes(' ') && !spec.hidden)
      .map((spec) => ({ name: spec.path, path: spec.path, kind: spec.kind }));

  const exact = specs.find((spec) => spec.path === parts.join(' '));
  if (exact?.kind === 'group') {
    return specs
      .filter(
        (spec) =>
          spec.path.startsWith(exact.path + ' ') &&
          spec.path.slice(exact.path.length + 1).split(' ').length === 1 &&
          !spec.hidden
      )
      .map((spec) => ({
        name: spec.path.slice(exact.path.length + 1),
        path: spec.path,
        kind: spec.kind,
        description: spec.description,
      }));
  }

  const prefix = parts.at(-1) ?? '';
  const parent = parts.slice(0, -1).join(' ');
  return specs
    .filter((spec) => {
      if (spec.hidden) return false;
      if (!parent) return !spec.path.includes(' ') && spec.path.startsWith(prefix);
      return (
        spec.path.startsWith(parent + ' ') &&
        spec.path.slice(parent.length + 1).split(' ').length === 1 &&
        spec.path.slice(parent.length + 1).startsWith(prefix)
      );
    })
    .map((spec) => ({
      name: spec.path.split(' ').at(-1),
      path: spec.path,
      kind: spec.kind,
      description: spec.description,
    }));
}

export function registerSchemaCommand(program: Command, catalog: CommandCatalog): void {
  catalog
    .action(program, 'schema [command-path...]', {
      description: 'Print the offline command schema and risk metadata',
      risk: 'read',
      bridge: 'none',
    })
    .option('--tree', 'Print a hierarchical command tree')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  remnote-cli schema',
        '  remnote-cli schema search',
        '  remnote-cli schema powerup.get',
        '  remnote-cli schema powerup get',
        '  remnote-cli schema sdk --tree',
      ].join('\n')
    )
    .action((pathParts: string[] | undefined, options: { tree?: boolean }) => {
      const format: OutputFormat = program.opts().text ? 'text' : 'json';
      const specs = buildCommandSpecs(program);
      const parts = normalizePath(pathParts);
      const selected = parts.length > 0 ? commandSpecAt(specs, parts.join(' ')) : undefined;
      const value = options.tree
        ? {
            schemaVersion: 2,
            tree: commandTree(specs, selected?.kind === 'group' ? selected.path : ''),
          }
        : selected
          ? selected
          : {
              schemaVersion: 2,
              commands: specs.map((spec) => ({
                path: spec.path,
                kind: spec.kind,
                helpSection: spec.helpSection,
                hidden: spec.hidden,
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

  catalog
    .action(program, 'completion [command-path...]', {
      description: 'Print command candidates for the current path',
      risk: 'read',
      bridge: 'none',
      hidden: true,
    })
    .action((pathParts: string[] | undefined) => {
      const format: OutputFormat = program.opts().text ? 'text' : 'json';
      const specs = buildCommandSpecs(program);
      const parts = normalizePath(pathParts);
      const candidates = completionCandidates(specs, parts);
      emit(
        program,
        formatResult(
          {
            schemaVersion: 1,
            path: parts.slice(0, -1).join(' '),
            candidates,
          },
          format,
          (data) => {
            const value = data as { candidates: Array<{ name: string }> };
            return value.candidates.map((candidate) => candidate.name).join('\n');
          }
        )
      );
    });
}
