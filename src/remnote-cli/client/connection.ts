import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { ConnectionConfig } from './connection-config.js';

export const PROTOCOL_VERSION = 2;
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IN_FLIGHT_REQUESTS = 16;
export const MAX_WAITING_REQUESTS = MAX_IN_FLIGHT_REQUESTS;
export const MAX_OUTSTANDING_REQUESTS = MAX_IN_FLIGHT_REQUESTS + MAX_WAITING_REQUESTS;
/** Current RemNote CLI Bridge manifest id. The previous id stays valid during the rename. */
export const ACCEPTED_PLUGIN_IDS = ['remnote-cli-bridge', 'zeefan-remnote-sdk-bridge'] as const;
export const ACCEPTED_PLUGIN_NAMES = ['RemNote CLI Bridge', 'RemNote SDK Bridge'] as const;
// Close reasons come from the peer; only exact Bridge constants may become diagnostic labels.
const BRIDGE_CLOSE_REASON_LABELS = new Map([
  ['Authentication timeout', 'authentication-timeout'],
  ['Protocol or authentication failure', 'protocol-or-authentication-failure'],
  ['Command session ended', 'command-session-ended'],
]);
export const IdentitySchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    pluginVersion: z.string().min(1),
    sdkVersion: z.string().min(1),
    sdkCatalogHash: z.string().regex(/^[a-f0-9]{64}$/),
    knowledgeBaseId: z.string().min(1).max(256),
    knowledgeBaseName: z.string(),
    acceptWriteOperations: z.boolean(),
    acceptReplaceOperation: z.boolean(),
    pluginId: z.enum(ACCEPTED_PLUGIN_IDS).optional(),
    pluginName: z.enum(ACCEPTED_PLUGIN_NAMES).optional(),
  })
  .strict();
export type BridgeIdentity = z.infer<typeof IdentitySchema>;
export function proof(token: string, value: string): string {
  return createHmac('sha256', token).update(value).digest('hex');
}
function matchesProof(token: string, value: string, actual: unknown): boolean {
  return (
    typeof actual === 'string' &&
    /^[a-f0-9]{64}$/.test(actual) &&
    timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(proof(token, value), 'hex'))
  );
}

/** A command owns this listener. It never reconnects or replays an in-flight operation. */
export class Connection {
  private server?: WebSocketServer;
  private client?: WebSocket;
  private readonly sockets = new Set<WebSocket>();
  private opening?: Promise<BridgeIdentity>;
  private failure?: Error;
  private identity?: BridgeIdentity;
  private lastRequestId = 0;
  private outstanding = 0;
  private inFlight = 0;
  private readonly slotWaiters: Array<{
    grant: () => void;
    reject: (error: Error) => void;
  }> = [];
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private connectionTimer?: NodeJS.Timeout;
  private rejectOpening?: (error: Error) => void;
  readonly timings = { connectionMs: 0, sdkCalls: 0, sdkMs: 0 };

  constructor(
    private readonly config: ConnectionConfig,
    private readonly cliVersion: string,
    private readonly connectTimeoutMs = 15_000
  ) {}

