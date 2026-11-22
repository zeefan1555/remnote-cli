import type { Command } from 'commander';
import { CliFailure } from '../output/errors.js';
import { rootHelpLabel, rootHelpSection } from './command-spec.js';

const LEGACY_PATHS = [
  ['create', 'rem create'],
  ['read', 'rem read'],
  ['update', 'rem update'],
  ['search', 'rem search'],
  ['search-by-tag', 'rem search-by-tag'],
  ['list-children', 'rem children list'],
  ['inspect', 'rem inspect'],
  ['assert', 'rem assert'],
  ['powerup get', 'rem powerup get'],
  ['context', 'rem context'],
  ['verify scope', 'rem verify scope'],
  ['flashcards apply', 'card apply'],
  ['review-stats', 'card review-stats'],
  ['outline collapse', 'rem outline collapse'],
  ['outline expand', 'rem outline expand'],
  ['get-media', 'media get'],
  ['insert-children', 'rem children insert'],
  ['move-note', 'rem move'],
  ['set-document-status', 'rem document status'],
  ['replace-children', 'rem children replace'],
  ['update-tags', 'rem tags update'],
  ['set-property', 'rem property set'],
  ['journal', 'journal append'],
  ['read-table', 'table read'],
] as const;

function commandPath(command: Command): string {
  const parts: string[] = [];
  let current: Command | null = command;
  while (current?.parent) {
    parts.unshift(current.name());
    current = current.parent;
  }
  return parts.join(' ');
}

function optionsOf(command: Command): Command['options'] {
  const output: Array<Command['options'][number]> = [];
  let current: Command | null = command;
  while (current) {
    output.push(...current.options);
    current = current.parent;
  }
  return output;
}

function optionTakesValue(command: Command, token: string): boolean {
  const name = token.replace(/^-+/, '').split('=', 1)[0];
  const option = optionsOf(command).find(
    (candidate) => candidate.long?.replace(/^--/, '') === name || candidate.short === `-${name}`
  );
  return option !== undefined && (option.required || option.optional) && !token.includes('=');
}

function isKnownOption(command: Command, token: string): boolean {
  const name = token.replace(/^-+/, '').split('=', 1)[0];
  return optionsOf(command).some(
    (option) => option.long?.replace(/^--/, '') === name || option.short === `-${name}`
  );
}

function isKnownShortFlagCluster(command: Command, token: string): boolean {
  if (!/^-[^-].+/.test(token) || token.includes('=')) return false;
  return [...token.slice(1)].every((name) => {
    if (name === 'h') return true;
    const option = optionsOf(command).find((candidate) => candidate.short === `-${name}`);
    return option !== undefined && !option.required && !option.optional;
  });
}

function hasDescendantOption(command: Command, token: string): boolean {
  const name = token.replace(/^-+/, '').split('=', 1)[0];
  return command.commands.some(
    (child) =>
      child.options.some(
        (option) => option.long?.replace(/^--/, '') === name || option.short === `-${name}`
      ) || hasDescendantOption(child, token)
  );
}

function descendantOptionOwners(command: Command, token: string): string[] {
  const name = token.replace(/^-+/, '').split('=', 1)[0];
  const output: string[] = [];
  const visit = (parent: Command): void => {
    for (const child of parent.commands) {
      if (
        child.options.some(
          (option) => option.long?.replace(/^--/, '') === name || option.short === `-${name}`
        )
      )
        output.push(commandPath(child));
      visit(child);
    }
  };
  visit(command);
  return output;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function suggestions(command: Command, value: string): string[] {
  return command.commands
    .filter((child) => child.name() !== 'help')
    .map((child) => ({ name: child.name(), distance: editDistance(value, child.name()) }))
    .sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name))
    .slice(0, 6)
    .map((candidate) => candidate.name);
}

function legacySuggestions(command: Command, value: string): string[] {
  if (command.parent) return [];
  return LEGACY_PATHS.filter(([legacy]) => legacy.startsWith(value))
    .map(([, replacement]) => replacement)
    .slice(0, 6);
}

function usage(command: Command): string {
  return command.parent
    ? [
        commandPath(command),
        ...command.registeredArguments.map((argument) => argument.name()),
      ].join(' ')
    : 'remnote-cli <command>';
}

