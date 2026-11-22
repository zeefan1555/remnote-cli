import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_ORIGIN,
  Connection,
  MAX_PENDING_REQUESTS,
  PROTOCOL_VERSION,
  type BridgeIdentity,
} from '../../../src/remnote-cli/client/connection.js';

const identity: BridgeIdentity = {
  pluginVersion: 'independent-plugin',
  sdkVersion: '0.0.46',
  sdkCatalogHash: 'b'.repeat(64),
  knowledgeBaseId: 'kb',
  knowledgeBaseName: 'Test',
};
const connections: Connection[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.terminate());
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
});

async function listen(timeout = 2000, port = 0, knowledgeBaseId?: string) {
  const connection = new Connection({ port, knowledgeBaseId }, 'arbitrary-cli', timeout);
  connections.push(connection);
  const opened = connection.open();
  void opened.catch(() => {});
  const server = (connection as unknown as { server: WebSocketServer }).server;
  await once(server, 'listening');
  const address = server.address() as { address: string; port: number };
  expect(address.address).toBe('127.0.0.1');
  return { connection, opened, port: address.port };
}

async function plugin(port: number, overrides: Partial<BridgeIdentity> = {}) {
  const ws = new WebSocket('ws://127.0.0.1:' + port, { origin: ALLOWED_ORIGIN });
  sockets.push(ws);
  ws.on('error', () => {});
  const message = once(ws, 'message');
  await once(ws, 'open');
  const hello = JSON.parse(String((await message)[0]));
  expect(hello).toEqual({
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    version: 'arbitrary-cli',
  });
  const ready = { ...identity, ...overrides };
  ws.send(JSON.stringify({ type: 'ready', protocolVersion: PROTOCOL_VERSION, identity: ready }));
  return ws;
}

async function expectOriginRejected(port: number, origin?: string) {
  const ws = new WebSocket('ws://127.0.0.1:' + port, origin === undefined ? undefined : { origin });
  sockets.push(ws);
  ws.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    ws.on('unexpected-response', (_request, response) => {
      expect(response.statusCode).toBe(403);
      response.resume();
      resolve();
    });
    ws.on('open', () => reject(new Error('Unexpected WebSocket acceptance')));
  });
}

