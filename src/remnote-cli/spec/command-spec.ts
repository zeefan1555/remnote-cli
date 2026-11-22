import type { Command } from 'commander';

export type CommandRisk = 'read' | 'write' | 'destructive';
export type BridgeRequirement = 'required' | 'optional' | 'conditional' | 'none';
export type RootHelpSection = 'knowledge' | 'workflows' | 'diagnostics' | 'raw-sdk';

export interface PaginationSpec {
  kind: 'cursor';
  automatic: boolean;
  arguments: string[];
}

interface PropertySchema {
  type: 'boolean' | 'string' | 'array';
  description?: string;
  items?: { type: 'string' };
  enum?: string[];
  default?: unknown;
}

export interface CommandInputSchema {
  type: 'object';
  properties: Record<string, PropertySchema>;
  required: string[];
}

interface CommandSpecBase {
  path: string;
  description: string;
  usage: string;
  helpSection: RootHelpSection;
  hidden: boolean;
  input: CommandInputSchema;
  output: {
    envelope: 'remnote-cli/v2';
    successStream: 'stdout';
    failureStream: 'stderr';
  };
}

export interface CommandGroupSpec extends CommandSpecBase {
  kind: 'group';
  bareHelp: boolean;
}

export interface CommandActionSpec extends CommandSpecBase {
  kind: 'action';
  risk: CommandRisk;
  bridge: BridgeRequirement;
  dynamic: boolean;
  pagination?: PaginationSpec;
}

export type CommandSpec = CommandGroupSpec | CommandActionSpec;

export interface CommandGroupOptions {
  description: string;
  hidden?: boolean;
}

export interface CommandActionOptions {
  description: string;
  risk: CommandRisk;
  bridge: BridgeRequirement;
  dynamic?: boolean;
  pagination?: PaginationSpec;
  hidden?: boolean;
}

interface CatalogEntry {
  command: Command;
  kind: CommandSpec['kind'];
  hidden?: boolean;
  bareHelp?: boolean;
  risk?: CommandRisk;
  bridge?: BridgeRequirement;
  dynamic?: boolean;
  pagination?: PaginationSpec;
}

const catalogs = new WeakMap<Command, CommandCatalog>();

function rootOf(command: Command): Command {
  let current = command;
  while (current.parent) current = current.parent;
  return current;
}

function pathOf(command: Command): string {
  const parts: string[] = [];
  let current: Command | null = command;
  while (current?.parent) {
    parts.unshift(current.name());
    current = current.parent;
  }
  return parts.join(' ');
}

function optionProperty(option: Command['options'][number]): PropertySchema {
  const isBoolean = !option.required && !option.optional;
  if (isBoolean)
    return {
      type: 'boolean',
      description: option.description,
      ...(option.defaultValue === undefined ? {} : { default: option.defaultValue }),
    };
  const schema: PropertySchema = {
    type: option.variadic ? 'array' : 'string',
    description: option.description,
    ...(option.variadic ? { items: { type: 'string' } } : {}),
    ...(option.argChoices === undefined ? {} : { enum: option.argChoices }),
    ...(option.defaultValue === undefined ? {} : { default: option.defaultValue }),
  };
  return schema;
}

function inputSchema(program: Command, command: Command): CommandInputSchema {
  const properties: Record<string, PropertySchema> = {};
  const required = new Set<string>();

  for (const option of program.options) {
    if (option.long === '--version' || option.long === '--help') continue;
    properties[option.attributeName()] = optionProperty(option);
  }
  for (const argument of command.registeredArguments) {
    const name = argument.name();
    properties[name] = {
      type: argument.variadic ? 'array' : 'string',
      ...(argument.variadic ? { items: { type: 'string' } } : {}),
      ...(argument.description === '' ? {} : { description: argument.description }),
    };
    if (argument.required) required.add(name);
  }
  for (const option of command.options) {
    const name = option.attributeName();
    properties[name] = optionProperty(option);
    if (option.mandatory) required.add(name);
  }

  return {
    type: 'object',
    properties,
    required: [...required].sort(),
  };
}

