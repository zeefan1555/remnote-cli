import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connection } from '../../../../src/remnote-cli/client/connection.js';
import { readConnectionConfig } from '../../../../src/remnote-cli/client/connection-config.js';
import { remoteSdk } from '../../../../src/remnote-cli/client/remote-sdk.js';
import { verifiedCatalog } from '../../../../src/remnote-cli/client/sdk-capabilities.js';
import type { StepResult, WorkflowContext, WorkflowResult } from '../types.js';

// Uses the CLI's actual session/SDK client; no test-only plugin action or cleanup deletion.
export async function transactionsWorkflow(ctx: WorkflowContext): Promise<WorkflowResult> {
  const directory = await mkdtemp(join(tmpdir(), 'remnote-cli-transactions-'));
  console.log(`Transaction evidence and recovery plan: ${directory}`);
  const title = `[CLI-TEST] Native transaction ${ctx.runId}`;
  const committedTitle = `${title} committed`;
  const ids: { root?: string; abortedChild?: string } = {};
  const steps: StepResult[] = [];
  let label = 'Authenticate the independent desktop plugin';
  let started = Date.now();
  let connection: Connection | undefined;
  const record = async (name: string, value: unknown) => {
    await writeFile(join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
  };
  const passed = () => steps.push({ label, passed: true, durationMs: Date.now() - started });

  try {
    const config = await readConnectionConfig();
    const open = async (current: Connection) => {
      const identity = await current.open();
      const status = (await current.request('get_status', {})) as { pluginId: string };
      assert.equal(status.pluginId, 'zeefan-remnote-sdk-bridge');
      assert.equal(identity.knowledgeBaseId, config.knowledgeBaseId);
      assert.equal(identity.acceptWriteOperations, true);
      const catalog = verifiedCatalog(await current.request('get_sdk_capabilities', {}));
      assert.equal(catalog.sdkCatalogHash, identity.sdkCatalogHash);
      assert.equal(catalog.sdkVersion, identity.sdkVersion);
      const plugin = remoteSdk(current, catalog, false);
      assert.equal(await plugin.app.getPlatform(), 'app', 'Use RemNote desktop, not the browser');
      return plugin;
    };
    connection = new Connection(config, 'transaction-acceptance');
    let plugin = await open(connection);
    await record('intent', { title, committedTitle, knowledgeBaseId: config.knowledgeBaseId });
    passed();

    label = 'Create only the dedicated transaction test root';
    started = Date.now();
    const root = await plugin.rem.createRem();
    assert.ok(root, 'Native createRem must return its ID');
    ids.root = root._id;
    await record('root', ids);
    await root.setText([title]);
    assert.deepEqual((await plugin.rem.findOne(root._id))?.text, [title]);
    passed();

    label = 'Abort rolls back both an existing test root edit and a new child';
    started = Date.now();
    const abort = new Error('Intentional native transaction abort');
    await assert.rejects(
      plugin.app.transaction(async () => {
        await root.setText([`${title} must roll back`]);
        const child = await plugin.rem.createRem();
        assert.ok(child);
        ids.abortedChild = child._id;
        await record('child-before-abort', ids);
        await child.setParent(root._id);
        await child.setText([`${title} child must not persist`]);
        assert.deepEqual((await plugin.rem.findOne(root._id))?.text, [`${title} must roll back`]);
        throw abort;
      }),
      (error) => error === abort
    );
    assert.deepEqual((await plugin.rem.findOne(root._id))?.text, [title]);
    assert.ok(ids.abortedChild);
    assert.ok(!(await plugin.rem.findOne(ids.abortedChild)), 'Aborted child still exists');
    await record('abort-readback', { ...ids, rootText: [title], childAbsent: true });
    passed();

    label = 'Explicit commit persists after its acknowledgement';
    started = Date.now();
    await plugin.app.transaction(async () => root.setText([committedTitle]));
    assert.deepEqual((await plugin.rem.findOne(root._id))?.text, [committedTitle]);
    await record('session-timings', connection!.timings);
    await connection!.close();
    passed();

    label = 'A fresh session sees the commit and no aborted child';
    started = Date.now();
    connection = new Connection(config, 'transaction-acceptance');
    plugin = await open(connection);
    assert.deepEqual((await plugin.rem.findOne(ids.root))?.text, [committedTitle]);
    assert.ok(!(await plugin.rem.findOne(ids.abortedChild)));
    passed();
    await record('result', { ids, committedTitle, steps, timings: connection!.timings });
    console.log(JSON.stringify({ ids, committedTitle, evidenceDirectory: directory }));
  } catch (error) {
    steps.push({ label, passed: false, durationMs: Date.now() - started, error: String(error) });
    await record('failure', { ids, steps });
    console.error(`Stopped without retry. Reconcile ${directory} before any further writes.`);
  } finally {
    await connection?.close();
  }
  return { name: 'Native transaction commit and rollback', steps, skipped: false };
}
