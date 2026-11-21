import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';

export const PROTOCOL_VERSION = 2;
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const FIXED_PORT = 3002;
/** RemNote's sandboxed plugin WebSocket sends this exact observed Origin. */
export const ALLOWED_ORIGIN = 'null';
export const MAX_PENDING_REQUESTS = 32;

export const IdentitySchema = z
  .object({
    pluginVersion: z.string().min(1),
    sdkVersion: z.string().min(1),
    sdkCatalogHash: z.string().regex(/^[a-f0-9]{64}$/),
    knowledgeBaseId: z.string().min(1).max(256),
    knowledgeBaseName: z.string(),
  })
  .strict();
export type BridgeIdentity = z.infer<typeof IdentitySchema>;

export interface ConnectionOptions {
  /** Explicit validation only; the Bridge always reports the active knowledge base. */
  knowledgeBaseId?: string;
  /** Test seam only. Production callers use the fixed port. */
  port?: number;
}

/** A command owns this listener. It never reconnects or replays an in-flight operation. */
export class Connection {
  private server?: WebSocketServer;
  private client?: WebSocket;
  private readonly sockets = new Set<WebSocket>();
  private opening?: Promise<BridgeIdentity>;
  private failure?: Error;
  private identity?: BridgeIdentity;
  private nextRequestId = 1;
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
  readonly timings = { listeningMs: 0, connectionMs: 0, sdkCalls: 0, sdkMs: 0 };

  constructor(
    private readonly options: ConnectionOptions,
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
        port: this.options.port ?? FIXED_PORT,
        maxPayload: MAX_MESSAGE_BYTES,
        verifyClient: ({ req }, done) => {
          const origin = req.headers.origin;
          const allowed = origin === ALLOWED_ORIGIN;
          done(allowed, allowed ? undefined : 403, allowed ? undefined : 'Forbidden Origin');
        },
      });
      this.server = server;
      server.once('listening', () => {
        this.timings.listeningMs = Math.round(performance.now() - started);
      });
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
              'Plugin connection timed out. Open RemNote, load protocol 2, and check its official permissions.'
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
        const timer = setTimeout(() => ws.close(1008, 'Handshake timeout'), 5000);
        ws.send(
          JSON.stringify({
            type: 'hello',
            protocolVersion: PROTOCOL_VERSION,
            version: this.cliVersion,
          })
        );
        ws.on('error', () => {});
        ws.on('close', () => {
          clearTimeout(timer);
          this.sockets.delete(ws);
          if (this.client === ws) {
            this.client = undefined;
            this.failPending(
              new Error('Connection lost; write outcome unknown. Do not blindly replay.')
            );
          }
        });
        ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString());
            if (this.client !== ws) {
              if (message.type !== 'ready' || message.protocolVersion !== PROTOCOL_VERSION)
                throw new Error(
                  'Unsupported plugin handshake. Load the zero-configuration RemNote CLI Bridge using protocol 2.'
                );
              const parsed = IdentitySchema.safeParse(message.identity);
              if (!parsed.success)
                throw new Error(
                  'Unsupported plugin handshake. The Bridge did not report a complete live SDK and knowledge-base identity.'
                );
              const identity = parsed.data;
              if (
                this.options.knowledgeBaseId &&
                identity.knowledgeBaseId !== this.options.knowledgeBaseId
              )
                throw new Error(
                  'Knowledge base mismatch: expected ' +
                    this.options.knowledgeBaseId +
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
            ws.close(1008, 'Protocol, handshake or KB mismatch');
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
    const identity = await this.open();
    if (this.failure) throw this.failure;
    if (!this.client || this.client.readyState !== WebSocket.OPEN)
      throw new Error('Session closed; do not replay writes');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
      throw new Error('Invalid SDK timeout');
    if (this.pending.size >= MAX_PENDING_REQUESTS)
      throw new Error(`Too many pending SDK requests (maximum ${MAX_PENDING_REQUESTS})`);
    const ws = this.client,
      id = String(this.nextRequestId++),
      started = performance.now();
    const frame = JSON.stringify({
      id,
      action,
      payload,
      knowledgeBaseId: identity.knowledgeBaseId,
      deadline: Date.now() + timeoutMs,
    });
    if (Buffer.byteLength(frame) > MAX_MESSAGE_BYTES) throw new Error('Request too large');
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