  open(): Promise<BridgeIdentity> {
    if (this.opening) return this.opening;
    const started = performance.now();
    this.opening = new Promise((resolve, reject) => {
      this.rejectOpening = reject;
      const server = new WebSocketServer({
        host: '127.0.0.1',
        port: this.config.port,
        maxPayload: MAX_MESSAGE_BYTES,
      });
      this.server = server;
      const fail = (error: Error) => {
        this.failure = error;
        clearTimeout(this.connectionTimer);
        reject(error);
      };
      server.on('error', (error: NodeJS.ErrnoException) =>
        fail(
          new Error(
            error.code === 'EADDRINUSE'
              ? 'CLI port occupied. Another command or an old companion is running; no process was stopped.'
              : error.message,
            { cause: error }
          )
        )
      );
      this.connectionTimer = setTimeout(
        () =>
          fail(
            new Error(
              'Plugin connection timed out. Open RemNote and check pairing and permissions.'
            )
          ),
        this.connectTimeoutMs
      );
      server.on('connection', (ws) => {
        if (this.failure || this.client || this.sockets.size >= 4) {
          ws.close(1008, 'Command already has a session');
          return;
        }
        this.sockets.add(ws);
        const nonce = randomBytes(32).toString('hex');
        const timer = setTimeout(() => ws.close(1008, 'Authentication timeout'), 5000);
        ws.send(
          JSON.stringify({
            type: 'challenge',
            protocolVersion: PROTOCOL_VERSION,
            nonce,
            proof: proof(this.config.token, 'cli:' + nonce),
          })
        );
        ws.on('error', () => {});
        ws.on('close', (code, reason) => {
          clearTimeout(timer);
          this.sockets.delete(ws);
          if (this.client === ws) {
            this.client = undefined;
            const label = BRIDGE_CLOSE_REASON_LABELS.get(reason.toString()) ?? '<redacted>';
            this.failPending(
              new Error(
                'Connection lost; write outcome unknown. Do not blindly replay. ' +
                  `WebSocket close code=${code}, reason=${label}.`
              )
            );
          }
        });
        ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString());
            if (this.client !== ws) {
              if (message.type !== 'hello') throw new Error('Authentication required');
              const parsed = IdentitySchema.safeParse(message.identity);
              if (!parsed.success)
                throw new Error(
                  'Unsupported plugin handshake. Load the paired RemNote CLI Bridge using direct protocol 2.'
                );
              const identity = parsed.data;
              if (
                !matchesProof(
                  this.config.token,
                  'plugin:' + nonce + ':' + JSON.stringify(message.identity),
                  message.proof
                )
              )
                throw new Error('Plugin authentication failed');
              if (identity.knowledgeBaseId !== this.config.knowledgeBaseId)
                throw new Error(
                  'Knowledge base mismatch: expected ' +
                    this.config.knowledgeBaseId +
                    ', received ' +
                    identity.knowledgeBaseId
                );
              if (this.client || this.failure)
                throw new Error('Session already selected or expired');
              clearTimeout(timer);
              clearTimeout(this.connectionTimer);
              this.client = ws;
              this.identity = identity;
              this.timings.connectionMs = Math.round(performance.now() - started);
              ws.send(
                JSON.stringify({
                  type: 'ready',
                  protocolVersion: PROTOCOL_VERSION,
                  version: this.cliVersion,
                })
              );
              for (const other of this.sockets)
                if (other !== ws) other.close(1008, 'Session selected');
              resolve(identity);
              return;
            }
            if (message.type === 'pong') return;
            if (typeof message.id !== 'string') throw new Error('Invalid response');
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            if (typeof message.error === 'string') pending.reject(new Error(message.error));
            else if ('result' in message) pending.resolve(message.result);
            else pending.reject(new Error('Malformed response; verify write outcome'));
          } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            ws.close(1008, 'Protocol, authentication or KB mismatch');
            fail(failure);
            this.failPending(failure);
          }
        });
      });
    });
    return this.opening;
  }
  async request(
    action: string,
    payload: Record<string, unknown>,
    timeoutMs = 15_000
  ): Promise<unknown> {
    if (this.outstanding >= MAX_OUTSTANDING_REQUESTS)
      throw new Error('Too many outstanding requests; this request was not sent');
    this.outstanding++;
    let acquired = false;
    try {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
        throw new Error('Invalid SDK timeout');
      await this.open();
      if (this.failure) throw this.failure;
      await this.acquireSlot(timeoutMs);
      acquired = true;
      return await this.sendRequest(action, payload, timeoutMs);
    } finally {
      this.outstanding--;
      if (acquired) this.releaseSlot();
    }
  }

  private acquireSlot(timeoutMs: number): Promise<void> {
    if (this.inFlight < MAX_IN_FLIGHT_REQUESTS && this.slotWaiters.length === 0) {
      this.inFlight++;
      return Promise.resolve();
    }
    if (this.slotWaiters.length >= MAX_WAITING_REQUESTS)
      return Promise.reject(new Error('Too many waiting requests; this request was not sent'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.slotWaiters.splice(this.slotWaiters.indexOf(waiter), 1);
        reject(new Error('Request expired while waiting; this request was not sent'));
      }, timeoutMs);
      const waiter = {
        grant: () => {
          clearTimeout(timer);
          this.inFlight++;
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.slotWaiters.push(waiter);
    });
  }

  private releaseSlot(): void {
    this.inFlight--;
    this.slotWaiters.shift()?.grant();
  }

  private async sendRequest(
    action: string,
    payload: Record<string, unknown>,
    timeoutMs: number
  ): Promise<unknown> {
    const identity = await this.open();
    if (this.failure) throw this.failure;
    if (!this.client || this.client.readyState !== WebSocket.OPEN)
      throw new Error('Session closed; do not replay writes');
    if (this.lastRequestId >= Number.MAX_SAFE_INTEGER)
      throw new Error('Request ID space exhausted; this request was not sent');
    const ws = this.client,
      id = String(this.lastRequestId + 1),
      started = performance.now();
    const frame = JSON.stringify({
      id,
      action,
      payload,
      knowledgeBaseId: identity.knowledgeBaseId,
      deadline: Date.now() + timeoutMs,
    });
    if (Buffer.byteLength(frame) > MAX_MESSAGE_BYTES) throw new Error('Request too large');
    // No await between ID allocation and send: numeric order is actual wire order.
    this.lastRequestId++;
    this.timings.sdkCalls++;
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          const error = new Error('SDK timeout; write outcome unknown. Do not blindly replay.');
          this.failPending(error);
          reject(error);
          ws.terminate();
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        ws.send(frame, (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(id);
            this.failPending(error);
            reject(error);
            ws.terminate();
          }
        });
      });
    } finally {
      this.timings.sdkMs += Math.round(performance.now() - started);
    }
  }
  private failPending(error: Error): void {
    this.failure = error;
    for (const waiter of this.slotWaiters.splice(0)) waiter.reject(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  async close(): Promise<void> {
    clearTimeout(this.connectionTimer);
    const error = new Error('Command session closed');
    this.rejectOpening?.(error);
    this.failPending(error);
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
    this.client = undefined;
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
