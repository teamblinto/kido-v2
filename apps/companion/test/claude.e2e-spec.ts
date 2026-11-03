import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CompanionToolDefinition } from '@repo/contracts';

import {
  createClaudeAdapter,
  MAX_PENDING_TOOL_CALLS,
  sandboxModeArgs,
} from '../src/providers/claude/index.ts';
import type { RunEventBody, StartRunOptions } from '../src/providers/types.ts';
import {
  collect,
  FAKE_CLAUDE,
  SELF_SCRIPT,
  tempDir,
  terminalOf,
  textOf,
  waitFor,
} from './helpers.ts';

const adapter = createClaudeAdapter({
  binary: FAKE_CLAUDE,
  interruptGraceMs: 400,
  selfScript: SELF_SCRIPT,
});

function run(prompt: string, extra: Partial<StartRunOptions> = {}) {
  const cwd = tempDir('baios-ws-');
  const handle = adapter.startRun({
    cwd,
    model: 'sonnet',
    permissionMode: 'default',
    prompt,
    resume: null,
    toolset: null,
    ...extra,
  });
  return { cwd, handle };
}

const ofType = <T extends RunEventBody['type']>(events: RunEventBody[], type: T) =>
  events.filter((event): event is Extract<RunEventBody, { type: T }> => event.type === type);

const TOOLSET: CompanionToolDefinition[] = [
  {
    description: 'Read a file in the sandbox.',
    inputSchema: { properties: { path: { type: 'string' } }, type: 'object' },
    name: 'fs_read',
  },
  { description: 'Run a command in the sandbox.', inputSchema: { type: 'object' }, name: 'exec' },
];

afterEach(() => {
  delete process.env.FAKE_CLAUDE_INFO_FILE;
  delete process.env.FAKE_CLAUDE_TOOL_LOG;
  delete process.env.FAKE_CLAUDE_AUTH;
  delete process.env.FAKE_CLAUDE_ARGV_FILE;
  delete process.env.FAKE_CLAUDE_IGNORE_INTERRUPT;
  delete process.env.FAKE_CLAUDE_ABSORB_INPUT;
});

