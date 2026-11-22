import type { Command } from 'commander';

export type CommandRisk = 'read' | 'write' | 'destructive';
export type BridgeRequirement = 'required' | 'optional' | 'conditional' | 'none';

export interface PaginationSpec {
  kind: 'cursor';
  automatic: boolean;
  arguments: string[];
}

export interface CommandPolicy {
  risk: CommandRisk;
  bridge: BridgeRequirement;
  dynamic?: boolean;
  pagination?: PaginationSpec;
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

export interface CommandSpec {
  path: string;
  description: string;
  usage: string;
  risk: CommandRisk;
  bridge: BridgeRequirement;
  dynamic: boolean;
  pagination?: PaginationSpec;
  input: CommandInputSchema;
  output: {
    envelope: 'remnote-cli/v2';
    successStream: 'stdout';
    failureStream: 'stderr';
  };
}

const COMMAND_POLICIES: Record<string, CommandPolicy> = {
  create: { risk: 'write', bridge: 'required' },
  search: {
    risk: 'read',
    bridge: 'required',
    pagination: {
      kind: 'cursor',
      automatic: false,
      arguments: ['all', 'max-pages', 'page-delay'],
    },
  },
  'search-by-tag': {
    risk: 'read',
    bridge: 'required',
    pagination: {
      kind: 'cursor',
      automatic: false,
      arguments: ['all', 'max-pages', 'page-delay'],
    },
  },
  'list-children': {
    risk: 'read',
    bridge: 'required',
    pagination: {
      kind: 'cursor',
      automatic: false,
      arguments: ['all', 'max-pages', 'page-delay'],
    },
  },
  read: { risk: 'read', bridge: 'required' },
  inspect: { risk: 'read', bridge: 'required' },
  assert: { risk: 'read', bridge: 'optional' },
  powerup: { risk: 'read', bridge: 'none' },
  'powerup get': { risk: 'read', bridge: 'required' },
  context: { risk: 'read', bridge: 'required' },
  verify: { risk: 'read', bridge: 'none' },
  'verify scope': { risk: 'read', bridge: 'required' },
  flashcards: { risk: 'read', bridge: 'none' },
  'flashcards apply': { risk: 'write', bridge: 'required' },
  wiki: { risk: 'read', bridge: 'none' },
  'wiki apply': { risk: 'write', bridge: 'required' },
  batch: { risk: 'destructive', bridge: 'conditional' },
  'review-stats': { risk: 'read', bridge: 'required' },
  outline: { risk: 'read', bridge: 'none' },
  'outline collapse': { risk: 'write', bridge: 'required' },
  'outline expand': { risk: 'write', bridge: 'required' },
  todo: { risk: 'read', bridge: 'none' },
  'todo list': { risk: 'read', bridge: 'required' },
  'todo complete': { risk: 'write', bridge: 'required' },
  'todo reopen': { risk: 'write', bridge: 'required' },
  sdk: { risk: 'destructive', bridge: 'none', dynamic: true },
  'sdk capabilities': { risk: 'read', bridge: 'required' },
  'sdk app': { risk: 'destructive', bridge: 'required', dynamic: true },
  'sdk card': { risk: 'destructive', bridge: 'required', dynamic: true },
  'sdk date': { risk: 'destructive', bridge: 'required', dynamic: true },
  'sdk editor': { risk: 'destructive', bridge: 'required', dynamic: true },
  'sdk event': { risk: 'destructive', bridge: 'required', dynamic: true },
  'sdk focus': { risk: 'destructive', bridge: 'required', dynamic: true },
  'sdk kb': { risk: 'destructive', bridge: 'required', dynamic: true },
  'sdk messaging': { risk: 'destructive', bridge: 'required', dynamic: true },
  'sdk powerup': { risk: 'destructive', bridge: 'required', dynamic: true },
  'sdk queue': { risk: 'destructive', bridge: 'required', dynamic: true },
  'sdk reader': { risk: 'destructive', bridge: 'required', dynamic: true },
  'sdk rem': { risk: 'destructive', bridge: 'required', dynamic: true },
  'sdk rich-text': { risk: 'destructive', bridge: 'required', dynamic: true },
  'sdk scheduler': { risk: 'destructive', bridge: 'required', dynamic: true },
  'sdk search': { risk: 'destructive', bridge: 'required', dynamic: true },
  'sdk settings': { risk: 'destructive', bridge: 'required', dynamic: true },
  'sdk storage': { risk: 'destructive', bridge: 'required', dynamic: true },
  'sdk widget': { risk: 'destructive', bridge: 'required', dynamic: true },
  'sdk window': { risk: 'destructive', bridge: 'required', dynamic: true },
  'get-media': { risk: 'write', bridge: 'required' },
  update: { risk: 'write', bridge: 'required' },
  'insert-children': { risk: 'write', bridge: 'required' },
  'move-note': { risk: 'destructive', bridge: 'required' },
  'set-document-status': { risk: 'write', bridge: 'required' },
  'replace-children': { risk: 'destructive', bridge: 'required' },
  'update-tags': { risk: 'write', bridge: 'required' },
  'set-property': { risk: 'write', bridge: 'required' },
  journal: { risk: 'write', bridge: 'required' },
  status: { risk: 'read', bridge: 'required' },
  'read-table': { risk: 'read', bridge: 'required' },
  sync: { risk: 'read', bridge: 'none' },
  'sync plan': { risk: 'read', bridge: 'required' },
  'sync apply': { risk: 'write', bridge: 'required' },
  'sync resume': { risk: 'write', bridge: 'required' },
  'sync delete': { risk: 'destructive', bridge: 'required' },
  'sync relocate': { risk: 'write', bridge: 'none' },
  'sync read': { risk: 'read', bridge: 'none' },
  'sync save': { risk: 'write', bridge: 'none' },
  'sync import': { risk: 'write', bridge: 'required' },
  'sync status': { risk: 'read', bridge: 'none' },
  'sync lint': { risk: 'read', bridge: 'none' },
  'sync diff': { risk: 'read', bridge: 'none' },
  'sync recover': { risk: 'write', bridge: 'required' },
  'sync format': { risk: 'write', bridge: 'none' },
  doctor: { risk: 'read', bridge: 'optional' },
  contract: { risk: 'read', bridge: 'none' },
  schema: { risk: 'read', bridge: 'none' },
};

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

function collect(
  program: Command,
  command: Command,
  prefix: string[],
  output: CommandSpec[]
): void {
  for (const child of command.commands) {
    if (child.name() === 'help') continue;
    const pathParts = [...prefix, child.name()];
    const path = pathParts.join(' ');
    if (!Object.hasOwn(COMMAND_POLICIES, path)) throw new Error('Missing command policy: ' + path);
    const policy = COMMAND_POLICIES[path];
    output.push({
      path,
      description: child.description(),
      usage: usage(path, child),
      risk: policy.risk,
      bridge: policy.bridge,
      dynamic: policy.dynamic ?? false,
      ...(policy.pagination === undefined ? {} : { pagination: policy.pagination }),
      input: inputSchema(program, child),
      output: {
        envelope: 'remnote-cli/v2',
        successStream: 'stdout',
        failureStream: 'stderr',
      },
    });
    collect(program, child, pathParts, output);
  }
}

export function buildCommandSpecs(program: Command): CommandSpec[] {
  const output: CommandSpec[] = [];
  collect(program, program, [], output);
  const registered = new Set(output.map((spec) => spec.path));
  const orphaned = Object.keys(COMMAND_POLICIES).filter((path) => !registered.has(path));
  if (orphaned.length > 0)
    throw new Error('Command policy has no registered command: ' + orphaned.join(', '));
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

export function commandSpec(input: CommandSpec[], path: string): CommandSpec {
  const found = input.find((candidate) => candidate.path === path);
  if (!found) throw new Error('Unknown command schema: ' + path);
  return found;
}
