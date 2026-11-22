#!/usr/bin/env node
/* global console, process, URL */
import { readFile, writeFile } from 'node:fs/promises';
import { buildCliContract } from '../src/schemas/contract.ts';
import { createProgram } from '../src/remnote-cli/cli.ts';
import { createBufferedRuntime } from '../src/remnote-cli/output/runtime.ts';
import { buildCommandSpecs } from '../src/remnote-cli/spec/command-spec.ts';

const target = new URL('../docs/guides/cli-contract.generated.json', import.meta.url);
const runtime = createBufferedRuntime('json');
const program = createProgram('contract-generator', runtime);
const value = JSON.stringify(buildCliContract(buildCommandSpecs(program)), null, 2) + '\n';
if (process.argv.includes('--check')) {
  const current = await readFile(target, 'utf8').catch(() => '');
  if (current !== value) {
    console.error('CLI contract is stale. Run npm run generate:cli-contract.');
    process.exitCode = 1;
  }
} else {
  await writeFile(target, value);
}
