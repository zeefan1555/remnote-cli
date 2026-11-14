#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { parseDocument as parseYaml, stringify } from 'yaml';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wrapper = join(repository, 'run-agent-integration-test.sh');
const usage = `Usage: node --import tsx scripts/sync-agent-acceptance.mjs --self-test
       node scripts/sync-agent-acceptance.mjs --yes --kb-id ID --parent-id ID --evidence-root /PRIVATE/.sync/acceptance
Creates one [CLI-TEST]sync root under the exact authorized parent. Runs every live
command serially through the guarded integration wrapper. Requires exclusive live
ownership and a frozen candidate. Stops on failure; never retries unknown writes.
All logs and synthetic content stay in a new private evidence directory. Successful
cleanup deletes only recorded test IDs. No live calls without explicit --yes.`;

function trailingJson(output) {
  const clean = stripVTControlCharacters(output).trim();
  for (const match of clean.matchAll(/(?:^|\n)(?=[{[])/g)) {
    try {
      return JSON.parse(clean.slice(match.index).trim());
    } catch {
      // The wrapper emits build/npm banners before the CLI's final JSON value.
    }
  }
  throw new Error('No final JSON receipt; inspect the private wrapper log');
}

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (name === '--yes') {
      assert.equal(result.yes, undefined, 'Duplicate --yes');
      result.yes = true;
    } else {
      assert.ok(['--kb-id', '--parent-id', '--evidence-root'].includes(name), 'Unknown argument');
      assert.equal(result[name], undefined, 'Duplicate argument');
      const value = argv[++i];
      assert.ok(value && !value.startsWith('--'), 'Missing argument value');
      result[name] = value;
    }
  }
  assert.equal(result.yes, true, 'Explicit --yes required; no live action started');
  for (const name of ['--kb-id', '--parent-id', '--evidence-root'])
    assert.ok(result[name], `Required ${name}`);
  for (const name of ['--kb-id', '--parent-id'])
    assert.match(result[name], /^[A-Za-z0-9_-]{1,256}$/, 'Invalid exact ID');
  assert.ok(isAbsolute(result['--evidence-root']), 'Evidence root must be absolute');
  return result;
}

function execute(command, argv) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, argv, { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}

async function candidateFingerprint() {
  const listing = await execute('git', [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
  ]);
  assert.equal(listing.code, 0, 'Cannot enumerate candidate files');
  const files = [...new Set(listing.stdout.split('\0').filter(Boolean))].sort();
  const hash = createHash('sha256');
  for (const path of files) {
    const stat = await lstat(join(repository, path));
    assert.ok(stat.isFile() || stat.isSymbolicLink(), 'Candidate contains an unexpected non-file');
    hash
      .update(path)
      .update('\0')
      .update(
        stat.isSymbolicLink()
          ? await readlink(join(repository, path))
          : await readFile(join(repository, path))
      )
      .update('\0');
  }
  const head = await execute('git', ['rev-parse', 'HEAD']);
  assert.equal(head.code, 0);
  return { head: head.stdout.trim(), sourceSha256: hash.digest('hex') };
}

async function buildFingerprint() {
  const directory = join(repository, 'dist');
  const paths = (await readdir(directory, { recursive: true })).sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    const file = join(directory, path);
    if ((await lstat(file)).isFile())
      hash
        .update(path)
        .update('\0')
        .update(await readFile(file))
        .update('\0');
  }
  return hash.digest('hex');
}

async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700, recursive: true });
  assert.equal(await realpath(path), path, 'Evidence directory may not contain symlinks');
  assert.equal((await lstat(path)).mode & 0o077, 0, 'Evidence directory must be private (0700)');
}

function remById(snapshot, id) {
  assert.equal(snapshot.complete, true, 'Incomplete native read');
  assert.equal(snapshot.truncated, false, 'Truncated native read');
  assert.deepEqual(snapshot.errors, [], 'Native read reported errors');
  const rem = snapshot.rems.find((item) => item.id === id);
  assert.ok(rem && !rem.missing, 'Expected native ID is absent');
  return rem;
}

function cardIdentity(snapshot) {
  return snapshot.rems.map((rem) => ({
    id: rem.id,
    cards: rem.cards?.map(({ id, hash, historyLength }) => ({ id, hash, historyLength })),
  }));
}

function replaceOnce(source, original, replacement) {
  assert.equal(source.split(original).length, 2, 'Expected exactly one synthetic text occurrence');
  return source.replace(original, replacement);
}

function documentParts(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n(?:\r?\n)?/.exec(source);
  assert.ok(match, 'Imported YAML frontmatter is required');
  const parsed = parseYaml(match[1], { uniqueKeys: true, strict: true });
  assert.deepEqual(parsed.errors, [], 'Invalid YAML fixture');
  assert.deepEqual(parsed.warnings, [], 'Unsupported YAML fixture');
  const metadata = parsed.toJS({ maxAliasCount: 0 });
  assert.equal(metadata.schema, 'remnote-sync/1');
  assert.equal(metadata.rems[metadata.root].id, metadata.root);
  return { metadata, body: source.slice(match[0].length) };
}