describe('zero-configuration command-owned loopback session', () => {
  it('accepts only the observed RemNote Origin and sends protocol 2 hello', async () => {
    const { opened, port } = await listen();
    await expectOriginRejected(port);
    await expectOriginRejected(port, 'https://example.com');
    await plugin(port);
    await expect(opened).resolves.toEqual(identity);
  });

  it('uses monotonic IDs, correlates concurrent requests and releases its port', async () => {
    const { connection, opened, port } = await listen();
    const ws = await plugin(port);
    expect(await opened).toEqual(identity);
    expect(connection.open()).toBe(opened);
    const seen: Record<string, unknown>[] = [];
    ws.on('message', (raw) => {
      const request = JSON.parse(String(raw));
      if (!request.id) return;
      seen.push(request);
      ws.send(JSON.stringify({ id: 'unrelated', result: 'ignored' }));
      ws.send(JSON.stringify({ id: request.id, result: request.payload }));
    });
    expect(
      await connection.request('sdk_call', { capability: 'first', args: [{ n: 1 }] })
    ).toMatchObject({ capability: 'first', args: [{ n: 1 }], allowDestructive: false });
    expect(
      await connection.request('sdk_call', { capability: 'second', args: [{ n: 2 }] })
    ).toMatchObject({ capability: 'second', args: [{ n: 2 }], allowDestructive: false });
    expect(seen.map(({ id }) => id)).toEqual(['1', '2']);
    for (const frame of seen) {
      expect(frame).toMatchObject({ knowledgeBaseId: 'kb' });
      expect(Number(frame.deadline)).toBeGreaterThan(Date.now() - 1000);
    }
    expect(connection.timings.listeningMs).toBeGreaterThanOrEqual(0);
    expect(connection.timings.sdkCalls).toBe(2);
    await connection.close();
    const next = await listen(2000, port);
    expect(next.port).toBe(port);
  });

  it('does not product-version match a complete live SDK identity', async () => {
    const { opened, port } = await listen();
    await plugin(port, { pluginVersion: '99.0.0' });
    await expect(opened).resolves.toMatchObject({ pluginVersion: '99.0.0' });
  });

  it('rejects a mismatched explicit KB before a request', async () => {
    const { connection, opened, port } = await listen(2000, 0, 'expected-kb');
    const expected = expect(opened).rejects.toThrow('Knowledge base mismatch');
    await plugin(port);
    await expected;
    await expect(connection.request('sdk_call', { capability: 'namespace:test' })).rejects.toThrow(
      'Knowledge base mismatch'
    );
  });

  it.each([
    { type: 'challenge', protocolVersion: 2 },
    { type: 'ready', protocolVersion: 1, identity },
    { type: 'ready', protocolVersion: 2, identity: { ...identity, sdkVersion: '' } },
  ])('rejects an unsupported handshake before SDK work', async (message) => {
    const { connection, opened, port } = await listen();
    const ws = new WebSocket('ws://127.0.0.1:' + port, { origin: ALLOWED_ORIGIN });
    sockets.push(ws);
    const hello = once(ws, 'message');
    await once(ws, 'open');
    await hello;
    ws.send(JSON.stringify(message));
    await expect(opened).rejects.toThrow('Unsupported plugin handshake');
    expect(connection.timings.sdkCalls).toBe(0);
  });

  it('fails closed on an occupied port without stopping the existing listener', async () => {
    const first = await listen();
    const second = new Connection({ port: first.port }, 'v');
    connections.push(second);
    await expect(second.open()).rejects.toThrow('port occupied');
    const ws = await plugin(first.port);
    await first.opened;
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('reports a missing plugin and cleans up a cancelled open', async () => {
    const missing = await listen(10);
    await expect(missing.opened).rejects.toThrow('connection timed out');
    await missing.connection.close();
    const cancelled = await listen();
    const failure = expect(cancelled.opened).rejects.toThrow('closed');
    await cancelled.connection.close();
    await failure;
  });

  it('closes timed-out sessions and never reconnects or replays the pending write', async () => {
    const { connection, opened, port } = await listen();
    const ws = await plugin(port);
    await opened;
    const requests = vi.fn();
    ws.on('message', requests);
    await expect(connection.request('sdk_call', { capability: 'write' }, 15)).rejects.toThrow(
      'outcome unknown'
    );
    await expect(connection.request('sdk_call', { capability: 'write' })).rejects.toThrow();
    expect(requests.mock.calls.filter(([raw]) => JSON.parse(String(raw)).action)).toHaveLength(1);
  });

  it('rejects malformed responses, propagates SDK errors and binds results to a socket', async () => {
    const { connection, opened, port } = await listen();
    const ws = await plugin(port);
    await opened;
    let call = 0;
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if (!frame.id) return;
      ws.send(
        JSON.stringify(
          call++ === 0 ? { id: frame.id, error: 'permission denied' } : { id: frame.id }
        )
      );
    });
    await expect(connection.request('sdk_call', { capability: 'read' })).rejects.toThrow(
      'permission denied'
    );
    await expect(connection.request('sdk_call', { capability: 'read' })).rejects.toThrow(
      'Malformed response'
    );
    const pending = connection.request('sdk_call', { capability: 'read' });
    const failed = expect(pending).rejects.toThrow();
    ws.terminate();
    await failed;
  });

  it('queues requests beyond the in-flight window instead of rejecting them', async () => {
    const { connection, opened, port } = await listen();
    const ws = await plugin(port);
    await opened;
    await expect(connection.request('sdk_call', { capability: 'read' }, 0)).rejects.toThrow(
      'Invalid SDK timeout'
    );
    await expect(
      connection.request('sdk_call', { capability: 'x'.repeat(8 * 1024 * 1024) })
    ).rejects.toThrow('too large');
    const seen: Array<{ id: string }> = [];
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { id?: string; action?: string };
      if (!frame.id || !frame.action) return;
      seen.push({ id: frame.id });
    });
    const total = MAX_PENDING_REQUESTS + 8;
    const pending = Array.from({ length: total }, () =>
      connection.request('sdk_call', { capability: 'read' })
    );
    await vi.waitFor(() => expect(connection.timings.sdkCalls).toBe(MAX_PENDING_REQUESTS));
    expect(seen).toHaveLength(MAX_PENDING_REQUESTS);
    for (let index = 0; index < total; index++) {
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(index));
      ws.send(JSON.stringify({ id: seen[index]!.id, result: { capability: 'read' } }));
    }
    await expect(Promise.all(pending)).resolves.toHaveLength(total);
    expect(seen).toHaveLength(total);
    expect(connection.timings.sdkCalls).toBe(total);
  });

  it('rejects unknown actions and malformed known payloads before opening a listener', async () => {
    const connection = new Connection({ port: 0 }, 'v', 10);
    connections.push(connection);
    await expect(connection.request('create_note', {})).rejects.toThrow('Unknown Bridge action');
    await expect(connection.request('get_status', { unexpected: true })).rejects.toThrow();
    expect((connection as unknown as { server?: WebSocketServer }).server).toBeUndefined();
  });
});
