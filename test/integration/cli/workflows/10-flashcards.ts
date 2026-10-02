import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FlashcardsApplySchema } from '../../../../src/schemas/task-schemas.js';
import type { StepResult, WorkflowContext, WorkflowResult } from '../types.js';

interface InspectedRem {
  remId: string;
  text: unknown;
  textHash: string;
  parentRemId?: string;
  childrenRemIds: string[];
  ancestorRemIds: string[];
  remType: string;
  tags: string[];
  powerups: { cc: boolean };
  cards: Array<{ cardId: string; repetitionHistory: unknown[] }>;
}

export async function flashcardsWorkflow(
  ctx: WorkflowContext,
  tagTitle: string
): Promise<WorkflowResult> {
  const steps: StepResult[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'remnote-cli-flashcards-'));
  console.log(`Flashcard evidence and recovery plan: ${directory}`);
  let label = 'Resolve exact live prerequisites';
  let start = Date.now();
  let commandIndex = 0;

  async function jsonFile(name: string, value: unknown): Promise<string> {
    const path = join(directory, name);
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    return path;
  }

  async function run(args: string[]): Promise<Record<string, unknown>> {
    const began = Date.now();
    const result = await ctx.cli.run(args, 70000);
    await jsonFile(`command-${++commandIndex}.json`, {
      args,
      durationMs: Date.now() - began,
      ...result,
    });
    const errors = (result.json as { errors?: Array<{ code: string; remId?: string }> })?.errors;
    if (result.exitCode !== 0 && Array.isArray(errors)) {
      for (const error of errors.filter((item) => item.code === 'children_failed').slice(0, 3)) {
        if (!error.remId) continue;
        await run(['sdk', 'rem', 'find-one', '--args-json', JSON.stringify([error.remId])]);
        await run([
          'sdk',
          'rem',
          'object-get-children-rem',
          '--target-id',
          error.remId,
          '--args-json',
          '[]',
        ]);
      }
    }
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.ok(result.json && typeof result.json === 'object', 'Expected a JSON response');
    return result.json as Record<string, unknown>;
  }

  async function inspect(name: string, remIds: string[]): Promise<InspectedRem[]> {
    const request = await jsonFile(`${name}.json`, { schemaVersion: 1, remIds });
    const result = await run(['context', '--request', request]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.errors, []);
    return result.objects as InspectedRem[];
  }

  async function findExact(title: string, remType: 'folder' | 'concept'): Promise<string> {
    const result = await run(['search', title, '--limit', '150', '--content-mode', 'none']);
    assert.ok(Array.isArray(result.results));
    assert.ok(result.results.length < 150, 'Search limit reached; exact match may be ambiguous');
    const matches = (
      result.results as Array<{ title: string; remId: string; remType: string }>
    ).filter(
      (rem) =>
        rem.remType === remType &&
        rem.title.normalize('NFKC').trim() === title.normalize('NFKC').trim()
    );
    assert.equal(matches.length, 1, `Expected one existing exact match for ${title}`);
    return matches[0].remId;
  }

  function passed(): void {
    steps.push({ label, passed: true, durationMs: Date.now() - start });
  }

  try {
    assert.ok(tagTitle?.trim(), '--flashcards-only requires an existing HOME concept title');
    const status = await run(['status']);
    assert.equal(status.connected, true);
    assert.equal(status.acceptWriteOperations, true);
    assert.equal(status.protocolVersion, 1);
    assert.equal(status.pluginId, 'zeefan-remnote-sdk-bridge');
    assert.ok(typeof status.knowledgeBaseId === 'string' && status.knowledgeBaseId);
    assert.match(String(status.sdkCatalogHash), /^[a-f0-9]{64}$/);
    const platform = await run(['sdk', 'app', 'get-platform']);
    assert.equal(platform.value, 'app', 'Acceptance must use RemNote desktop');
    const homeRootId = await findExact('HOME', 'folder');
    const tagRemId = await findExact(tagTitle, 'concept');
    const date = new Date();
    // Resolve the explicit host date, not a potentially stale open RemNote daily tab.
    const daily = await run([
      'sdk',
      'date',
      'get-daily-doc',
      '--args-json',
      JSON.stringify([{ $type: 'date', value: date.toISOString() }]),
    ]);
    const dailyRemId = (daily.value as { id?: string })?.id;
    assert.ok(dailyRemId, 'The native daily-document lookup must return an exact ID');
    const prerequisiteIds = [dailyRemId, homeRootId, tagRemId];
    const before = await inspect('before-preview', prerequisiteIds);
    const byId = new Map(before.map((rem) => [rem.remId, rem]));
    assert.equal(byId.get(dailyRemId)?.remType, 'dailyDocument');
    assert.equal(byId.get(homeRootId)?.remType, 'folder');
    assert.equal(byId.get(tagRemId)?.remType, 'concept');
    assert.ok(byId.get(tagRemId)?.ancestorRemIds.includes(homeRootId));
    passed();

    label = 'Preview is complete and leaves existing Rems unchanged';
    start = Date.now();
    const key = `cli-flashcards-${ctx.runId.replace(/[^A-Za-z0-9._-]/g, '-')}`;
    const { plan } = FlashcardsApplySchema.parse({
      schemaVersion: 1,
      idempotencyKey: key,
      plan: {
        schemaVersion: 1,
        dailyRemId,
        homeRootId,
        tagRemId,
        title: `[CLI-TEST] Two-card task ${ctx.runId}`,
        newCards: [
          {
            key: 'preview',
            question: '[CLI-TEST] Does a flashcard preview write RemNote content?',
            answer: [['No. Preview validates the plan without writing card content.']],
          },
          {
            key: 'replay',
            question: '[CLI-TEST] What must a verified same-key replay preserve?',
            answer: [['The same Rem IDs, native card IDs, content, and review history.']],
          },
        ],
      },
    });
    const planPath = await jsonFile('plan.json', plan);
    await jsonFile('batch.json', { idempotencyKey: key, resolvedAt: date.toISOString(), planPath });
    const args = ['flashcards', 'apply', '--plan', planPath, '--idempotency-key', key];
    const preview = await run(args);
    assert.equal(preview.status, 'preview');
    assert.equal(preview.complete, true);
    assert.deepEqual(preview.errors, []);
    assert.deepEqual(preview.created, []);
    assert.deepEqual(await inspect('after-preview', prerequisiteIds), before);
    passed();

    label = 'Apply creates one cluster with two verified native cards';
    start = Date.now();
    assert.equal(new Date().toDateString(), date.toDateString(), 'Date changed; do not apply');
    const applied = await run([...args, '--apply']);
    assert.equal(applied.status, 'verified');
    assert.equal(applied.complete, true);
    assert.deepEqual(applied.errors, []);
    const ids = applied.ids as Record<string, string>;
    assert.equal(ids.daily, dailyRemId);
    assert.equal(ids.tag, tagRemId);
    const cards = plan.newCards!;
    const cardIds = cards.map((card) => ids[`card:${card.key}`]);
    const answerIds = cards.map((card) => ids[`answer:${card.key}:0`]);
    const ownedIds = [ids.root, ...cardIds, ...answerIds];
    assert.ok(ownedIds.every((id) => typeof id === 'string' && id.length > 0));
    assert.equal(new Set(ownedIds).size, 5);
    passed();

    label = 'Fresh readback verifies text, parent edges, HOME tag, cluster, and full card scope';
    start = Date.now();
    const expectation = await jsonFile('verify.json', {
      schemaVersion: 1,
      inspect: {
        schemaVersion: 1,
        remIds: ownedIds,
        subtreeRootIds: [ids.root],
        tagRemIds: [tagRemId],
      },
      expectations: [
        { kind: 'parent', remId: ids.root, value: dailyRemId },
        { kind: 'tag', remId: ids.root, value: tagRemId },
        { kind: 'powerup', remId: ids.root, code: 'cc', value: true },
        { kind: 'children', remId: ids.root, value: cardIds },
        { kind: 'cardRemIds', remId: ids.root, value: cardIds },
      ],
    });
    const verified = await run(['verify', 'scope', '--expect', expectation]);
    assert.equal(verified.status, 'passed');
    const objects = new Map((verified.objects as InspectedRem[]).map((rem) => [rem.remId, rem]));
    assert.deepEqual(objects.get(ids.root)?.text, [plan.title]);
    const nativeCardIds: string[] = [];
    for (let i = 0; i < cards.length; i++) {
      const card = objects.get(cardIds[i])!;
      const answer = objects.get(answerIds[i])!;
      assert.deepEqual(card.text, [cards[i].question]);
      assert.equal(card.parentRemId, ids.root);
      assert.deepEqual(card.childrenRemIds, [answerIds[i]]);
      assert.ok(!card.tags.includes(tagRemId), 'Cluster children must not repeat the HOME tag');
      assert.equal(answer.parentRemId, card.remId);
      assert.deepEqual(answer.text, cards[i].answer[0]);
      assert.equal(card.cards.length, 1);
      assert.equal(answer.cards.length, 0);
      nativeCardIds.push(card.cards[0].cardId);
    }
    assert.equal(new Set(nativeCardIds).size, 2);
    passed();

    label = 'Verified same-key replay preserves IDs, content, history, and child lists';
    start = Date.now();
    const beforeReplay = await inspect('before-replay', [...ownedIds, ...prerequisiteIds]);
    const replayed = await run([...args, '--apply']);
    assert.equal(replayed.status, 'verified');
    assert.equal(replayed.complete, true);
    assert.deepEqual(replayed.errors, []);
    assert.deepEqual(replayed.ids, applied.ids);
    assert.deepEqual(replayed.created, applied.created);
    assert.deepEqual(replayed.facts, applied.facts);
    assert.deepEqual(
      await inspect('after-replay', [...ownedIds, ...prerequisiteIds]),
      beforeReplay
    );
    passed();

    label = 'CLI-only SDK composition reads both Rems and counts the same native cards';
    start = Date.now();
    const composedCardIds: string[] = [];
    for (let index = 0; index < cardIds.length; index++) {
      const rem = await run([
        'sdk',
        'rem',
        'find-one',
        '--args-json',
        JSON.stringify([cardIds[index]]),
      ]);
      assert.deepEqual((rem.value as { text: unknown }).text, [cards[index].question]);
      const result = await run(['sdk', 'rem', 'object-get-cards', '--target-id', cardIds[index]]);
      assert.ok(Array.isArray(result.value));
      assert.equal(result.value.length, 1);
      composedCardIds.push((result.value[0] as { id: string }).id);
    }
    assert.deepEqual(composedCardIds, nativeCardIds);
    const finalStatus = await run(['status']);
    for (const field of [
      'pluginId',
      'pluginVersion',
      'sdkVersion',
      'sdkCatalogHash',
      'knowledgeBaseId',
    ]) {
      assert.equal(finalStatus[field], status[field], `${field} changed during acceptance`);
    }
    passed();
    await jsonFile('result.json', {
      ids,
      nativeCardIds,
      composedCardCount: composedCardIds.length,
      status,
      steps,
    });
    console.log(JSON.stringify({ ids, nativeCardIds, evidenceDirectory: directory }));
  } catch (error) {
    steps.push({ label, passed: false, durationMs: Date.now() - start, error: String(error) });
    console.error(
      `Stopped without retry. Preserve ${directory}; reconcile any partial/unknown write before another batch.`
    );
  }
  return { name: 'Two-card flashcard task', steps, skipped: false };
}