function appendMultiline(source, blocks) {
  const { metadata, body } = documentParts(source);
  for (const [key, content] of [
    ['question', 'multiline'],
    ['answer', 'text'],
  ]) {
    assert.equal(metadata.rems[`new:${key}`], undefined, 'Fixture key already exists');
    assert.match(blocks[key], /^local-[A-Za-z0-9-]+$/);
    metadata.rems[`new:${key}`] = { id: null, block: blocks[key], content };
  }
  assert.notEqual(blocks.question, blocks.answer, 'Question and answer need distinct blocks');
  return `---\n${stringify(metadata, { lineWidth: 0, aliasDuplicateObjects: false })}---\n\n${body.trimEnd()}\n\n- Sync acceptance question ^${blocks.question}\n  - Sync acceptance answer ^${blocks.answer}\n`;
}

function replaceBodyOnce(source, original, replacement) {
  const { body } = documentParts(source);
  return source.slice(0, source.length - body.length) + replaceOnce(body, original, replacement);
}

function assertPublishedBlocks(source, ids, blocks) {
  const { metadata } = documentParts(source);
  for (const key of ['question', 'answer']) {
    assert.equal(metadata.rems[`new:${key}`], undefined);
    assert.equal(metadata.rems[ids[key]]?.id, ids[key]);
    assert.equal(
      metadata.rems[ids[key]]?.block,
      blocks[key],
      'Publication replaced a stable block'
    );
  }
}

function assertCoverage(value) {
  assert.equal(value.discoveryScope, 'bound-ids');
  assert.equal(value.globalDiscoveryComplete, false);
  assert.equal(value.remoteChecked, true);
}

function assertMissing(snapshot, ids) {
  // findMany filters absent IDs. inspect expands them into explicit missing receipts;
  // complete:false is expected only when every error is exactly that absence.
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.truncated, false);
  assert.ok(Array.isArray(snapshot.rems));
  assert.deepEqual(snapshot.rems.map((rem) => rem.id).sort(), [...ids].sort());
  const missingError = { field: 'rem', message: 'Rem missing from exact batch lookup' };
  for (const rem of snapshot.rems) {
    assert.equal(rem.missing, true, 'A recorded synthetic Rem still exists');
    assert.deepEqual(rem.errors, [missingError]);
  }
  assert.equal(snapshot.errors.length, ids.length, 'Unexpected read failure, not absence');
  assert.ok(
    snapshot.errors.every((error) => ids.includes(error.id)),
    'Unexpected read error identity'
  );
  assert.deepEqual(
    [...snapshot.errors].sort((a, b) => a.id.localeCompare(b.id)),
    [...ids].sort().map((id) => ({ id, ...missingError })),
    'Unexpected read failure, not absence'
  );
}

function assertPlanningConflict(value, id) {
  assertCoverage(value);
  assert.equal(value.status, 'conflict');
  assert.equal(value.complete, false);
  assert.equal(value.remoteWrites, 0);
  assert.equal(value.conflicts.length, 1);
  const conflict = value.conflicts[0];
  assert.equal(conflict.id, id);
  assert.equal(conflict.reason, 'untrusted-edit-order');
  for (const key of ['baseHash', 'localHash', 'remoteHash'])
    assert.match(conflict[key], /^[a-f0-9]{64}$/);
  assert.equal(new Set([conflict.baseHash, conflict.localHash, conflict.remoteHash]).size, 3);
  assert.match(
    conflict.remoteSnapshot,
    /^\.sync\/conflicts\/[a-f0-9]{64}\/[A-Za-z0-9_-]+-[a-f0-9]{64}\.json$/
  );
  return conflict;
}

function cardReadback(value, requestedIds) {
  assert.ok(Array.isArray(value), 'Card lookup must return an array');
  const returned = value.map((card) => {
    assert.ok(card && typeof card._id === 'string', 'Malformed card readback');
    assert.ok(requestedIds.includes(card._id), 'Unexpected card identity');
    return card._id;
  });
  assert.equal(new Set(returned).size, returned.length, 'Duplicate card readback');
  return {
    retainedNativeCardIds: returned,
    unreturnedNativeCardIds: requestedIds.filter((id) => !returned.includes(id)),
  };
}

function assertDirections(value, expected, assigned = {}) {
  assertCoverage(value);
  assert.equal(value.atomic, false);
  for (const key of ['incoming', 'outgoing', 'converged']) {
    assert.ok(Array.isArray(value[key]), `Missing ${key} receipt`);
    assert.deepEqual([...value[key]].sort(), expected[key].map((id) => assigned[id] ?? id).sort());
  }
}