describe('Claude adapter', () => {
  it('probes version and sign-in through the CLI, keeping no account identifiers', async () => {
    const probe = await adapter.probe();
    expect(probe).toMatchObject({
      auth: { method: 'subscription', plan: 'Max', status: 'authenticated' },
      installed: true,
      message: null,
      version: '2.1.316',
    });
    expect(JSON.stringify(probe)).not.toMatch(/someone@example\.com|org-secret/);
    process.env.FAKE_CLAUDE_AUTH = 'api_key';
    expect((await adapter.probe()).auth.method).toBe('api_key');
    process.env.FAKE_CLAUDE_AUTH = 'none';
    const signedOut = await adapter.probe();
    expect(signedOut.auth.status).toBe('unauthenticated');
    expect(signedOut.message).toContain('baios-companion login claude');
  });

  it('reports not installed when the binary is missing', async () => {
    const missing = createClaudeAdapter({
      binary: join(tempDir(), 'nope.exe'),
      selfScript: SELF_SCRIPT,
    });
    expect(await missing.probe()).toMatchObject({ installed: false });
  });

  it('streams a run: session, text, usage, completed; with the expected safe argv', async () => {
    const argvFile = join(tempDir(), 'argv.json');
    process.env.FAKE_CLAUDE_ARGV_FILE = argvFile;
    const { handle } = run('say hello', { resume: 'sess-9' });
    const events = await collect(handle);
    expect(events[0]).toEqual({ data: { providerSessionId: 'sess-9' }, type: 'session' });
    expect(textOf(events)).toBe('Hello');
    expect(ofType(events, 'usage')).toEqual([
      { data: { inputTokens: 34, outputTokens: 7 }, type: 'usage' },
    ]);
    expect(terminalOf(events)).toEqual({ status: 'completed' });

    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
    expect(argv).toEqual(
      expect.arrayContaining([
        '-p',
        '--input-format',
        'stream-json',
        '--verbose',
        '--strict-mcp-config',
      ]),
    );
    // Server-derived values ride in the same token as their flag, so none can become a flag.
    expect(argv).toEqual(
      expect.arrayContaining(['--permission-mode=manual', '--model=sonnet', '--resume=sess-9']),
    );
    expect(argv).not.toContain('sess-9');
    expect(argv).toContain('mcp__baios__approve');
    expect(argv).not.toContain('--setting-sources');
    expect(argv.join(' ')).not.toMatch(/bypass|dangerously|BAIOS_APPROVAL_TOKEN/i);
    const mcpConfig = argv[argv.indexOf('--mcp-config') + 1] ?? '';
    expect(existsSync(mcpConfig)).toBe(false); // temp files removed on dispose
  });

  it('round-trips an approval through the real mcp-approval subprocess and IPC (allow)', async () => {
    const { cwd, handle } = run('please write a file');
    const events = await collect(handle, (event) => {
      if (event.type === 'approval.request') handle.respondApproval(event.data.requestId, 'allow');
    });
    expect(readFileSync(join(cwd, 'hello.txt'), 'utf8')).toBe('hi');
    expect(ofType(events, 'approval.request')).toEqual([
      {
        data: {
          detail: 'hi',
          kind: 'file_change',
          requestId: 'toolu_write_1',
          title: 'Write hello.txt',
        },
        type: 'approval.request',
      },
    ]);
    expect(ofType(events, 'file.change')).toEqual([
      { data: { kind: 'created', path: 'hello.txt' }, type: 'file.change' },
    ]);
    expect(ofType(events, 'tool.end')[0]?.data).toEqual({
      ok: true,
      summary: 'Done in <workspace>',
      toolId: 'toolu_write_1',
    });
    expect(JSON.stringify(events)).not.toContain(JSON.stringify(cwd).slice(1, -1));
    expect(textOf(events)).toBe('allow');
    expect(terminalOf(events)).toEqual({ status: 'completed' });
  });

  it('passes a denial and its message back to the CLI', async () => {
    const { handle } = run('run bash');
    const events = await collect(handle, (event) => {
      if (event.type === 'approval.request') {
        handle.respondApproval(event.data.requestId, 'deny', 'Not on my machine');
      }
    });
    expect(ofType(events, 'approval.request')[0]?.data).toMatchObject({
      detail: 'ls <workspace>',
      kind: 'command',
      title: 'Bash: ls <workspace>',
    });
    expect(ofType(events, 'tool.end')[0]?.data).toMatchObject({
      ok: false,
      summary: 'Not on my machine',
    });
    expect(textOf(events)).toBe('deny');
  });

  it('interrupts with a control request', async () => {
    const { handle } = run('go slow');
    const events = await collect(handle, (event) => {
      if (event.type === 'text.delta') handle.interrupt();
    });
    expect(terminalOf(events)).toEqual({ status: 'interrupted' });
  });

  it('kills the process tree when the CLI ignores the interrupt', async () => {
    process.env.FAKE_CLAUDE_IGNORE_INTERRUPT = '1';
    const { handle } = run('go slow');
    const started = Date.now();
    const events = await collect(handle, (event) => {
      if (event.type === 'text.delta') handle.interrupt();
    });
    expect(terminalOf(events)).toEqual({ status: 'interrupted' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reports a crash with a scrubbed stderr tail', async () => {
    const { handle } = run('crash now');
    const terminal = terminalOf(await collect(handle));
    expect(terminal.failure?.class).toBe('crash');
    expect(terminal.failure?.message).toContain('exited unexpectedly (code 3)');
    expect(terminal.failure?.message).toContain('fatal: lost connection');
    expect(terminal.failure?.message).not.toContain('abcdefghijklmnop');
  });

  it('refuses a session id or model that could become a CLI flag, before spawning (H1)', async () => {
    const argvFile = join(tempDir(), 'argv.json');
    process.env.FAKE_CLAUDE_ARGV_FILE = argvFile;
    for (const extra of [
      { resume: '--dangerously-skip-permissions' },
      { model: '--permission-mode=bypassPermissions' },
    ]) {
      const terminal = terminalOf(await collect(run('say hello', extra).handle));
      expect(terminal.failure?.class).toBe('provider');
    }
    expect(existsSync(argvFile)).toBe(false);
  });

  it('in plan mode denies anything but read-only tools locally, without asking BAIOS (H3)', async () => {
    const { handle } = run('run bash', { permissionMode: 'plan' });
    const events = await collect(handle);
    expect(ofType(events, 'approval.request')).toEqual([]);
    expect(ofType(events, 'tool.end')[0]?.data).toMatchObject({ ok: false });
    expect(ofType(events, 'tool.end')[0]?.data.summary).toContain('Plan mode');
    expect(textOf(events)).toBe('deny');
  });

  it('denies a command too long to show whole, and marks long file content truncated (M2)', async () => {
    const command = await collect(run('run long bash').handle);
    expect(ofType(command, 'approval.request')).toEqual([]);
    expect(ofType(command, 'tool.end')[0]?.data.summary).toContain('too long');

    const { handle } = run('long write');
    const events = await collect(handle, (event) => {
      if (event.type === 'approval.request') handle.respondApproval(event.data.requestId, 'deny');
    });
    const request = ofType(events, 'approval.request')[0]?.data;
    expect(request?.title).toBe('Write hello.txt (truncated)');
    expect(request?.detail.length).toBe(8_000);
  });

  it('in acceptEdits writes routine files without asking, but asks for sensitive ones (M3)', async () => {
    const argvFile = join(tempDir(), 'argv.json');
    process.env.FAKE_CLAUDE_ARGV_FILE = argvFile;
    const routine = run('please write', { permissionMode: 'acceptEdits' });
    const events = await collect(routine.handle);
    expect(ofType(events, 'approval.request')).toEqual([]);
    expect(readFileSync(join(routine.cwd, 'hello.txt'), 'utf8')).toBe('hi');
    // The CLI's own acceptEdits would skip the prompt tool entirely.
    expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toContain('--permission-mode=manual');

    const sensitive = run('please write:.env', { permissionMode: 'acceptEdits' });
    const asked = await collect(sensitive.handle, (event) => {
      if (event.type === 'approval.request')
        sensitive.handle.respondApproval(event.data.requestId, 'deny');
    });
    expect(ofType(asked, 'approval.request')[0]?.data.title).toBe('Write .env (sensitive path)');
    expect(existsSync(join(sensitive.cwd, '.env'))).toBe(false);
  });

  it('removes its temp folder when interrupted before the CLI starts (L1)', async () => {
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    const tmp = tempDir();
    Object.assign(process.env, { TEMP: tmp, TMP: tmp, TMPDIR: tmp });
    try {
      const { handle } = run('say hello');
      handle.interrupt();
      expect(terminalOf(await collect(handle))).toEqual({ status: 'interrupted' });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const leftover = () => readdirSync(tmp).filter((name) => name.startsWith('baios-run-'));
      await waitFor(() => leftover().length === 0, 3_000);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('ends after the last turn when inputs sent mid-turn are merged into one turn (L7)', async () => {
    const { handle } = run('merge please');
    let sent = false;
    const events = await collect(handle, (event) => {
      if (event.type === 'text.delta' && !sent) {
        sent = true;
        handle.input('one');
        handle.input('two'); // the fake runs both as a single next turn
      }
    });
    expect(textOf(events)).toBe('firstHello');
    expect(ofType(events, 'usage')).toHaveLength(2);
    expect(terminalOf(events)).toEqual({ status: 'completed' });
  });

  it('still ends when input sent mid-turn is folded into that turn (L7)', async () => {
    process.env.FAKE_CLAUDE_ABSORB_INPUT = '1';
    const { handle } = run('merge please');
    const events = await collect(handle, (event) => {
      if (event.type === 'text.delta') handle.input('more');
    });
    expect(terminalOf(events)).toEqual({ status: 'completed' });
  });

  it('classifies auth and usage-limit failures', async () => {
    const auth = terminalOf(await collect(run('auth please').handle));
    expect(auth.failure?.class).toBe('auth');
    expect(auth.failure?.message).toContain('login claude');
    const limit = terminalOf(await collect(run('limit please').handle));
    expect(limit.failure).toEqual({
      class: 'usage_limit',
      message: 'Claude usage limit reached',
      resetsAt: new Date(1_793_643_000_000).toISOString(),
    });
  });
});

describe('Claude adapter, sandbox tool mode', () => {
  it('relays a BAIOS tool through the real MCP subprocess, with built-ins off and an empty cwd', async () => {
    const dir = tempDir();
    process.env.FAKE_CLAUDE_ARGV_FILE = join(dir, 'argv.json');
    process.env.FAKE_CLAUDE_INFO_FILE = join(dir, 'info.json');
    const { handle } = run('use tool:fs_read', { toolset: TOOLSET });
    const calls: unknown[] = [];
    const events = await collect(handle, (event) => {
      if (event.type !== 'tool.call') return;
      calls.push(event.data);
      handle.resolveToolCall('call-unknown', { isError: false, output: 'ignored' });
      handle.resolveToolCall(event.data.callId, {
        isError: false,
        output: `body ${'x'.repeat(60_000)}`,
      });
    });
    expect(calls).toMatchObject([{ input: { path: 'README.md' }, name: 'fs_read' }]);
    expect(JSON.stringify(calls)).toMatch(/"callId":"call-[0-9a-f-]+"/);
    const text = textOf(events);
    expect(text.startsWith('ok body xxx')).toBe(true);
    expect(text).toContain('[output truncated: the first');
    expect(text.length).toBe('ok '.length + 48_000);
    // The server reports BAIOS tools itself.
    expect(ofType(events, 'tool.start')).toEqual([]);
    expect(ofType(events, 'tool.end')).toEqual([]);
    expect(terminalOf(events)).toEqual({ status: 'completed' });

    const argv = JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8')) as string[];
    const flags = sandboxModeArgs();
    const at = argv.indexOf(flags[0] ?? '');
    expect(argv.slice(at, at + flags.length)).toEqual(flags);
    expect(argv).toEqual(expect.arrayContaining(['--strict-mcp-config', '--restricted']));
    expect(argv).not.toContain('--permission-prompt-tool');
    expect(argv.filter((arg) => arg.startsWith('--permission-mode'))).toHaveLength(1);
    expect(argv.join(' ')).not.toMatch(/bypass|dangerously|WebFetch/i);
    const info = JSON.parse(readFileSync(join(dir, 'info.json'), 'utf8')) as {
      entries: string[];
      env: Record<string, string>;
    };
    expect(info.entries).toEqual([]);
    expect(info.env).toMatchObject({
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0',
      MCP_TOOL_TIMEOUT: '600000',
    });
  });

  it('caps the tool calls waiting on BAIOS at 8 per run (L5)', async () => {
    const { handle } = run('go slow', { toolset: TOOLSET });
    const calls: string[] = [];
    const done = collect(handle, (event) => {
      if (event.type === 'tool.call') calls.push(event.data.callId);
    });
    // What the approval bridge calls for each MCP tools/call from the CLI.
    const bridge = handle as unknown as {
      onToolCall: (name: string, input: object) => Promise<{ isError: boolean; output: string }>;
    };
    await waitFor(() => (handle as unknown as { child: unknown }).child !== null);
    const pending = Array.from({ length: MAX_PENDING_TOOL_CALLS }, () =>
      bridge.onToolCall('fs_read', {}),
    );
    expect(await bridge.onToolCall('fs_read', {})).toEqual({
      isError: true,
      output: 'Too many concurrent tool calls',
    });
    await waitFor(() => calls.length === MAX_PENDING_TOOL_CALLS);
    // A slot frees once BAIOS answers one.
    handle.resolveToolCall(calls[0] ?? '', { isError: false, output: 'ok' });
    expect(await pending[0]).toEqual({ isError: false, output: 'ok' });
    const next = bridge.onToolCall('fs_read', {});
    await waitFor(() => calls.length === MAX_PENDING_TOOL_CALLS + 1);
    handle.interrupt();
    await done;
    expect(await next).toMatchObject({ isError: true });
  });

  it('answers the CLI with an MCP error when BAIOS does not return in time', async () => {
    const quick = createClaudeAdapter({
      binary: FAKE_CLAUDE,
      selfScript: SELF_SCRIPT,
      toolCallTimeoutMs: 300,
    });
    const handle = quick.startRun({
      cwd: tempDir(),
      model: null,
      permissionMode: 'default',
      prompt: 'use tool:exec',
      resume: null,
      toolset: TOOLSET,
    });
    const events = await collect(handle);
    expect(ofType(events, 'tool.call')).toHaveLength(1);
    expect(textOf(events)).toBe('error BAIOS did not return the exec result within 1 s.');
    expect(terminalOf(events)).toEqual({ status: 'completed' });
  });

  it('fails a pending tool call when the run is interrupted', async () => {
    const log = join(tempDir(), 'tools.jsonl');
    process.env.FAKE_CLAUDE_TOOL_LOG = log;
    const { handle } = run('use tool:fs_read', { toolset: TOOLSET });
    let callId = '';
    const events = await collect(handle, (event) => {
      if (event.type !== 'tool.call') return;
      callId = event.data.callId;
      handle.interrupt();
    });
    handle.resolveToolCall(callId, { isError: false, output: 'too late' });
    expect(terminalOf(events)).toEqual({ status: 'interrupted' });
    await waitFor(() => existsSync(log), 3_000);
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual({
      content: [{ text: 'Interrupted in BAIOS.', type: 'text' }],
      isError: true,
    });
  });
});
