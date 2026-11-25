#!/usr/bin/env node
/* global console, process */
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const roots = process.argv.slice(2).map((value) => resolve(value));
if (roots.length === 0) roots.push(resolve('.'));
const legacyPaths = new Map([
  ['create', 'rem create'],
  ['read', 'rem read'],
  ['update', 'rem update'],
  ['search', 'rem search'],
  ['search-by-tag', 'rem search-by-tag'],
  ['list-children', 'rem children list'],
  ['insert-children', 'rem children insert'],
  ['replace-children', 'rem children replace'],
  ['move-note', 'rem move'],
  ['update-tags', 'rem tags update'],
  ['set-property', 'rem property set'],
  ['set-document-status', 'rem document status'],
  ['get-media', 'media get'],
  ['read-table', 'table read'],
  ['review-stats', 'rem inspect'],
  ['powerup', 'rem powerup'],
  ['powerup get', 'rem powerup get'],
  ['context', 'rem context'],
  ['verify scope', 'rem verify scope'],
  ['outline', 'rem outline'],
  ['outline collapse', 'rem outline collapse'],
  ['outline expand', 'rem outline expand'],
  ['card apply', 'card create'],
  ['card review-stats', 'rem inspect'],
  ['flashcards', 'card create'],
  ['flashcards apply', 'card create'],
  ['contract --schema', 'schema <command-path>'],
  ['journal', 'journal append'],
]);
const commandPatterns = Array.from(legacyPaths, ([path, replacement]) => ({
  path,
  replacement,
  regex: new RegExp(
    'remnote-cli(?:\\s+--\\S+)*\\s+' +
      path.replace(/ /g, '\\s+') +
      (path === 'journal' ? '(?=\\s+--|\\s*$)' : '(?=\\s|$|\\W)'),
    'g'
  ),
}));
const argvPatterns = Array.from(legacyPaths, ([path, replacement]) => ({
  path,
  replacement,
  regex: new RegExp(
    '"argv"\\s*:\\s*\\[\\s*' +
      path
        .split(' ')
        .map((part) => '"' + part + '"')
        .join('\\s*,\\s*') +
      (path === 'journal' ? '(?=\\s*\\]|\\s*,\\s*"-)' : '(?=\\s*\\]|\\s*,)'),
    'g'
  ),
}));
const schemaPatterns = Array.from(legacyPaths, ([path, replacement]) => ({
  path,
  replacement,
  regex: new RegExp(
    'remnote-cli(?:\\s+--\\S+)*\\s+schema\\s+' + path.replace(/ /g, '[.\\s]+') + '(?=\\s|$)',
    'g'
  ),
}));
const inlinePatterns = Array.from(legacyPaths, ([path, replacement]) => ({
  path,
  replacement,
  regex: new RegExp('`' + path.replace(/ /g, '\\s+') + '(?=\\s|`|$)', 'g'),
})).filter(({ path }) => path.includes('-') || path.includes(' '));
inlinePatterns.push({
  path: 'context',
  replacement: 'rem context',
  regex: /`context(?=\s+--)/g,
});

async function files(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist', 'coverage'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await files(path)));
    else if (['.md', '.json', '.yaml', '.yml'].includes(extname(entry.name))) output.push(path);
  }
  return output;
}

const findings = [];
for (const root of roots) {
  for (const path of await files(root)) {
    if (
      path.endsWith('CHANGELOG.md') ||
      path.endsWith('cli-contract.generated.json') ||
      path.includes('group-boundary.test.ts')
    )
      continue;
    const text = await readFile(path, 'utf8');
    for (const patterns of [commandPatterns, argvPatterns, schemaPatterns, inlinePatterns]) {
      for (const { path: legacyPath, replacement, regex } of patterns) {
        for (const match of text.matchAll(regex)) {
          const before = text.slice(0, match.index);
          const line = before.split('\n').length;
          findings.push({
            path: relative(process.cwd(), path),
            line,
            legacyPath,
            replacement,
            text: match[0],
          });
        }
      }
    }
  }
}
if (findings.length > 0) {
  for (const finding of findings)
    console.error(
      `${finding.path}:${finding.line}: stale command path ${JSON.stringify(finding.legacyPath)} in ${JSON.stringify(finding.text)}; use ${JSON.stringify(finding.replacement)}`
    );
  process.exit(1);
}
console.log(`Command reference check passed for ${roots.length} root(s).`);
