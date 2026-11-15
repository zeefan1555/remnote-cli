// Synthetic transport only: no SDK runtime, pairing file, native data or installation.
// Run: node --import tsx scripts/verify-transport-loopback.mjs /path/to/bridge 200001
import assert from 'node:assert/strict';
import console from 'node:console';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { Connection } from '../src/remnote-cli/client/connection.ts';

const [bridgeRoot, countText = '200001'] = process.argv.slice(2);
const count = Number(countText);
assert(bridgeRoot && Number.isSafeInteger(count) && count > 0);
globalThis.WebSocket = WebSocket;
const { WebSocketClient } = await import(
  pathToFileURL(resolve(bridgeRoot, 'src/bridge/websocket-client.ts')).href
);
const token = 'a'.repeat(64);
const connection = new Connection(
  { schemaVersion: 1, token, knowledgeBaseId: 'synthetic-kb', port: 0 },
  'synthetic-loopback'
);
const opened = connection.open();
void opened.catch(() => {});
await once(connection.server, 'listening');
const port = connection.server.address().port;
const logs = [];
const bridge = new WebSocketClient({
  url: `ws://127.0.0.1:${port}`,
  pluginVersion: 'synthetic-loopback',
  getToken: async () => token,
  getIdentity: async () => ({
    knowledgeBaseId: 'synthetic-kb',
    knowledgeBaseName: 'Synthetic',
    acceptWriteOperations: false,
    acceptReplaceOperation: false,
  }),
  onLog: (message) => logs.push(message),
});
let invoked = 0;
let lastId = 0;
let completed = 0;
let reordered = false;
let lastCompleted = 0;
const ids = new Set();
let sessionState;
const handleFrame = bridge.handleFrame.bind(bridge);
bridge.handleFrame = async (ws, event, session, current) => {
  sessionState = session;
  return handleFrame(ws, event, session, current);
};
let previousInvokedId = 0;
bridge.setMessageHandler(async (request) => {
  invoked++;
  assert(!ids.has(request.id), 'duplicate invocation');
  ids.add(request.id);
  if (/^[1-9][0-9]*$/.test(request.id)) {
    assert(Number(request.id) > previousInvokedId, 'dispatch order');
    previousInvokedId = Number(request.id);
  }
  // Deliberately reorder early responses without adding 200k timers.
  if (invoked <= 16 && invoked % 2) await new Promise((r) => setTimeout(r, 10));
  if (Number(request.id) < lastCompleted) reordered = true;
  lastCompleted = Number(request.id);
  return { sequence: request.payload.sequence, id: request.id };
});
bridge.connect();
const start = performance.now();
try {
  await opened;
  let allocated = 0;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (allocated < count) {
        const sequence = ++allocated;
        const result = await connection.request('synthetic', { sequence });
        assert.equal(result.sequence, sequence);
        if (/^[1-9][0-9]*$/.test(result.id)) lastId = Math.max(lastId, Number(result.id));
        completed++;
      }
    })
  );
  assert.equal(invoked, count);
  assert.equal(ids.size, count);
  assert.equal(completed, count);
  assert.equal(lastId, count, 'canonical monotonic IDs');
  assert(reordered, 'out-of-order response fixture was exercised');
  assert.equal(sessionState.highWaterId, count);
  assert.deepEqual(Object.keys(sessionState).sort(), [
    'authenticated',
    'challenged',
    'highWaterId',
    'identity',
  ]);
  assert.equal(bridge.outstanding, 0);
  assert.equal(bridge.slotWaiters.length, 0);
  assert(!logs.some((line) => line.includes(token)), 'token leaked');
  console.log(
    JSON.stringify({
      result: 'PASS',
      count,
      invoked,
      uniqueIds: ids.size,
      completed,
      lastId,
      reordered,
      dedupState: { highWaterId: sessionState.highWaterId, retainedIds: 0 },
      elapsedMs: Math.round(performance.now() - start),
    })
  );
} catch (error) {
  console.error(
    JSON.stringify({
      result: 'FAIL',
      count,
      invoked,
      uniqueIds: ids.size,
      completed,
      elapsedMs: Math.round(performance.now() - start),
      error: error.message,
    })
  );
  process.exitCode = 1;
} finally {
  bridge.disconnect();
  await connection.close();
}
