import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { isRecord, str } from '../../util.ts';
import type { ToolCallResult } from '../types.ts';

/**
 * The parent side of the sandbox tool relay: a per-run named pipe (Windows) or Unix socket in a
 * fresh 0700 temp dir (POSIX) that the `mcp-tools` child dials. A connection must first present
 * the per-run random token (handed over in the child's env, never argv), so another local process
 * that finds the endpoint cannot answer tool calls.
 *
 * Wire: newline-delimited JSON. Child → `{type:'hello', token}`, then
 * `{type:'tool', id, name, input}`; parent → `{type:'response', id, result}`.
 */

export const TOOL_ENDPOINT_ENV = 'BAIOS_TOOL_ENDPOINT';
export const TOOL_TOKEN_ENV = 'BAIOS_TOOL_TOKEN';

export interface ToolBridge {
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

export async function openToolBridge(
  dir: string,
  onToolCall: (name: string, input: Record<string, unknown>) => Promise<ToolCallResult>,
): Promise<ToolBridge> {
  const token = randomBytes(32).toString('base64url');
  const expected = Buffer.from(token);
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\baios-${randomBytes(16).toString('hex')}`
      : join(dir, 'tools.sock');
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
      if (message.type !== 'tool' || typeof message.id !== 'number') return;
      const id = message.id;
      const input = isRecord(message.input) ? message.input : {};
      onToolCall(str(message.name) ?? '', input)
        .catch((): ToolCallResult => ({ isError: true, output: 'The BAIOS tool call failed.' }))
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