function usage(path: string, command: Command): string {
  const args = command.registeredArguments
    .map((argument) => {
      const token = argument.variadic ? argument.name() + '...' : argument.name();
      return argument.required ? token : '[' + token + ']';
    })
    .join(' ');
  return [path, args].filter(Boolean).join(' ');
}

export function rootHelpSection(path: string): RootHelpSection {
  const root = path.split(' ', 1)[0];
  if (root === 'sdk') return 'raw-sdk';
  if (root === 'sync') return 'workflows';
  if (['batch', 'status', 'doctor', 'schema', 'contract'].includes(root)) return 'diagnostics';
  return 'knowledge';
}

export function rootHelpLabel(section: RootHelpSection): string {
  return {
    knowledge: 'Knowledge commands:',
    workflows: 'Workflow commands:',
    diagnostics: 'Diagnostics and tooling:',
    'raw-sdk': 'Raw SDK commands:',
  }[section];
}

function commandSpecFor(program: Command, entry: CatalogEntry): CommandSpec {
  const command = entry.command;
  const path = pathOf(command);
  const base = {
    path,
    description: command.description(),
    usage: usage(path, command),
    helpSection: rootHelpSection(path),
    hidden: entry.hidden === true,
    input: inputSchema(program, command),
    output: {
      envelope: 'remnote-cli/v2' as const,
      successStream: 'stdout' as const,
      failureStream: 'stderr' as const,
    },
  };
  if (entry.kind === 'group')
    return {
      ...base,
      kind: 'group',
      bareHelp: entry.bareHelp === true,
    };
  if (!entry.risk || !entry.bridge) throw new Error('Missing command policy: ' + path);
  return {
    ...base,
    kind: 'action',
    risk: entry.risk,
    bridge: entry.bridge,
    dynamic: entry.dynamic ?? false,
    ...(entry.pagination === undefined ? {} : { pagination: entry.pagination }),
  };
}

export class CommandCatalog {
  private readonly entries = new Map<Command, CatalogEntry>();

  constructor(readonly program: Command) {
    catalogs.set(program, this);
  }

  group(parent: Command, use: string, options: CommandGroupOptions): Command {
    const command = parent
      .command(use, { hidden: options.hidden === true })
      .description(options.description);
    this.entries.set(command, {
      command,
      kind: 'group',
      hidden: options.hidden ?? false,
      bareHelp: true,
    });
    command.action(() => command.outputHelp());
    return command;
  }

  action(parent: Command, use: string, options: CommandActionOptions): Command {
    const command = parent
      .command(use, { hidden: options.hidden === true })
      .description(options.description);
    this.entries.set(command, {
      command,
      kind: 'action',
      hidden: options.hidden ?? false,
      risk: options.risk,
      bridge: options.bridge,
      dynamic: options.dynamic,
      ...(options.pagination === undefined ? {} : { pagination: options.pagination }),
    });
    return command;
  }

  specs(): CommandSpec[] {
    const output: CommandSpec[] = [];
    const visit = (command: Command): void => {
      for (const child of command.commands) {
        if (child.name() === 'help') continue;
        const entry = this.entries.get(child);
        if (!entry)
          throw new Error('Command is not registered through CommandCatalog: ' + pathOf(child));
        output.push(commandSpecFor(this.program, entry));
        visit(child);
      }
    };
    visit(this.program);

    const registered = new Set(output.map((spec) => spec.path));
    for (const [command] of this.entries) {
      const path = pathOf(command);
      if (!registered.has(path))
        throw new Error('Command catalog entry has no registered command: ' + path);
    }
    return output.sort((left, right) => left.path.localeCompare(right.path));
  }
}

function catalogFor(program: Command): CommandCatalog {
  const catalog = catalogs.get(rootOf(program));
  if (!catalog) throw new Error('Command catalog is not attached to this command tree');
  return catalog;
}

export function catalogRoot(program: Command): CommandCatalog {
  return catalogFor(program);
}

export function buildCommandSpecs(program: Command): CommandSpec[] {
  return catalogFor(program).specs();
}

export function commandSpec(input: CommandSpec[], path: string): CommandSpec {
  const found = input.find((candidate) => candidate.path === path);
  if (!found) throw new Error('Unknown command schema: ' + path);
  return found;
}
