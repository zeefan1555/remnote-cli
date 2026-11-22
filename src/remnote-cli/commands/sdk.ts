import { emit } from '../output/runtime.js';
import type { Command } from 'commander';
import { createCommandClient } from '../client/command-client.js';
import { formatResult, type OutputFormat } from '../output/formatter.js';
import { readContentFileOrStdin } from './content-input.js';
import type { CommandActionOptions, CommandCatalog } from '../spec/command-spec.js';
import {
  getSdkCapabilities,
  localSdkNavigation,
  navigationCatalog,
  type NavigationCapability,
  type NavigationCatalog,
} from '../client/sdk-capabilities.js';

const SDK_GROUPS = [
  ['app', 'Application lifecycle and platform operations'],
  ['card', 'Card lookup and Card object operations'],
  ['date', 'Daily document operations'],
  ['editor', 'Current editor and selection operations'],
  ['event', 'Plugin event operations'],
  ['focus', 'Focused Rem and portal operations'],
  ['kb', 'Knowledge base information'],
  ['messaging', 'Plugin message broadcasting'],
  ['powerup', 'Power-up lookup operations'],
  ['queue', 'Active review queue operations'],
  ['reader', 'Reader and PDF operations'],
  ['rem', 'Rem lookup and Rem object operations'],
  ['richText', 'Rich-text conversion and inspection'],
  ['scheduler', 'Custom scheduler operations'],
  ['search', 'Search and Query builder operations'],
  ['settings', 'Plugin setting operations'],
  ['storage', 'Plugin storage operations'],
  ['widget', 'Widget context and popup operations'],
  ['window', 'Pane, page, and floating-window operations'],
] as const;