function groupFailure(
  command: Command,
  subtype: 'unknown_subcommand' | 'missing_subcommand' | 'unknown_group_flag',
  message: string,
  candidates: string[] = []
): CliFailure {
  return new CliFailure('usage', subtype, message, {
    details: {
      commandPath: commandPath(command) || 'remnote-cli',
      suggestions: candidates,
      usage: usage(command),
    },
  });
}

export function commandBoundaryFailure(program: Command, argv: string[]): CliFailure | undefined {
  let command = program;
  const args = argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--') break;
    if (token === 'help') return undefined;
    if (token === '--help' || token === '-h') return undefined;
    if (token.startsWith('-')) {
      if (isKnownOption(command, token)) {
        if (optionTakesValue(command, token)) {
          if (index + 1 >= args.length) return undefined;
          index++;
        }
        continue;
      }
      if (isKnownShortFlagCluster(command, token)) continue;
      if (command.commands.length > 0 && hasDescendantOption(command, token)) {
        const candidates = descendantOptionOwners(command, token).slice(0, 6);
        const suffix = candidates.length > 0 ? `; did you mean ${candidates.join(', ')}?` : '';
        return groupFailure(
          command,
          'missing_subcommand',
          `missing subcommand for ${commandPath(command) || 'remnote-cli'}; ${token.split('=', 1)[0]} belongs to a subcommand${suffix}`,
          candidates
        );
      }
      if (command.commands.length > 0) {
        return groupFailure(
          command,
          'unknown_group_flag',
          `unknown flag ${token.split('=', 1)[0]} for ${commandPath(command) || 'remnote-cli'}`
        );
      }
      continue;
    }
    const child = command.commands.find((candidate) => candidate.name() === token);
    if (!child) {
      if (command.commands.length > 0) {
        const legacy = legacySuggestions(command, token);
        const candidates = legacy.length > 0 ? legacy : suggestions(command, token);
        const suffix = candidates.length > 0 ? `; did you mean ${candidates.join(', ')}?` : '';
        return groupFailure(
          command,
          'unknown_subcommand',
          `unknown subcommand ${token} for ${commandPath(command) || 'remnote-cli'}${suffix}`,
          candidates
        );
      }
      break;
    }
    command = child;
  }
  return undefined;
}

export function normalizeTrailingGroupHelp(program: Command, argv: string[]): string[] {
  if (argv.at(-1) !== 'help') return argv;
  let command = program;
  const prefix = argv.slice(2, -1);
  for (let index = 0; index < prefix.length; index++) {
    const token = prefix[index];
    if (token === '--') return argv;
    if (token.startsWith('-')) {
      if (!isKnownOption(command, token) && !isKnownShortFlagCluster(command, token)) return argv;
      if (isKnownShortFlagCluster(command, token) && token.includes('V')) return argv;
      if (isKnownShortFlagCluster(command, token)) continue;
      if (optionTakesValue(command, token)) {
        if (index + 1 >= prefix.length) return argv;
        index++;
      }
      continue;
    }
    const child = command.commands.find((candidate) => candidate.name() === token);
    if (!child) return argv;
    command = child;
  }
  if (command === program || command.commands.length === 0) return argv;
  return [...argv.slice(0, -1), '--help'];
}

export function rootHelpRequested(program: Command, argv: string[]): boolean {
  const args = argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === 'help') return false;
    if (token === '--help' || token === '-h') return true;
    if (token === '--version' || token === '-V') return false;
    if (token.startsWith('-')) {
      if (isKnownShortFlagCluster(program, token)) {
        if (token.includes('V')) return false;
        if (token.includes('h')) return true;
        continue;
      }
      if (!isKnownOption(program, token)) return false;
      if (optionTakesValue(program, token)) {
        if (index + 1 >= args.length) return false;
        index++;
      }
      continue;
    }
    return false;
  }
  return true;
}

export function installCommandHelpGroups(program: Command): void {
  for (const child of program.commands) {
    if (child.name() !== 'help') child.helpGroup(rootHelpLabel(rootHelpSection(child.name())));
  }
}
