import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { isRecord, str } from '../../util.ts';
import type { ToolCallResult } from '../types.ts';

/**
 * The parent side of Claude approvals (ADR decision 7): a per-run named pipe (Windows) or Unix
 * socket in a fresh 0700 temp dir (POSIX) that the `mcp-approval` child dials. A connection must
 * first present the per-run random token (handed over in the child's env, never argv), so another
 * local process that finds the endpoint cannot answer approvals.
 *
 * Wire: newline-delimited JSON. Child → `{type:'hello', token}`, then
 * `{type:'request', id, toolName, input, toolUseId}` (an approval) or `{type:'tool', id, name, input}`
 * (a sandbox tool call); parent → `{type:'response', id, result}`.
 */

export const APPROVAL_ENDPOINT_ENV = 'BAIOS_APPROVAL_ENDPOINT';
export const APPROVAL_TOKEN_ENV = 'BAIOS_APPROVAL_TOKEN';

export interface ApprovalRequest {
  input: Record<string, unknown>;
  toolName: string;
  toolUseId: string | null;
}

/** Claude Code's `PermissionResult`. */
export type ApprovalResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; interrupt?: boolean; message: string };

export interface ApprovalBridge {
  close(): Promise<void>;
  endpoint: string;
  token: string;
}

const HELLO_TIMEOUT_MS = 10_000;

function tokensMatch(expected: Buffer, presented: unknown): boolean {
  if (typeof presented !== 'string') return false;
  const given = Buffer.from(presented);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function openApprovalBridge(
  dir: string,
  onRequest: (request: ApprovalRequest) => Promise<ApprovalResult>,
  onToolCall?: (name: string, input: Record<string, unknown>) => Promise<ToolCallResult>,
): Promise<ApprovalBridge> {
  const token = randomBytes(32).toString('base64url');
  const expected = Buffer.from(token);
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\baios-${randomBytes(16).toString('hex')}`
      : join(dir, 'approval.sock');
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let authenticated = false;
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on('line', (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      if (!isRecord(message)) return;
      if (!authenticated) {
        clearTimeout(helloTimer);
        if (message.type !== 'hello' || !tokensMatch(expected, message.token)) {
          socket.destroy();
          return;
        }
        authenticated = true;
        return;
      }
      if (typeof message.id !== 'number') return;
      const id = message.id;
      const input = isRecord(message.input) ? message.input : {};
      let answer: Promise<unknown>;
      if (message.type === 'request') {
        const request: ApprovalRequest = {
          input,
          toolName: str(message.toolName) ?? 'unknown',
          toolUseId: str(message.toolUseId) ?? null,
        };
        answer = onRequest(request).catch((): ApprovalResult => ({
          behavior: 'deny',
          message: 'Approval failed.',
        }));
      } else if (message.type === 'tool' && onToolCall) {
        answer = onToolCall(str(message.name) ?? '', input).catch((): ToolCallResult => ({
          isError: true,
          output: 'The BAIOS tool call failed.',
        }));
      } else {
        return;
      }
      answer
        .then((result) => {
          if (!socket.destroyed)
            socket.write(`${JSON.stringify({ id, result, type: 'response' })}\n`);
        })
        .catch(() => undefined);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
    endpoint,
    token,
  };
}
