import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CompanionToolDefinition } from '@repo/contracts';

import { codexDecision, createCodexAdapter } from '../src/providers/codex/index.ts';
import type { RunEventBody, StartRunOptions } from '../src/providers/types.ts';
import { collect, FAKE_CODEX, SELF_SCRIPT, tempDir, terminalOf, textOf } from './helpers.ts';

const adapter = createCodexAdapter({
  binary: FAKE_CODEX,
  interruptGraceMs: 400,
  selfScript: SELF_SCRIPT,
});

function run(prompt: string, extra: Partial<StartRunOptions> = {}) {
  const cwd = tempDir('baios-ws-');
  const handle = adapter.startRun({
    cwd,
    model: null,
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

afterEach(() => {
  delete process.env.FAKE_CODEX_ACCOUNT;
  delete process.env.FAKE_CODEX_PARAMS_FILE;
});

describe('Codex adapter', () => {
  it('probes through app-server: API key, ChatGPT plan, signed out; visible models only', async () => {
    expect(await adapter.probe()).toMatchObject({
      auth: { method: 'api_key', plan: null, status: 'authenticated' },
      installed: true,
      models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }],
      version: '0.162.1',
    });
    process.env.FAKE_CODEX_ACCOUNT = 'chatgpt';
    const chatgpt = await adapter.probe();
    expect(chatgpt.auth).toEqual({ method: 'subscription', plan: 'Plus', status: 'authenticated' });
    expect(JSON.stringify(chatgpt)).not.toContain('someone@example.com');
    process.env.FAKE_CODEX_ACCOUNT = 'none';
    const signedOut = await adapter.probe();
    expect(signedOut.auth.status).toBe('unauthenticated');
    expect(signedOut.message).toContain('login codex');
  });

  it('runs a turn, ignoring unknown notifications, and maps the permission mode to policy', async () => {
    const paramsFile = join(tempDir(), 'params.json');
    process.env.FAKE_CODEX_PARAMS_FILE = paramsFile;
    const { cwd, handle } = run('say hello', { model: 'gpt-6.1-sol' });
    const events = await collect(handle);
    expect(events[0]).toEqual({ data: { providerSessionId: 'thread-1' }, type: 'session' });
    expect(textOf(events)).toBe('Hello');
    expect(ofType(events, 'usage')).toEqual([
      { data: { inputTokens: 10, outputTokens: 5 }, type: 'usage' },
    ]);
    expect(terminalOf(events)).toEqual({ status: 'completed' });
    expect(JSON.parse(readFileSync(paramsFile, 'utf8'))).toEqual({
      method: 'thread/start',
      params: {
        approvalPolicy: 'untrusted',
        cwd,
        model: 'gpt-6.1-sol',
        sandbox: 'workspace-write',
      },
    });
  });

  it('resumes a thread read-only in plan mode', async () => {
    const paramsFile = join(tempDir(), 'params.json');
    process.env.FAKE_CODEX_PARAMS_FILE = paramsFile;
    const events = await collect(
      run('hello again', { permissionMode: 'plan', resume: 'thread-7' }).handle,
    );
    expect(events[0]).toEqual({ data: { providerSessionId: 'thread-7' }, type: 'session' });
    expect(JSON.parse(readFileSync(paramsFile, 'utf8'))).toMatchObject({
      method: 'thread/resume',
      params: { excludeTurns: true, sandbox: 'read-only', threadId: 'thread-7' },
    });
  });

  it('asks for a command and accepts it', async () => {
    const { handle } = run('run a command');
    const events = await collect(handle, (event) => {
      if (event.type === 'approval.request') handle.respondApproval(event.data.requestId, 'allow');
    });
    expect(ofType(events, 'approval.request')[0]?.data).toMatchObject({
      detail: 'node -v',
      kind: 'command',
      title: 'Run: node -v',
    });
    expect(ofType(events, 'tool.start')[0]?.data).toEqual({
      input: { command: 'node -v' },
      name: 'command',
      toolId: 'exec-1',
    });
    expect(ofType(events, 'tool.output')[0]?.data).toEqual({
      chunk: 'v24.0.0\n',
      toolId: 'exec-1',
    });
    expect(ofType(events, 'tool.end')[0]?.data).toEqual({
      ok: true,
      summary: 'completed (exit 0)',
      toolId: 'exec-1',
    });
    expect(textOf(events)).toBe('decision:accept');
    expect(terminalOf(events)).toEqual({ status: 'completed' });
  });

  it('denies with cancel when the request does not offer decline', async () => {
    expect(codexDecision('deny', ['accept', 'cancel'])).toBe('cancel');
    expect(codexDecision('deny', null)).toBe('decline');
    expect(codexDecision('allow', ['accept', 'cancel'])).toBe('accept');
    // L5: an allow never widens into a session-wide approval.
    expect(codexDecision('allow', ['acceptForSession', 'decline'])).toBe('decline');
    expect(codexDecision('allow', ['acceptForSession', 'cancel'])).toBe('cancel');
    const { handle } = run('run a command');
    const events = await collect(handle, (event) => {
      if (event.type === 'approval.request') handle.respondApproval(event.data.requestId, 'deny');
    });
    expect(textOf(events)).toBe('decision:cancel');
    expect(ofType(events, 'tool.end')[0]?.data.ok).toBe(false);
  });

  it('asks for a file change in default mode, auto-accepts it in acceptEdits, declines it in plan', async () => {
    const asked = run('edit a file');
    const events = await collect(asked.handle, (event) => {
      if (event.type === 'approval.request')
        asked.handle.respondApproval(event.data.requestId, 'allow');
    });
    expect(ofType(events, 'approval.request')[0]?.data).toMatchObject({
      detail: 'hello.txt\nhi\n',
      kind: 'file_change',
      title: 'Edit hello.txt',
    });
    expect(ofType(events, 'file.change')).toEqual([
      { data: { kind: 'created', path: 'hello.txt' }, type: 'file.change' },
    ]);
    expect(JSON.stringify(events)).not.toContain(JSON.stringify(asked.cwd).slice(1, -1));

    const auto = run('edit a file', { permissionMode: 'acceptEdits' });
    const autoEvents = await collect(auto.handle);
    expect(ofType(autoEvents, 'approval.request')).toEqual([]);
    expect(textOf(autoEvents)).toBe('decision:accept');

    const plan = run('edit a file', { permissionMode: 'plan' });
    const planEvents = await collect(plan.handle);
    expect(ofType(planEvents, 'approval.request')).toEqual([]);
    expect(textOf(planEvents)).toBe('decision:decline');
    expect(existsSync(join(plan.cwd, 'hello.txt'))).toBe(false);
  });

  it('in plan mode refuses commands locally, without asking BAIOS (H3)', async () => {
    const events = await collect(run('run a command', { permissionMode: 'plan' }).handle);
    expect(ofType(events, 'approval.request')).toEqual([]);
    expect(textOf(events)).toBe('decision:cancel'); // the fake offers no plain decline
  });

  it('declines a command too long to show whole (M2)', async () => {
    const events = await collect(run('run a long command').handle);
    expect(ofType(events, 'approval.request')).toEqual([]);
    expect(textOf(events)).toBe('decision:cancel');
  });

  it('in acceptEdits still asks for a sensitive path (M3)', async () => {
    const { cwd, handle } = run('edit a file:.git/config', { permissionMode: 'acceptEdits' });
    const events = await collect(handle, (event) => {
      if (event.type === 'approval.request') handle.respondApproval(event.data.requestId, 'deny');
    });
    expect(ofType(events, 'approval.request')[0]?.data.title).toBe(
      'Edit .git/config (sensitive path)',
    );
    expect(textOf(events)).toBe('decision:decline');
    expect(existsSync(join(cwd, '.git', 'config'))).toBe(false);
  });

  it('interrupts the turn', async () => {
    const { handle } = run('go slow');
    const events = await collect(handle, (event) => {
      if (event.type === 'text.delta') handle.interrupt();
    });
    expect(terminalOf(events)).toEqual({ status: 'interrupted' });
  });

  it('classifies a usage limit and reports a crash with scrubbed stderr', async () => {
    expect(terminalOf(await collect(run('limit me').handle)).failure).toMatchObject({
      class: 'usage_limit',
      message: 'You hit your usage limit.',
    });
    const crash = terminalOf(await collect(run('crash now').handle)).failure;
    expect(crash?.class).toBe('crash');
    expect(crash?.message).toContain('panic');
    expect(crash?.message).not.toContain('abc123secret');
  });

  it('refuses sandbox tool mode, which it does not support yet', async () => {
    const toolset: CompanionToolDefinition[] = [
      { description: 'Read', inputSchema: { type: 'object' }, name: 'fs_read' },
    ];
    const terminal = terminalOf(await collect(run('say hello', { toolset }).handle));
    expect(terminal.failure?.class).toBe('provider');
    expect(terminal.failure?.message).toContain('sandbox');
  });
});
