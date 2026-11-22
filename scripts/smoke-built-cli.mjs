#!/usr/bin/env node
/* global console, process */
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const binary = join(repository, 'dist', 'remnote-cli', 'index.js');
const packageJson = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'remnote-cli-smoke-'));

async function run(args, env = process.env) {
  return execute(process.execPath, [binary, ...args], {
    cwd: repository,
    env,
    encoding: 'utf8',
  });
}

function envelope(text) {
  const value = JSON.parse(text);
  if (!value || value.schemaVersion !== 2)
    throw new Error('Built CLI returned an unexpected envelope');
  return value;
}

try {
  await access(binary, constants.X_OK);

  const version = await run(['--version']);
  if (version.stdout.trim() !== packageJson.version)
    throw new Error('Built CLI version does not match package.json');

  const contract = envelope((await run(['contract'])).stdout);
  if (
    contract.ok !== true ||
    contract.data.output.schemaVersion !== 2 ||
    contract.data.commands.length === 0
  )
    throw new Error('Built CLI contract is incomplete');

  const doctor = envelope(
    (
      await run(['doctor', '--offline'], {
        ...process.env,
        REMNOTE_CLI_STATE_HOME: join(temporary, 'state'),
      })
    ).stdout
  );
  if (doctor.ok !== true || doctor.data.offline !== true || doctor.data.summary.fail !== 0)
    throw new Error('Built CLI offline doctor failed');

  console.log('Built CLI smoke passed at version ' + packageJson.version);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