function cliGroupName(group: string): string {
  return group.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function formatCapability(capability: NavigationCapability): string {
  const reason = capability.reason ? ` reason=${capability.reason}` : '';
  return `sdk ${cliGroupName(capability.group)} ${capability.command}: capability=${capability.id} status=${capability.status} mode=${capability.mode}${reason}`;
}

function parseArgsJson(value: string): unknown[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error('SDK args must be a JSON array');
  return parsed;
}

function outputFormat(program: Command): OutputFormat {
  return program.opts().text ? 'text' : 'json';
}

function capabilityHelp(capability: NavigationCapability): string {
  const commandName = cliGroupName(capability.group);
  const example = [
    'remnote-cli',
    'sdk',
    commandName,
    capability.command,
    ...(capability.target === 'rem'
      ? ['--target-id', 'REM_ID']
      : capability.target === 'card'
        ? ['--target-id', 'CARD_ID']
        : []),
    '--args-json',
    "'[]'",
    ...(capability.mode === 'destructive' ? ['--allow-destructive'] : []),
  ].join(' ');

  return [
    capability.summary ?? 'No SDK description is available.',
    '',
    `Capability: ${capability.id}`,
    `Status: ${capability.status}`,
    `Mode: ${capability.mode}`,
    `Target: ${capability.target}${capability.target === 'rem' || capability.target === 'card' ? ' (requires --target-id)' : ''}`,
    ...(capability.reason ? [`Reason: ${capability.reason}`] : []),
    '',
    'SDK signature:',
    ...capability.signatures.map((signature) => `  ${signature}`),
    '',
    `Example: ${example}`,
  ].join('\n');
}

async function readArgs(opts: {
  argsJson?: string;
  argsFile?: string;
}): Promise<unknown[] | undefined> {
  if (opts.argsJson !== undefined && opts.argsFile !== undefined) {
    throw new Error('Cannot use --args-json and --args-file together');
  }
  const source =
    opts.argsFile !== undefined ? await readContentFileOrStdin(opts.argsFile) : opts.argsJson;
  return source === undefined ? undefined : parseArgsJson(source);
}

function riskFor(capability: NavigationCapability): CommandActionOptions['risk'] {
  if (capability.mode === 'destructive') return 'destructive';
  if (capability.mode === 'read') return 'read';
  return 'write';
}

async function executeCapability(
  program: Command,
  capability: NavigationCapability,
  opts: { targetId?: string; argsJson?: string; argsFile?: string }
): Promise<void> {
  const format = outputFormat(program);
  const client = createCommandClient(program);
  try {
    const live = await getSdkCapabilities(client);
    const current = live.capabilities.find((candidate) => candidate.id === capability.id);
    if (!current) throw new Error(`Live SDK capability is unavailable: ${capability.id}`);
    if (current.status !== 'supported') {
      throw new Error(
        `Unsupported SDK capability ${current.id}: ${current.reason ?? 'no executable CLI path'}`
      );
    }
    const payload: Record<string, unknown> = {
      capability: current.id,
      expectedCatalogHash: live.sdkCatalogHash,
    };
    if (opts.targetId !== undefined) payload.targetId = opts.targetId;
    const args = await readArgs(opts);
    if (args !== undefined) payload.args = args;
    if (program.opts().allowDestructive || client.allowsDestructive())
      payload.allowDestructive = true;
    const callResult = await client.execute('sdk_call', payload);
    emit(program, formatResult(callResult, format));
  } finally {
    await client.close();
  }
}

function registerCapabilityCatalog(sdk: Command, program: Command, catalog: CommandCatalog): void {
  catalog
    .action(sdk, 'capabilities', {
      description: 'List and search live RemNote Plugin SDK commands',
      risk: 'read',
      bridge: 'required',
    })
    .option('--group <group>', 'Filter by SDK command group')
    .option('--status <status>', 'Filter by exact status')
    .option('--mode <mode>', 'Filter by exact mode')
    .option('--query <text>', 'Search command names, capability IDs, and descriptions')
    .action(async (opts) => {
      const format = outputFormat(program);
      const client = createCommandClient(program);
      try {
        const result = navigationCatalog(await getSdkCapabilities(client));
        const query = typeof opts.query === 'string' ? opts.query.toLowerCase() : undefined;
        const capabilities = result.capabilities.filter(
          (capability) =>
            (!opts.group || capability.group === opts.group) &&
            (!opts.status || capability.status === opts.status) &&
            (!opts.mode || capability.mode === opts.mode) &&
            (!query ||
              `${capability.command} ${capability.id} ${capability.summary ?? ''}`
                .toLowerCase()
                .includes(query))
        );
        emit(
          program,
          formatResult({ ...result, capabilities }, format, () =>
            [
              `RemNote SDK ${result.sdkVersion}: ${capabilities.length} capabilities`,
              ...capabilities.map(formatCapability),
            ].join('\n')
          )
        );
      } finally {
        await client.close();
      }
    });
}

function registerMethod(
  groupCommand: Command,
  program: Command,
  catalog: CommandCatalog,
  capability: NavigationCapability
): void {
  const command = catalog.action(groupCommand, capability.command, {
    description: `${capability.summary ?? capability.id} [${capability.status}/${capability.mode}]`,
    risk: riskFor(capability),
    bridge: 'required',
  });
  const withTarget =
    capability.target === 'rem' || capability.target === 'card'
      ? command.requiredOption('--target-id <id>', 'Target Rem or Card ID')
      : command.option('--target-id <id>', 'Target Rem or Card ID');
  withTarget
    .option('--args-json <json-array>', 'Positional arguments as a JSON array')
    .option('--args-file <path|->', 'Read positional JSON arguments from a file or stdin')
    .addHelpText('after', ['', capabilityHelp(capability)].join('\n'));
  command.action(async (opts: { targetId?: string; argsJson?: string; argsFile?: string }) =>
    executeCapability(program, capability, opts)
  );
}

function registerSdkCall(sdk: Command, program: Command, catalog: CommandCatalog): void {
  catalog
    .action(sdk, 'call <capability-id>', {
      description: 'Call one supported live SDK capability by exact capability ID',
      risk: 'destructive',
      bridge: 'required',
    })
    .option('--target-id <id>', 'Target Rem or Card ID for object methods')
    .option('--args-json <json-array>', 'Positional arguments as a JSON array')
    .option('--args-file <path|->', 'Read positional JSON arguments from a file or stdin')
    .action(async (capabilityId: string, opts) => {
      const format = outputFormat(program);
      const client = createCommandClient(program);
      try {
        const result = await getSdkCapabilities(client);
        const capability = result.capabilities.find((candidate) => candidate.id === capabilityId);
        if (!capability) throw new Error(`Unknown live SDK capability: ${capabilityId}`);
        if (capability.status !== 'supported') {
          throw new Error(
            `Unsupported SDK capability ${capability.id}: ${capability.reason ?? 'no executable CLI path'}`
          );
        }
        const payload: Record<string, unknown> = {
          capability: capability.id,
          expectedCatalogHash: result.sdkCatalogHash,
        };
        if (opts.targetId !== undefined) payload.targetId = opts.targetId as string;
        const args = await readArgs(opts as { argsJson?: string; argsFile?: string });
        if (args !== undefined) payload.args = args;
        if (program.opts().allowDestructive || client.allowsDestructive())
          payload.allowDestructive = true;
        const callResult = await client.execute('sdk_call', payload);
        emit(program, formatResult(callResult, format));
      } finally {
        await client.close();
      }
    });
}

export function registerSdkCommands(program: Command, catalog: CommandCatalog): void {
  const sdk = catalog.group(program, 'sdk', {
    description: 'Low-level RemNote Plugin SDK access',
  });
  registerCapabilityCatalog(sdk, program, catalog);
  registerSdkCall(sdk, program, catalog);
  const navigation: NavigationCatalog = localSdkNavigation();
  for (const [group, description] of SDK_GROUPS) {
    const groupCommand = catalog.group(sdk, cliGroupName(group), { description });
    const capabilities = navigation.capabilities
      .filter((capability) => capability.group === group)
      .sort((left, right) => left.command.localeCompare(right.command));
    for (const capability of capabilities)
      registerMethod(groupCommand, program, catalog, capability);
  }
}
