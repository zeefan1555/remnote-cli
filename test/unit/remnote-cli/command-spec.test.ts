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
    const search = commandSpec(specs, 'search');
    expect(search.usage).toBe('search query');
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
    expect(commandSpec(specs, 'assert')).toMatchObject({
      risk: 'read',
      bridge: 'optional',
    });
    expect(commandSpec(specs, 'move-note')).toMatchObject({
      risk: 'destructive',
      bridge: 'required',
    });
    expect(commandSpec(specs, 'sync status')).toMatchObject({
      risk: 'read',
      bridge: 'none',
    });
    expect(commandSpec(specs, 'sdk rem')).toMatchObject({
      risk: 'destructive',
      bridge: 'required',
      dynamic: true,
    });
  });

  it('prints one command schema and rejects an unknown path', async () => {
    const selected = await runCliForTest(['schema', 'search']);
    const spec = parseSuccess(selected.stdout) as CommandSpec;
    expect(selected.exitCode).toBe(0);
    expect(spec.path).toBe('search');
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
    expect(value.schemaVersion).toBe(1);
    expect(value.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'search', risk: 'read' }),
        expect.objectContaining({ path: 'sync delete', risk: 'destructive' }),
      ])
    );
  });
});
