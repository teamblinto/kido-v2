import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import { log } from '../../log.ts';
import { isRecord, str } from '../../util.ts';

/**
 * `codex app-server` JSON-RPC over JSONL: no `"jsonrpc"` field either way, and server→client
 * requests use their own id space, so they are told apart by shape — `method`+`id` is a server
 * request, `method` alone a notification, `id` alone a response to us.
 */

export type RpcId = number | string;

export class RpcError extends Error {
  readonly code: number | null;

  constructor(message: string, code: number | null) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

export interface RpcHandlers {
  onNotification(method: string, params: Record<string, unknown>): void;
  onRequest(id: RpcId, method: string, params: Record<string, unknown>): void;
}

export class CodexRpc {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { reject: (error: Error) => void; resolve: (result: unknown) => void }
  >();
  private readonly child: ChildProcess;
  private closed = false;

  constructor(child: ChildProcess, handlers: RpcHandlers) {
    this.child = child;
    child.stdin?.on('error', () => undefined);
    child.once('exit', () => this.closeAll('codex app-server exited.'));
    if (!child.stdout) return;
    createInterface({ crlfDelay: Infinity, input: child.stdout }).on('line', (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(message)) return;
      const method = str(message.method);
      const params = isRecord(message.params) ? message.params : {};
      const id = message.id;
      const hasId = typeof id === 'number' || typeof id === 'string';
      if (method && hasId) {
        log.debug(`codex request ${method}`);
        handlers.onRequest(id, method, params);
      } else if (method) {
        handlers.onNotification(method, params);
      } else if (typeof id === 'number') {
        const waiter = this.pending.get(id);
        this.pending.delete(id);
        if (!waiter) return;
        if (isRecord(message.error)) {
          const code = typeof message.error.code === 'number' ? message.error.code : null;
          waiter.reject(new RpcError(str(message.error.message) ?? 'codex error', code));
        } else {
          waiter.resolve(message.result);
        }
      }
    });
  }

  private send(message: Record<string, unknown>): void {
    const stdin = this.child.stdin;
    if (stdin?.writable) stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new RpcError('codex app-server is not running.', null));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`codex did not answer ${method} in time.`, null));
      }, timeoutMs);
      this.pending.set(id, {
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
      });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  respond(id: RpcId, result: unknown): void {
    this.send({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.send({ error: { code, message }, id });
  }

  private closeAll(reason: string): void {
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(new RpcError(reason, null));
    this.pending.clear();
  }
}

/** `initialize` + `initialized`, as the app-server requires before anything else. */
export async function initializeCodex(rpc: CodexRpc, version: string): Promise<void> {
  await rpc.request(
    'initialize',
    {
      capabilities: null,
      clientInfo: { name: 'baios-companion', title: 'BAIOS Companion', version },
    },
    20_000,
  );
  rpc.notify('initialized');
}
