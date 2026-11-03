import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';

import { isRecord, str } from '../../util.ts';
import type { ToolCallResult } from '../types.ts';
import { TOOL_ENDPOINT_ENV, TOOL_TOKEN_ENV } from './tool-bridge.ts';

/**
 * `mcp-tools`: a dependency-free stdio MCP server (name `baios`) that Claude Code starts from the
 * per-run `--mcp-config`. It serves only the run's BAIOS tools (`mcp__baios__<name>`, read from
 * the file named by `BAIOS_TOOLSET_FILE`). Every call is relayed to the parent runner over the
 * per-run IPC endpoint and held until it answers. Newline-delimited JSON-RPC 2.0; unknown methods
 * (including the `server/discover` probe) get -32601 so the client falls back to `initialize`.
 */

export const TOOLSET_FILE_ENV = 'BAIOS_TOOLSET_FILE';

type JsonRpcId = number | string;

interface McpTool {
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
}

const toolUnavailable = (reason: string): ToolCallResult => ({
  isError: true,
  output: `BAIOS tool channel unavailable (${reason}); the tool did not run.`,
});

/** The run's toolset as the parent wrote it; anything malformed is left out. */
function readToolset(): McpTool[] {
  const file = process.env[TOOLSET_FILE_ENV];
  if (!file) return [];
  try {
    const list = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(list)) return [];
    return list.flatMap((tool: unknown) => {
      const name = isRecord(tool) ? str(tool.name) : undefined;
      if (!isRecord(tool) || !name) return [];
      const inputSchema = isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object' };
      return [{ description: str(tool.description) ?? '', inputSchema, name }];
    });
  } catch {
    return [];
  }
}

class ParentLink {
  private socket: Promise<Socket> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, (result: unknown) => void>();

  callTool(name: string, input: Record<string, unknown>): Promise<ToolCallResult> {
    return new Promise((resolve) => {
      this.open()
        .then((socket) => {
          const id = this.nextId++;
          // `undefined` (the link dropped) falls back to an "unavailable" answer.
          this.pending.set(id, (result) =>
            resolve((result as ToolCallResult | undefined) ?? toolUnavailable('disconnected')),
          );
          socket.write(`${JSON.stringify({ id, input, name, type: 'tool' })}\n`);
        })
        .catch((error: unknown) =>
          resolve(toolUnavailable(error instanceof Error ? error.message : 'connect failed')),
        );
    });
  }

  close(): void {
    void this.socket?.then((socket) => socket.destroy()).catch(() => undefined);
  }

  private open(): Promise<Socket> {
    const endpoint = process.env[TOOL_ENDPOINT_ENV];
    const token = process.env[TOOL_TOKEN_ENV];
    if (!endpoint || !token) return Promise.reject(new Error('not configured'));
    this.socket ??= new Promise<Socket>((resolve, reject) => {
      const socket = connect(endpoint, () => {
        socket.write(`${JSON.stringify({ token, type: 'hello' })}\n`);
        resolve(socket);
      });
      socket.once('error', reject);
      socket.once('close', () => {
        this.socket = null;
        for (const settle of this.pending.values()) settle(undefined);
        this.pending.clear();
      });
      createInterface({ input: socket, crlfDelay: Infinity }).on('line', (line) => {
        try {
          const message = JSON.parse(line) as unknown;
          if (!isRecord(message) || typeof message.id !== 'number') return;
          const settle = this.pending.get(message.id);
          this.pending.delete(message.id);
          settle?.(message.result);
        } catch {
          // ignore malformed lines
        }
      });
    });
    return this.socket;
  }
}

export function runMcpToolServer(): Promise<void> {
  const link = new ParentLink();
  const toolset = readToolset();
  const names = new Set(toolset.map((tool) => tool.name));
  const send = (message: Record<string, unknown>) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const reply = (id: JsonRpcId, result: unknown) => send({ id, result });

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    const id = message.id;
    if (typeof id !== 'number' && typeof id !== 'string') return; // a notification
    const params = isRecord(message.params) ? message.params : {};
    switch (message.method) {
      case 'initialize':
        return reply(id, {
          capabilities: { tools: {} },
          protocolVersion: str(params.protocolVersion) ?? '2025-06-18',
          serverInfo: { name: 'baios', version: '1' },
        });
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: toolset });
      case 'tools/call': {
        const args = isRecord(params.arguments) ? params.arguments : {};
        const name = str(params.name);
        if (name && names.has(name)) {
          void link.callTool(name, args).then((result) =>
            reply(id, {
              content: [{ text: String(result.output), type: 'text' }],
              isError: result.isError === true,
            }),
          );
          return;
        }
        return send({ error: { code: -32602, message: 'Unknown tool' }, id });
      }
      default:
        return send({ error: { code: -32601, message: 'Method not found' }, id });
    }
  });

  return new Promise((resolve) => {
    lines.once('close', () => {
      link.close();
      resolve();
    });
  });
}
