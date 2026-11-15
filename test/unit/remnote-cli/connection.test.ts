import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCEPTED_PLUGIN_IDS,
  ACCEPTED_PLUGIN_NAMES,
  Connection,
  proof,
  type BridgeIdentity,
} from '../../../src/remnote-cli/client/connection.js';

const token = 'a'.repeat(64);
const identity: BridgeIdentity = {
  protocolVersion: 1,
  pluginVersion: 'independent-plugin',
  sdkVersion: '0.0.46',
  sdkCatalogHash: 'b'.repeat(64),
  knowledgeBaseId: 'kb',
  knowledgeBaseName: 'Test',
  acceptWriteOperations: true,
  acceptReplaceOperation: false,
};
const connections: Connection[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  sockets.splice(0).forEach((s) => s.terminate());
  await Promise.all(connections.splice(0).map((c) => c.close()));
});
async function listen(timeout = 2000, port = 0) {
  const connection = new Connection(
    { protocolVersion: 1, token, knowledgeBaseId: 'kb', port },
    'arbitrary-cli',
    timeout
  );
  connections.push(connection);
  const opened = connection.open();
  void opened.catch(() => {});
  const server = (connection as unknown as { server: WebSocketServer }).server;
  await once(server, 'listening');
  const address = server.address() as { address: string; port: number };
  expect(address.address).toBe('127.0.0.1');
  return { connection, opened, port: address.port };
}
async function plugin(port: number, overrides: Partial<BridgeIdentity> = {}, secret = token) {
  const ws = new WebSocket('ws://127.0.0.1:' + port);
  sockets.push(ws);
  ws.on('error', () => {});
  const challenge = JSON.parse(String((await once(ws, 'message'))[0]));
  expect(challenge.proof).toBe(proof(token, 'cli:' + challenge.nonce));
  const peer = { ...identity, ...overrides };
  ws.send(
    JSON.stringify({
      type: 'hello',
      identity: peer,
      proof: proof(secret, 'plugin:' + challenge.nonce + ':' + JSON.stringify(peer)),
    })
  );
  return ws;
}
describe('command-owned loopback session', () => {
  it('authenticates once, correlates multiple requests and releases its port', async () => {
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
    expect(await connection.request('first', { n: 1 })).toEqual({ n: 1 });
    expect(await connection.request('second', { n: 2 })).toEqual({ n: 2 });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ knowledgeBaseId: 'kb' });
    expect(Number(seen[0].deadline)).toBeGreaterThan(Date.now() - 1000);
    expect(connection.timings.sdkCalls).toBe(2);
    await connection.close();
    const next = await listen(2000, port);
    expect(next.port).toBe(port);
  });

  it.each([
    [4008, 'Protocol or authentication failure', 'protocol-or-authentication-failure'],
    [4008, 'Authentication timeout', 'authentication-timeout'],
    [1000, 'Command session ended', 'command-session-ended'],
  ] as const)(
    'reports close code %i and the safe label for %s without replaying concurrent requests',
    async (code, reason, label) => {
      const { connection, opened, port } = await listen();
      const ws = await plugin(port);
      await opened;
      const requests: string[] = [];
      ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.id) requests.push(frame.id);
      });
      const outcomes = Promise.allSettled([
        connection.request('first', {}),
        connection.request('second', {}),
      ]);
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      const closed = once(ws, 'close');
      ws.close(code, reason);
      await closed;
      const message =
        'Connection lost; write outcome unknown. Do not blindly replay. ' +
        `WebSocket close code=${code}, reason=${label}.`;
      for (const outcome of await outcomes) {
        expect(outcome.status).toBe('rejected');
        if (outcome.status === 'rejected') {
          expect(outcome.reason).toBeInstanceOf(Error);
          expect(outcome.reason.message).toBe(message);
        }
      }
      await expect(connection.request('later', {})).rejects.toThrow(message);
      expect(requests).toHaveLength(2);
      expect(connection.timings.sdkCalls).toBe(2);
    }
  );

  it.each([
    { label: 'arbitrary text', reason: 'private knowledge base detail' },
    { label: 'token-shaped text', reason: 'e'.repeat(64) },
    { label: 'control characters', reason: 'Protocol or authentication failure\n\u001b[31m' },
    {
      label: 'a known prefix with private suffix',
      reason: 'Command session ended: ' + 'd'.repeat(64),
    },
    { label: 'an object prototype name', reason: 'constructor' },
    { label: 'an empty reason', reason: '' },
  ])('redacts $label in a real close frame', async ({ reason }) => {
    const { connection, opened, port } = await listen();
    const ws = await plugin(port);
    await opened;
    const received = new Promise<void>((resolve) => {
      ws.on('message', (raw) => {
        if (JSON.parse(String(raw)).id) resolve();
      });
    });
    const pending = connection.request('pending', {});
    const message =
      'Connection lost; write outcome unknown. Do not blindly replay. ' +
      'WebSocket close code=4008, reason=<redacted>.';
    const rejected = expect(pending).rejects.toMatchObject({ message });
    await received;
    const closed = once(ws, 'close');
    ws.close(4008, reason);
    await closed;
    await rejected;
    await expect(connection.request('later', {})).rejects.toMatchObject({ message });
    expect(connection.timings.sdkCalls).toBe(1);
  });

  it('keeps the selected session usable when a non-selected socket closes', async () => {
    const { connection, opened, port } = await listen();
    const other = new WebSocket('ws://127.0.0.1:' + port);
    sockets.push(other);
    other.on('error', () => {});
    const otherClosed = once(other, 'close');
    await once(other, 'message');
    const ws = await plugin(port);
    await opened;
    const requests: Array<{ id: string; payload: unknown }> = [];
    let reply = false;
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if (!frame.id) return;
      requests.push(frame);
      if (reply) ws.send(JSON.stringify({ id: frame.id, result: frame.payload }));
    });
    const pending = connection.request('pending', { n: 1 });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect((await otherClosed)[0]).toBe(1008);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.send(JSON.stringify({ id: requests[0]!.id, result: requests[0]!.payload }));
    await expect(pending).resolves.toEqual({ n: 1 });
    reply = true;
    await expect(connection.request('later', { n: 2 })).resolves.toEqual({ n: 2 });
    expect(requests).toHaveLength(2);
  });

  it.each(['token', 'kb', 'protocol', 'schema'])(
    'rejects invalid %s before an operation can start',
    async (kind) => {
      const { connection, opened, port } = await listen();
      const expected = expect(opened).rejects.toThrow();
      await plugin(
        port,
        kind === 'kb'
          ? { knowledgeBaseId: 'other' }
          : kind === 'protocol'
            ? { protocolVersion: 2 as never }
            : kind === 'schema'
              ? { acceptWriteOperations: 'true' as never }
              : {},
        kind === 'token' ? 'c'.repeat(64) : token
      );
      await expected;
      await expect(connection.request('sdk_call', {})).rejects.toThrow();
    }
  );

  it('accepts RemNote CLI Bridge 0.25.0 and the previous plugin id', async () => {
    const { opened, port } = await listen();
    await plugin(port, {
      pluginVersion: '0.25.0',
      pluginId: ACCEPTED_PLUGIN_IDS[0],
      pluginName: ACCEPTED_PLUGIN_NAMES[0],
    });
    await expect(opened).resolves.toMatchObject({
      pluginVersion: '0.25.0',
      pluginId: 'remnote-cli-bridge',
      pluginName: 'RemNote CLI Bridge',
    });
  });

  it('keeps accepting the previous plugin id and name during the rename', async () => {
    const { opened, port } = await listen();
    await plugin(port, {
      pluginVersion: '0.24.1',
      pluginId: ACCEPTED_PLUGIN_IDS[1],
      pluginName: ACCEPTED_PLUGIN_NAMES[1],
    });
    await expect(opened).resolves.toMatchObject({
      pluginId: 'zeefan-remnote-sdk-bridge',
      pluginName: 'RemNote SDK Bridge',
    });
  });

  it('rejects an unknown plugin id before an operation can start', async () => {
    const { connection, opened, port } = await listen();
    const rejected = expect(opened).rejects.toThrow('Unsupported plugin handshake');
    await plugin(port, { pluginId: 'other-plugin' as never });
    await rejected;
    await expect(connection.request('sdk_call', {})).rejects.toThrow(
      'Unsupported plugin handshake'
    );
  });

  it('identifies unsupported plugin handshakes without accepting a legacy session', async () => {
    const { connection, opened, port } = await listen();
    const rejected = expect(opened).rejects.toThrow('Unsupported plugin handshake');
    const ws = new WebSocket('ws://127.0.0.1:' + port);
    sockets.push(ws);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', version: '0.23.0' }));
    await rejected;
    expect(connection.timings.sdkCalls).toBe(0);
    await expect(connection.request('sdk_call', {})).rejects.toThrow(
      'Unsupported plugin handshake'
    );
  });

  it('fails closed on an occupied port without stopping the existing listener', async () => {
    const first = await listen();
    const second = new Connection(
      { protocolVersion: 1, token, knowledgeBaseId: 'kb', port: first.port },
      'v'
    );
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
    await expect(connection.request('sdk_call', {}, 15)).rejects.toThrow(
      'SDK timeout; write outcome unknown. Do not blindly replay.'
    );
    await expect(connection.request('sdk_call', {})).rejects.toThrow();
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
    await expect(connection.request('sdk_call', {})).rejects.toThrow('permission denied');
    await expect(connection.request('sdk_call', {})).rejects.toThrow('Malformed response');
    const pending = connection.request('pending', {});
    const failed = expect(pending).rejects.toThrow();
    ws.terminate();
    await failed;
  });

  it('validates request bounds before sending', async () => {
    const { connection, opened, port } = await listen();
    await plugin(port);
    await opened;
    await expect(connection.request('sdk_call', {}, 0)).rejects.toThrow('Invalid SDK timeout');
    await expect(
      connection.request('sdk_call', { huge: 'x'.repeat(8 * 1024 * 1024) })
    ).rejects.toThrow('too large');
  });
});