function rememberKnownIds(receipt, value, label) {
  if (label === 'create-root' && value.remIds?.[0]) receipt.testIds.root = value.remIds[0];
  for (const [key, id] of Object.entries(value.ids ?? {})) {
    assert.match(key, /^new:(question|answer)$/);
    assert.match(id, /^[A-Za-z0-9_-]{1,256}$/);
    const name = key.slice(4);
    assert.ok(!receipt.testIds[name] || receipt.testIds[name] === id, 'Known ID changed');
    receipt.testIds[name] = id;
  }
}

async function main(argv) {
  const opts = options(argv);
  const evidenceRoot = resolve(opts['--evidence-root']);
  assert.ok(
    evidenceRoot.endsWith(`${sep}.sync${sep}acceptance`),
    'Use a private .sync/acceptance directory'
  );
  assert.ok(
    relative(repository, evidenceRoot).startsWith(`..${sep}`),
    'Evidence must be outside the code repository'
  );
  await privateDirectory(evidenceRoot);
  const directory = await mkdtemp(join(evidenceRoot, 'sync-'));
  const workspace = join(directory, 'working-copy');
  await privateDirectory(workspace);
  const receipt = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    kbId: opts['--kb-id'],
    parentId: opts['--parent-id'],
    candidate: await candidateFingerprint(),
    testIds: {},
    steps: [],
    status: 'running',
  };
  const save = (name, value) =>
    writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await save('receipt.json', receipt);
  console.log(`Private evidence: ${directory}`);

  async function run(label, args, expectedExit = 0) {
    assert.deepEqual(
      await candidateFingerprint(),
      receipt.candidate,
      'Candidate changed; stop before next command'
    );
    const argv = ['--yes', '--command', '--kb-id', opts['--kb-id'], ...args];
    const sequence = String(receipt.steps.length + 1).padStart(2, '0');
    const entry = { label, argv, status: 'started', startedAt: new Date().toISOString() };
    receipt.steps.push(entry);
    await save('receipt.json', receipt);
    console.log(`${sequence} ${label}`);
    const started = Date.now();
    const result = await execute(wrapper, argv);
    entry.durationMs = Date.now() - started;
    entry.exitCode = result.code;
    entry.signal = result.signal;
    await save(`${sequence}-${label}.json`, result);
    let value;
    try {
      value = trailingJson(result.stdout);
    } catch {
      try {
        value = trailingJson(result.stderr);
      } catch {
        /* Preserve raw unknown outcome. */
      }
    }
    if (value) {
      // Persist known writes before an exit-code or semantic assertion can stop the run.
      rememberKnownIds(receipt, value, label);
      if (value.ids || value.steps || value.journalKey)
        entry.writeEvidence = {
          status: value.status,
          ids: value.ids,
          steps: value.steps,
          journalKey: value.journalKey,
          planHash: value.planHash,
        };
    }
    await save('receipt.json', receipt);
    entry.buildSha256 = await buildFingerprint();
    entry.status = result.code === expectedExit && !result.signal ? 'returned' : 'failed';
    await save('receipt.json', receipt);
    assert.equal(result.signal, null, `${label}: interrupted; preserve receipt and reconcile`);
    assert.equal(
      result.code,
      expectedExit,
      `${label}: unexpected exit; inspect private log, never replay`
    );
    assert.deepEqual(
      await candidateFingerprint(),
      receipt.candidate,
      'Candidate changed during command'
    );
    assert.ok(value, `${label}: no final JSON; preserve raw log and reconcile`);
    return value;
  }

  const inspect = (
    label,
    ids,
    fields = 'text,backText,cards,parent,children,isCardItem,hasCardStructure,practiceDirection'
  ) => run(label, ['inspect', ...ids, '--fields', fields, '--strict']);
  const inspectMissing = async (label, ids) => {
    const result = await run(label, ['inspect', ...ids, '--fields', 'text', '--strict'], 1);
    assertMissing(result, ids);
    return result;
  };
  const sync = (label, verb = '', args = [], expectedExit = 0) =>
    run(label, ['sync', ...(verb ? [verb] : []), workspace, ...args], expectedExit);
  const remoteText = (label, id, text) =>
    run(label, [
      'sdk',
      'rem',
      'object-set-text',
      '--target-id',
      id,
      '--args-json',
      JSON.stringify([[text]]),
    ]);
  let markdownPath;
  async function markdown() {
    const state = JSON.parse(await readFile(join(workspace, '.sync/state.json'), 'utf8'));
    assert.equal(state.kbId, opts['--kb-id']);
    const entry = state.entries[receipt.testIds.root];
    assert.ok(entry?.editable, 'Synthetic test root is not editable');
    markdownPath = resolve(workspace, entry.path);
    assert.ok(markdownPath.startsWith(`${workspace}${sep}`));
    return readFile(markdownPath, 'utf8');
  }
  const writeMarkdown = (value) => writeFile(markdownPath, value, { mode: 0o600 });
  async function apply(label, expected, extra = []) {
    const preview = await sync(`${label}-preview`, '', extra);
    assert.equal(preview.status, 'preview');
    assert.equal(preview.complete, true);
    assert.match(preview.planHash, /^[a-f0-9]{64}$/);
    assertDirections(preview, expected);
    assert.equal(preview.creates, expected.outgoing.filter((id) => id.startsWith('new:')).length);
    assert.equal(preview.updates, expected.outgoing.filter((id) => !id.startsWith('new:')).length);
    if (extra.length)
      assert.deepEqual(
        [...preview.deletion.ids].sort(),
        [receipt.testIds.question, receipt.testIds.answer].sort()
      );
    const applied = await sync(`${label}-apply`, '', [
      ...extra,
      '--apply',
      '--plan-hash',
      preview.planHash,
      ...(extra.length ? ['--allow-destructive'] : []),
    ]);
    assert.equal(applied.status, 'verified');
    assert.equal(applied.complete, true);
    assert.equal(applied.cardsPreserved, true);
    assertDirections(applied, expected, applied.ids);
    assert.deepEqual(
      [...applied.updated].sort(),
      expected.outgoing.filter((id) => !id.startsWith('new:')).sort()
    );
    assert.equal(applied.planHash, preview.planHash);
    return applied;
  }

  async function unchanged(label) {
    const result = await sync(label);
    assert.equal(result.status, 'unchanged');
    assert.equal(result.complete, true);
    assert.equal(result.changes, 0);
    assertCoverage(result);
  }

  try {
    const status = await run('status', ['status']);
    assert.equal(status.connected, true);
    assert.equal(status.knowledgeBaseId, opts['--kb-id']);
    assert.equal(status.protocolVersion, 1);
    assert.equal(status.acceptWriteOperations, true);
    assert.equal(status.acceptReplaceOperation, true);
    assert.ok(['remnote-cli-bridge', 'zeefan-remnote-sdk-bridge'].includes(status.pluginId));
    receipt.plugin = {
      pluginId: status.pluginId,
      sdkVersion: status.sdkVersion,
      sdkCatalogHash: status.sdkCatalogHash,
    };
    assert.equal((await run('platform', ['sdk', 'app', 'get-platform'])).value, 'app');
    const capabilities = await run('cleanup-capability', [
      'sdk',
      'capabilities',
      '--group',
      'rem',
      '--query',
      'remove',
    ]);
    assert.ok(
      capabilities.capabilities.some(
        (capability) =>
          capability.command === 'object-remove' &&
          capability.target === 'rem' &&
          capability.status === 'supported' &&
          capability.mode === 'destructive'
      )
    );
    remById(await inspect('parent-exists', [opts['--parent-id']], 'type'), opts['--parent-id']);
    const title = `[CLI-TEST]sync ${new Date().toISOString()}`;
    const created = await run('create-root', [
      'create',
      '--title',
      title,
      '--parent-id',
      opts['--parent-id'],
    ]);
    receipt.testIds.root = created.remIds?.[0];
    await save('receipt.json', receipt);
    assert.equal(created.remIds?.length, 1, 'Exactly one root required');
    assert.ok(receipt.testIds.root);
    const root = remById(
      await inspect('root-readback', [receipt.testIds.root]),
      receipt.testIds.root
    );
    assert.equal(root.parent.at(-1)?.id, opts['--parent-id']);
    assert.deepEqual(root.children, []);
    const imported = await sync('import-subtree', 'import', ['--root-id', receipt.testIds.root]);
    assert.equal(imported.status, 'imported');
    assert.equal(imported.complete, true);
    assert.equal(imported.scope, 'subtree');
    assert.equal(imported.globalDiscoveryComplete, false);
    const initial = await markdown();
    const blocks = { question: `local-${randomUUID()}`, answer: `local-${randomUUID()}` };
    receipt.blocks = blocks;
    await save('receipt.json', receipt);
    await writeMarkdown(appendMultiline(initial, blocks));
    assert.equal((await sync('create-lint', 'lint')).ok, true);
    const delta = await sync('create-diff', 'diff');
    assert.equal(delta.changes.length, 2);
    assert.equal(delta.remoteChecked, false);
    const createdCard = await apply('create-card', {
      incoming: [],
      outgoing: ['new:question', 'new:answer'],
      converged: [],
    });
    assertPublishedBlocks(await markdown(), receipt.testIds, blocks);
    const ids = [receipt.testIds.root, receipt.testIds.question, receipt.testIds.answer];
    assert.equal(new Set(ids).size, 3);
    const before = await inspect('card-readback', ids);
    const question = remById(before, receipt.testIds.question);
    const answer = remById(before, receipt.testIds.answer);
    assert.ok(question.cards.length > 0);
    assert.ok(question.cards.every((card) => card.type === 'forward'));
    receipt.nativeCardIds = question.cards.map((card) => card.id);
    assert.deepEqual(
      createdCard.nativeCards[question.id].map((card) => card.id).sort(),
      [...receipt.nativeCardIds].sort()
    );
    assert.equal(new Set(receipt.nativeCardIds).size, receipt.nativeCardIds.length);
    await save('receipt.json', receipt);
    assert.deepEqual(question.text, ['Sync acceptance question']);
    assert.deepEqual(question.backText, []);
    assert.equal(question.isCardItem, false);
    assert.equal(question.practiceDirection, 'forward');
    assert.deepEqual(question.children, [answer.id]);
    assert.equal(question.parent.at(-1)?.id, receipt.testIds.root);
    assert.deepEqual(answer.text, ['Sync acceptance answer']);
    assert.equal(answer.isCardItem, true, 'A multiline answer must be a native card item');
    assert.equal(answer.parent.at(-1)?.id, question.id);
    receipt.nativeCardSemantics = {
      questionHasCardStructure: question.hasCardStructure,
      answerIsCardItem: answer.isCardItem,
      cardTypes: question.cards.map((card) => card.type),
    };
    const good = await markdown();
    await writeMarkdown(`${good}\n- Missing stable anchor\n`);
    const lint = await sync('invalid-lint', 'lint', [], 1);
    assert.equal(lint.ok, false);
    assert.ok(
      lint.diagnostics.some((item) => item.code === 'BLOCK_BINDING' && item.line > 0 && item.path)
    );
    const rejected = await sync('invalid-sync', '', [], 1);
    assert.match(rejected.error, /BLOCK_BINDING/);
    const afterInvalid = await inspect('invalid-readback', ids);
    assert.deepEqual(afterInvalid, before, 'Lint-rejected sync changed native test state');
    receipt.lintFailureRemoteUnchanged = true;
    await writeMarkdown(
      replaceBodyOnce(
        replaceBodyOnce(good, 'Sync acceptance question', 'Sync acceptance revised question'),
        'Sync acceptance answer',
        'Sync acceptance revised answer'
      )
    );
    assert.equal((await sync('update-lint', 'lint')).ok, true);
    await apply('update-card', { incoming: [], outgoing: [question.id, answer.id], converged: [] });
    const updated = await inspect('updated-readback', ids);
    assert.deepEqual(remById(updated, question.id).text, ['Sync acceptance revised question']);
    assert.deepEqual(remById(updated, answer.id).text, ['Sync acceptance revised answer']);
    assert.deepEqual(cardIdentity(updated), cardIdentity(before), 'Card identity/history changed');
    for (const old of before.rems)
      for (const field of [
        'parent',
        'children',
        'isCardItem',
        'hasCardStructure',
        'practiceDirection',
        'backText',
      ])
        assert.deepEqual(remById(updated, old.id)[field], old[field], `Immutable ${field} changed`);
    await unchanged('noop-sync');
    assert.deepEqual(await inspect('noop-readback', ids), updated);

    await remoteText('remote-question-edit', question.id, 'Sync acceptance incoming question');
    await apply('incoming-only', { incoming: [question.id], outgoing: [], converged: [] });
    assert.ok((await markdown()).includes(`Sync acceptance incoming question ^${blocks.question}`));
    assertPublishedBlocks(await markdown(), receipt.testIds, blocks);
    assert.deepEqual(remById(await inspect('incoming-readback', ids), question.id).text, [
      'Sync acceptance incoming question',
    ]);

    await writeMarkdown(
      replaceBodyOnce(
        await markdown(),
        'Sync acceptance incoming question',
        'Sync acceptance mixed question'
      )
    );
    await remoteText('remote-answer-edit', answer.id, 'Sync acceptance mixed answer');
    await apply('mixed-directions', {
      incoming: [answer.id],
      outgoing: [question.id],
      converged: [],
    });
    const mixed = await inspect('mixed-readback', ids);
    assert.deepEqual(remById(mixed, question.id).text, ['Sync acceptance mixed question']);
    assert.deepEqual(remById(mixed, answer.id).text, ['Sync acceptance mixed answer']);
    assert.deepEqual(cardIdentity(mixed), cardIdentity(before), 'Bidirectional sync changed cards');
    assert.ok((await markdown()).includes(`Sync acceptance mixed answer ^${blocks.answer}`));
    assertPublishedBlocks(await markdown(), receipt.testIds, blocks);
    assert.deepEqual((await sync('mixed-diff', 'diff')).changes, []);
    await unchanged('mixed-noop');

    await writeMarkdown(
      replaceBodyOnce(
        await markdown(),
        'Sync acceptance mixed question',
        'Sync acceptance identical question'
      )
    );
    await remoteText('same-result-remote-edit', question.id, 'Sync acceptance identical question');
    await apply('same-result', { incoming: [], outgoing: [], converged: [question.id] });
    assertPublishedBlocks(await markdown(), receipt.testIds, blocks);
    const sameResult = await inspect('same-result-readback', ids);
    assert.deepEqual(remById(sameResult, question.id).text, ['Sync acceptance identical question']);
    assert.deepEqual(cardIdentity(sameResult), cardIdentity(before));
    await unchanged('same-result-noop');

    const localConflictText = 'Sync acceptance conflicting local question';
    const remoteConflictText = 'Sync acceptance conflicting remote question';
    await writeMarkdown(
      replaceBodyOnce(await markdown(), 'Sync acceptance identical question', localConflictText)
    );
    await remoteText('conflict-remote-edit', question.id, remoteConflictText);
    const conflictSource = await markdown();
    const conflictBaseline = await readFile(join(workspace, '.sync/state.json'), 'utf8');
    const conflictBefore = await inspect('conflict-native-before', ids);
    const conflictReceipt = await sync('same-rem-conflict', '', [], 1);
    const conflict = assertPlanningConflict(conflictReceipt, question.id);
    assert.equal(await markdown(), conflictSource, 'Conflict overwrote the local version');
    assert.equal(
      await readFile(join(workspace, '.sync/state.json'), 'utf8'),
      conflictBaseline,
      'Conflict advanced the common baseline'
    );
    const remoteCopy = JSON.parse(await readFile(join(workspace, conflict.remoteSnapshot), 'utf8'));
    assert.equal(remoteCopy.id, question.id);
    assert.deepEqual(remoteCopy.text, [remoteConflictText]);
    assert.deepEqual(
      await inspect('conflict-native-after', ids),
      conflictBefore,
      'Planning conflict changed native content'
    );
    receipt.conflictEvidence = {
      ...conflict,
      remoteWrites: 0,
      localPreserved: true,
      baselinePreserved: true,
      remotePreserved: true,
    };
    await save('receipt.json', receipt);
    // Resolve only this deliberate, known zero-write synthetic conflict by matching
    // local text to the observed remote value. Never retry an unknown mutation.
    await writeMarkdown(replaceBodyOnce(conflictSource, localConflictText, remoteConflictText));
    await apply('conflict-converged', { incoming: [], outgoing: [], converged: [question.id] });
    assert.deepEqual(
      JSON.parse(await readFile(join(workspace, conflict.remoteSnapshot), 'utf8')),
      remoteCopy,
      'Resolution removed or changed preserved conflict evidence'
    );
    assertPublishedBlocks(await markdown(), receipt.testIds, blocks);
    const resolved = await inspect('conflict-resolved-readback', ids);
    assert.deepEqual(remById(resolved, question.id).text, [remoteConflictText]);
    assert.deepEqual(cardIdentity(resolved), cardIdentity(before));
    await unchanged('conflict-resolved-noop');

    const deletion = ['--delete-id', question.id, '--scope-root', receipt.testIds.root];
    await apply('delete-card', { incoming: [], outgoing: [], converged: [] }, deletion);
    const remaining = remById(
      await inspect('delete-readback', [receipt.testIds.root]),
      receipt.testIds.root
    );
    assert.deepEqual(remaining.children, []);
    await inspectMissing('deleted-ids-absent', [question.id, answer.id]);
    const afterDeleteCards = await run('deleted-card-records', [
      'sdk',
      'card',
      'find-many',
      '--args-json',
      JSON.stringify([receipt.nativeCardIds]),
    ]);
    // Rem.remove() does not promise to purge historical Card records in the public SDK.
    // Record returned and unreturned IDs separately; neither result proves history was purged.
    Object.assign(receipt, cardReadback(afterDeleteCards.value, receipt.nativeCardIds));
    await save('receipt.json', receipt);
    await unchanged('delete-noop');
    const cleanupRoot = remById(
      await inspect('cleanup-root-fresh', [receipt.testIds.root], 'text,parent,children'),
      receipt.testIds.root
    );
    assert.deepEqual(cleanupRoot.text, [title]);
    assert.equal(cleanupRoot.parent.at(-1)?.id, opts['--parent-id']);
    assert.deepEqual(cleanupRoot.children, []);
    receipt.cleanupIntent = {
      ids: [receipt.testIds.root],
      parentId: opts['--parent-id'],
      text: cleanupRoot.text,
      children: [],
      verifiedStep: 'cleanup-root-fresh',
      recordedAt: new Date().toISOString(),
    };
    await save('receipt.json', receipt);
    await run('cleanup-root', [
      'sdk',
      'rem',
      'object-remove',
      '--target-id',
      receipt.testIds.root,
      '--allow-destructive',
    ]);
    await inspectMissing('cleanup-readback', ids);
    const finalStatus = await run('final-status', ['status']);
    for (const key of ['pluginId', 'sdkVersion', 'sdkCatalogHash'])
      assert.equal(finalStatus[key], receipt.plugin[key]);
    receipt.status = 'passed';
    receipt.cleanedIds = ids;
  } catch (error) {
    receipt.status = 'failed';
    receipt.failure = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    receipt.finishedAt = new Date().toISOString();
    await save('receipt.json', receipt);
    console.log(
      `Sync acceptance ${receipt.status}; private receipt: ${join(directory, 'receipt.json')}`
    );
  }
}

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help')) console.log(usage);
else if (argv.length === 1 && argv[0] === '--self-test') {
  assert.deepEqual(trailingJson('npm build\n> runner\n{\n  "ok": true\n}\n'), { ok: true });
  assert.deepEqual(trailingJson('banner\n{not json}\n{"error":"rejected"}'), { error: 'rejected' });
  assert.throws(() => trailingJson('no receipt'));
  assert.equal(replaceOnce('one two', 'one', 'three'), 'three two');
  assert.throws(() => replaceOnce('one one', 'one', 'three'));
  assert.throws(
    () =>
      options([
        '--kb-id',
        'kb',
        '--parent-id',
        'parent',
        '--evidence-root',
        '/tmp/.sync/acceptance',
      ]),
    /--yes/
  );
  assert.throws(() => options(['--yes', '--unexpected', 'value']), /Unknown argument/);
  assert.throws(() => options(['--yes', '--kb-id', 'a', '--kb-id', 'b']), /Duplicate/);
  const { renderDocument, parseDocument } = await import('../src/business/workspace/markdown.ts');
  const { renderFrontmatter } = await import('../src/business/workspace/metadata.ts');
  const { reconcile } = await import('../src/business/workspace/reconcile.ts');
  const { hash } = await import('../src/business/workspace/types.ts');
  const { inspectState } = await import('../src/business/state-inspect.ts');
  const root = {
    id: 'root',
    parent: null,
    children: [],
    type: null,
    text: ['Synthetic title'],
    backText: null,
    document: false,
    folder: false,
    cardItem: false,
    practice: 'forward',
    enablePractice: true,
  };
  const base = renderDocument(
    'root',
    'Note.md',
    new Map([['root', root]]),
    new Map([['root', 'Note.md']])
  );
  const blocks = {
    question: 'local-9a16e18d-9aa8-45dd-b3e3-aafc4ed0c501',
    answer: 'local-53f2289d-5ef8-42ae-bbc9-bf2d1430155f',
  };
  const fixture = appendMultiline(base, blocks);
  const parsed = parseDocument('Note.md', fixture);
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(
    parsed.document.nodes.map(({ key, kind }) => ({ key, kind })),
    [
      { key: 'root', kind: 'text' },
      { key: 'new:question', kind: 'multiline' },
      { key: 'new:answer', kind: 'text' },
    ]
  );
  assert.deepEqual(parsed.document.nodes[1].children, ['new:answer']);
  assert.deepEqual(parsed.document.nodes[2].text, ['Sync acceptance answer']);
  assert.deepEqual(Object.keys(documentParts(fixture).metadata.rems['new:answer']).sort(), [
    'block',
    'content',
    'id',
  ]);
  assert.throws(() => appendMultiline(fixture, blocks), /already exists/);
  assert.throws(
    () => appendMultiline(base, { question: blocks.question, answer: blocks.question }),
    /distinct blocks/
  );
  assert.ok(
    parseDocument('Note.md', `${fixture}\n- No block\n`).diagnostics.some(
      ({ code }) => code === 'BLOCK_BINDING'
    )
  );
  const invalidMetadata = documentParts(fixture).metadata;
  invalidMetadata.rems['new:answer'].native = { isCardItem: true };
  assert.ok(
    parseDocument(
      'Note.md',
      `---\n${stringify(invalidMetadata)}---\n\n${documentParts(fixture).body}`
    ).diagnostics.some(({ code }) => code === 'YAML_METADATA')
  );
  const display = documentParts(fixture).metadata;
  display.title = 'Sync acceptance question';
  display.aliases = ['Demo alias'];
  display.tags = ['demo'];
  const withDisplay = renderFrontmatter(display) + documentParts(fixture).body;
  const edited = replaceBodyOnce(
    withDisplay,
    'Sync acceptance question',
    'Revised question === >>'
  );
  assert.equal(documentParts(edited).metadata.title, 'Sync acceptance question');
  assert.deepEqual(documentParts(edited).metadata.aliases, ['Demo alias']);
  assert.deepEqual(parseDocument('Note.md', edited).document.nodes[1].text, [
    'Revised question === >>',
  ]);
  const assigned = { question: 'nativeQuestion', answer: 'nativeAnswer' };
  const published = documentParts(fixture).metadata;
  for (const key of ['question', 'answer']) {
    published.rems[assigned[key]] = { ...published.rems[`new:${key}`], id: assigned[key] };
    delete published.rems[`new:${key}`];
  }
  const publication = `---\n${stringify(published)}---\n\n${documentParts(fixture).body}`;
  assertPublishedBlocks(publication, assigned, blocks);
  assert.throws(
    () => assertPublishedBlocks(publication, assigned, { ...blocks, question: 'local-replaced' }),
    /stable block/
  );

  const coverage = {
    discoveryScope: 'bound-ids',
    globalDiscoveryComplete: false,
    remoteChecked: true,
  };
  const directions = { incoming: ['existing'], outgoing: ['new:question'], converged: [] };
  assertDirections({ ...coverage, atomic: false, ...directions }, directions);
  assertDirections(
    { ...coverage, atomic: false, ...directions, outgoing: ['nativeQuestion'] },
    directions,
    { 'new:question': 'nativeQuestion' }
  );
  assert.throws(() => assertCoverage({ ...coverage, globalDiscoveryComplete: true }));
  const absentIds = ['question', 'answer'];
  const absentSnapshot = await inspectState(
    { rem: { findMany: async () => [] } },
    { remIds: absentIds, fields: ['text'] }
  );
  assertMissing(absentSnapshot, absentIds);
  assert.throws(() => assertMissing({ ...absentSnapshot, rems: [] }, absentIds));
  assert.throws(() => assertMissing({ ...absentSnapshot, truncated: true }, absentIds));
  const failedRead = await inspectState(
    {
      rem: {
        findMany: async () => {
          throw new Error('offline failure');
        },
      },
    },
    { remIds: absentIds, fields: ['text'] }
  );
  assert.throws(() => assertMissing(failedRead, absentIds));
  assert.deepEqual(cardReadback([], ['card']), {
    retainedNativeCardIds: [],
    unreturnedNativeCardIds: ['card'],
  });
  assert.deepEqual(cardReadback([{ _id: 'one' }], ['one', 'two']), {
    retainedNativeCardIds: ['one'],
    unreturnedNativeCardIds: ['two'],
  });
  assert.throws(() => cardReadback([{ _id: 'one' }, { _id: 'one' }], ['one']), /Duplicate/);
  assert.throws(() => cardReadback([{ _id: 'other' }], ['one']), /Unexpected/);
  assert.throws(() => assertDirections({ ...coverage, atomic: true, ...directions }, directions));
  assert.throws(() =>
    assertDirections({ ...coverage, atomic: false, ...directions, incoming: [] }, directions)
  );
  const failed = { testIds: {} };
  rememberKnownIds(
    failed,
    { status: 'conflict', ids: { 'new:question': 'knownWritten' } },
    'apply'
  );
  assert.equal(failed.testIds.question, 'knownWritten');
  assert.throws(
    () => rememberKnownIds(failed, { ids: { 'new:question': 'different' } }, 'apply'),
    /Known ID changed/
  );

  // Reconcile synthetic in-memory values: no backend, file I/O or mutation is involved.
  const baseline = parseDocument('Note.md', base).document;
  const local = parseDocument(
    'Note.md',
    replaceBodyOnce(base, 'Synthetic title', 'Local edit')
  ).document;
  const context = { native: new Map([['root', root]]), parsed: new Map([['Note.md', local]]) };
  const localPlan = {
    version: 1,
    directory: '/synthetic',
    kbId: 'synthetic',
    baseHash: hash(root),
    files: { 'Note.md': local.fileHash },
    changes: [
      {
        key: 'root',
        path: 'Note.md',
        parent: null,
        position: 0,
        kind: 'text',
        cardItem: false,
        fields: { text: ['Local edit'] },
      },
    ],
  };
  const frozenInput = JSON.stringify([root, local, localPlan]);
  const conflict = reconcile(
    context,
    localPlan,
    new Map([['root', { ...root, text: ['Remote edit'] }]])
  );
  assert.equal(conflict.plan.conflicts[0].reason, 'untrusted-edit-order');
  assert.equal(conflict.plan.conflicts[0].remoteUpdatedAt, null);
  assert.equal(conflict.plan.changes.length, 0);
  assert.equal(JSON.stringify([root, local, localPlan]), frozenInput, 'Conflict modified input');
  const conflictReceipt = {
    ...coverage,
    status: 'conflict',
    complete: false,
    remoteWrites: 0,
    conflicts: conflict.plan.conflicts.map((item) => ({
      ...item,
      remoteSnapshot: `.sync/conflicts/${hash(conflict.plan)}/root-${hash(root)}.json`,
    })),
  };
  assertPlanningConflict(conflictReceipt, 'root');
  assert.throws(() => assertPlanningConflict({ ...conflictReceipt, remoteWrites: 1 }, 'root'));
  assert.throws(() => assertPlanningConflict({ ...conflictReceipt, status: 'unknown' }, 'root'));
  assert.deepEqual(
    reconcile(context, localPlan, new Map([['root', { ...root, text: ['Local edit'] }]])).plan
      .converged,
    ['root']
  );
  assert.deepEqual(
    reconcile(
      { ...context, parsed: new Map([['Note.md', baseline]]) },
      { ...localPlan, changes: [] },
      new Map([['root', { ...root, text: ['Remote edit'] }]])
    ).plan.incoming,
    ['root']
  );
  assert.equal(reconcile(context, localPlan, new Map()).plan.conflicts[0].reason, 'remote-missing');
  assert.equal(
    reconcile(context, localPlan, new Map([['root', { ...root, children: ['unknown'] }]])).plan
      .conflicts[0].reason,
    'remote-structure'
  );
  console.log(
    'Offline driver self-test passed: codec, stable blocks, receipt bounds, retained IDs and three-way conflicts; no live calls or filesystem writes.'
  );
} else {
  await main(argv).catch(() => {
    console.error(
      'Sync acceptance refused before live setup; check explicit arguments and private directory.'
    );
    process.exitCode = 1;
  });
}
