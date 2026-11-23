#!/usr/bin/env node
/* global console, process */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const VERSION_PATTERN = /^0\.([1-9]\d*)\.(100|[1-9]\d?)$/;
const EXPECTED_SHAPE = '0.<positive-minor>.<1..100>';

function parseVersion(version) {
  if (typeof version !== 'string') {
    throw new Error('Invalid version; expected ' + EXPECTED_SHAPE + '.');
  }

  const match = VERSION_PATTERN.exec(version);
  if (!match) {
    throw new Error('Invalid version "' + version + '"; expected ' + EXPECTED_SHAPE + '.');
  }

  const minor = Number(match[1]);
  const step = Number(match[2]);
  if (!Number.isSafeInteger(minor)) {
    throw new Error('Invalid version "' + version + '"; minor is too large.');
  }
  return { minor, step };
}

function nextVersion(version) {
  const { minor, step } = parseVersion(version);
  if (step === 100) {
    const nextMinor = minor + 1;
    if (!Number.isSafeInteger(nextMinor)) {
      throw new Error('Invalid version "' + version + '"; next minor is too large.');
    }
    return '0.' + nextMinor + '.1';
  }
  return '0.' + minor + '.' + (step + 1);
}

async function readJson(file, label) {
  let contents;
  try {
    contents = await readFile(file, 'utf8');
  } catch {
    throw new Error(label + ' is missing or unreadable.');
  }

  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(label + ' is not valid JSON.');
  }
}

function requireMatchingVersion(label, actual, expected) {
  if (actual !== expected) {
    const found = actual === undefined ? 'is missing' : 'is "' + actual + '"';
    throw new Error(label + ' ' + found + '; expected "' + expected + '".');
  }
}

async function checkRepository(root = process.cwd()) {
  const packageJson = await readJson(join(root, 'package.json'), 'package.json');
  const version = packageJson?.version;
  if (typeof version !== 'string') {
    throw new Error('package.json is missing a string version.');
  }
  parseVersion(version);

  const packageLock = await readJson(join(root, 'package-lock.json'), 'package-lock.json');
  requireMatchingVersion('package-lock.json version', packageLock?.version, version);
  requireMatchingVersion(
    'package-lock.json packages[""] version',
    packageLock?.packages?.['']?.version,
    version
  );

  let changelog;
  try {
    changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  } catch {
    throw new Error('CHANGELOG.md is missing or unreadable.');
  }
  const headingPattern = new RegExp(
    '^## \\[' + version.replaceAll('.', '\\.') + '\\](?:\\s|$)',
    'm'
  );
  if (!headingPattern.test(changelog)) {
    throw new Error('CHANGELOG.md is missing heading "## [' + version + ']".');
  }

  return version;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    const version = await checkRepository();
    console.log('Version ' + version + ' is valid.');
    return;
  }

  if (args.length !== 2 || args[0] !== '--next') {
    throw new Error('Usage: npm run check:version [-- --next <version>]');
  }
  console.log(nextVersion(args[1]));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
