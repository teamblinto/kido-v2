import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { createInterface } from 'node:readline';

import { isRecord, str } from '../../util.ts';
import type { ToolCallResult } from '../types.ts';
import {
  APPROVAL_ENDPOINT_ENV,
  APPROVAL_TOKEN_ENV,
  type ApprovalResult,
} from './approval-bridge.ts';

/**
 * `baios-companion mcp-approval`: a dependency-free stdio MCP server (name `baios`) that Claude
 * Code starts from the per-run `--mcp-config`. It serves `approve` for
 * `--permission-prompt-tool mcp__baios__approve` or, in sandbox tool mode (no prompt tool), only
 * the run's BAIOS tools (`mcp__baios__<name>`, read from the file named by `BAIOS_TOOLSET_FILE`). Every call is relayed
 * to the parent companion over the per-run IPC endpoint and held until it answers.
 * Newline-delimited JSON-RPC 2.0; unknown methods (including the `server/discover` probe) get
 * -32601 so the client falls back to `initialize`.
 */

export const TOOLSET_FILE_ENV = 'BAIOS_TOOLSET_FILE';

type JsonRpcId = number | string;

interface McpTool {
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
}

const APPROVE: McpTool = {
  description: 'Asks the person in BAIOS whether a tool call may run.',
  inputSchema: {
    properties: {
      input: { type: 'object' },
      tool_name: { type: 'string' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input'],
    type: 'object',
  },
  name: 'approve',
};

const unavailable = (reason: string): ApprovalResult => ({
  behavior: 'deny',
  message: `BAIOS approval channel unavailable (${reason}); the tool call was not allowed.`,
});

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
      if (!isRecord(tool) || !name || name === APPROVE.name) return [];
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

  ask(toolName: string, input: Record<string, unknown>, toolUseId: string | null) {
    return this.send({ input, toolName, toolUseId, type: 'request' }, unavailable);
  }

  callTool(name: string, input: Record<string, unknown>) {
    return this.send({ input, name, type: 'tool' }, toolUnavailable);
  }

  close(): void {
    void this.socket?.then((socket) => socket.destroy()).catch(() => undefined);
  }

  private send<T>(payload: Record<string, unknown>, fallback: (reason: string) => T): Promise<T> {
    return new Promise<T>((resolve) => {
      this.open()
        .then((socket) => {
          const id = this.nextId++;
          // `undefined` (the link dropped) falls back to this call's own "unavailable" answer.
          this.pending.set(id, (result) => resolve((result ?? fallback('disconnected')) as T));
          socket.write(`${JSON.stringify({ id, ...payload })}\n`);
        })
        .catch((error: unknown) =>
          resolve(fallback(error instanceof Error ? error.message : 'connect failed')),
        );
    });
  }

  private open(): Promise<Socket> {
    const endpoint = process.env[APPROVAL_ENDPOINT_ENV];
    const token = process.env[APPROVAL_TOKEN_ENV];
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

export function runMcpApprovalServer(): Promise<void> {
  const link = new ParentLink();
  const sandbox = Boolean(process.env[TOOLSET_FILE_ENV]);
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
        return reply(id, { tools: sandbox ? toolset : [APPROVE] });
      case 'tools/call': {
        const args = isRecord(params.arguments) ? params.arguments : {};
        const name = str(params.name);
        if (name === APPROVE.name && !sandbox) {
          void link
            .ask(
              str(args.tool_name) ?? 'unknown',
              isRecord(args.input) ? args.input : {},
              str(args.tool_use_id) ?? null,
            )
            .then((result) =>
              reply(id, { content: [{ text: JSON.stringify(result), type: 'text' }] }),
            );
          return;
        }
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
