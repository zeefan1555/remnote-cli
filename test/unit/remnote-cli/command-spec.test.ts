import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { createProgram } from '../../../src/remnote-cli/cli.js';
import { EXIT } from '../../../src/remnote-cli/output/errors.js';
import { createBufferedRuntime } from '../../../src/remnote-cli/output/runtime.js';
import {
  buildCommandSpecs,
  commandSpec,
  type CommandSpec,
} from '../../../src/remnote-cli/spec/command-spec.js';
import { parseFailure, parseSuccess, runCliForTest } from '../../helpers/run-cli.js';

function program() {
  return createProgram('0.1.0-test', createBufferedRuntime());
}

function commanderPaths(root: Command): string[] {
  const paths: string[] = [];
  function visit(command: Command, prefix: string[]): void {
    for (const child of command.commands) {
      if (child.name() === 'help') continue;
      const path = [...prefix, child.name()];
      paths.push(path.join(' '));
      visit(child, path);
    }
  }
  visit(root, []);
  return paths.sort();
}

describe('command specs', () => {
  it('covers every registered Commander path exactly once', () => {
    const cli = program();
    const specs = buildCommandSpecs(cli);
    expect(specs.map((spec) => spec.path)).toEqual(commanderPaths(cli));
    expect(new Set(specs.map((spec) => spec.path)).size).toBe(specs.length);
  });

  it('derives stable usage, input fields and output streams from Commander', () => {
    const specs = buildCommandSpecs(program());
    const search = commandSpec(specs, 'rem search');
    expect(search.usage).toBe('rem search query');
    expect(search.input.required).toContain('query');
    expect(search.input.properties.limit).toMatchObject({
      type: 'string',
      default: '50',
    });
    expect(search.input.properties.text).toMatchObject({ type: 'boolean' });
    expect(search.input.properties.all).toMatchObject({ type: 'boolean' });
    expect(search.input.properties.maxPages).toMatchObject({ type: 'string' });
    expect(search.input.properties.pageDelay).toMatchObject({
      type: 'string',
      default: '0',
    });
    expect(search.pagination).toMatchObject({ kind: 'cursor', automatic: true });
    expect(search.output).toEqual({
      envelope: 'remnote-cli/v2',
      successStream: 'stdout',
      failureStream: 'stderr',
    });
  });

  it('centralizes bridge and risk policy', () => {
    const specs = buildCommandSpecs(program());
    expect(commandSpec(specs, 'rem assert')).toMatchObject({
      risk: 'read',
      bridge: 'optional',
    });
    expect(commandSpec(specs, 'rem move')).toMatchObject({
      risk: 'destructive',
      bridge: 'required',
    });
    expect(commandSpec(specs, 'rem tags update')).toMatchObject({
      risk: 'destructive',
      bridge: 'required',
    });
    expect(commandSpec(specs, 'sync status')).toMatchObject({
      risk: 'read',
      bridge: 'none',
    });
    expect(commandSpec(specs, 'sdk rem')).toMatchObject({
      kind: 'group',
      bareHelp: true,
    });
    expect(commandSpec(specs, 'sdk rem object-get-children-rem')).toMatchObject({
      kind: 'action',
      risk: 'read',
      bridge: 'required',
      dynamic: false,
    });
    expect(commandSpec(specs, 'sync')).toEqual(
      expect.not.objectContaining({ risk: expect.anything(), bridge: expect.anything() })
    );
  });

  it('adds connection and destructive flags only to applicable actions', () => {
    const specs = buildCommandSpecs(program());
    const create = commandSpec(specs, 'rem create');
    const remove = commandSpec(specs, 'rem delete');
    const schema = commandSpec(specs, 'schema');

    expect(create.input.properties.kbId).toBeDefined();
    expect(create.input.properties.allowDestructive).toBeUndefined();
    expect(remove.input.properties.kbId).toBeDefined();
    expect(remove.input.properties.allowDestructive).toBeDefined();
    expect(schema.input.properties.kbId).toBeUndefined();
    expect(schema.input.properties.allowDestructive).toBeUndefined();
  });

  it('rejects a Commander command that bypasses the catalog', () => {
    const cli = program();
    cli.command('unregistered');
    expect(() => buildCommandSpecs(cli)).toThrow(
      'Command is not registered through CommandCatalog: unregistered'
    );
  });

  it('prints one command schema and rejects an unknown path', async () => {
    const selected = await runCliForTest(['schema', 'rem.search']);
    const spec = parseSuccess(selected.stdout) as CommandSpec;
    expect(selected.exitCode).toBe(0);
    expect(spec.path).toBe('rem search');
    expect(spec.input.properties.cursor).toBeDefined();

    const unknown = await runCliForTest(['schema', 'missing', 'command']);
    expect(unknown.exitCode).toBe(EXIT.USAGE);
    expect(parseFailure(unknown.stderr).message).toContain('Unknown command schema');
  });

  it('lists command summaries without requiring RemNote', async () => {
    const result = await runCliForTest(['schema']);
    const value = parseSuccess(result.stdout) as {
      schemaVersion: number;
      commands: Array<{ path: string; risk: string }>;
    };
    expect(value.schemaVersion).toBe(2);
    expect(value.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'rem search', kind: 'action', risk: 'read' }),
        expect.objectContaining({ path: 'sync', kind: 'group' }),
        expect.objectContaining({ path: 'sync delete', kind: 'action', risk: 'destructive' }),
      ])
    );
  });
});
