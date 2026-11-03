import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import type { CompanionRunEvent, CompanionStatusReport } from '@repo/contracts';

import { addWorkspace, type CompanionConfig, ConfigStore } from '../src/config.ts';
import { ApiClient, normalizeServerUrl } from '../src/http.ts';
import { pair } from '../src/pairing.ts';
import { createService, type Service } from '../src/service.ts';
import {
  DEVICE_ID,
  DEVICE_TOKEN,
  FAKE_CLAUDE,
  FAKE_CODEX,
  FakeServer,
  SELF_SCRIPT,
  tempDir,
  waitFor,
} from './helpers.ts';

function configFor(server: FakeServer): CompanionConfig {
  const config = new ConfigStore(join(tempDir(), 'home')).load();
  config.server = server.url;
  config.deviceId = DEVICE_ID;
  config.providers.claude.binary = FAKE_CLAUDE;
  config.providers.codex.binary = FAKE_CODEX;
  addWorkspace(config, tempDir('baios-ws-'), 'Demo');
  config.maxConcurrentRuns = 4; // runs below overlap while finished ones shut their CLI down
  return config;
}

function startService(config: CompanionConfig): { done: Promise<string>; service: Service } {
  const service = createService({
    config,
    interruptGraceMs: 400,
    selfScript: SELF_SCRIPT,
    token: DEVICE_TOKEN,
    uplink: { flushMs: 10 },
  });
  return { done: service.run(), service };
}

const terminal = (events: CompanionRunEvent[]) => events.find((event) => event.type === 'terminal');

describe('pairing', () => {
  it('requires https except on loopback', () => {
    expect(() => normalizeServerUrl('http://baios.example')).toThrow('https');
    expect(() => normalizeServerUrl('https://user:pw@baios.example')).toThrow();
    expect(normalizeServerUrl('http://localhost:3000/')).toBe('http://localhost:3000');
    expect(normalizeServerUrl('https://baios.example/app/')).toBe('https://baios.example/app');
  });

  it('never follows a redirect, so the token cannot be sent elsewhere (M1)', async () => {
    let followed = 0;
    const server = createServer((request, response) => {
      if (request.url?.startsWith('/elsewhere')) followed += 1;
      response.writeHead(307, { location: '/elsewhere' }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const api = new ApiClient(url, DEVICE_TOKEN);
      await expect(api.post('/local-agent/status', {})).rejects.toThrow();
      await expect(api.connect('', new AbortController().signal)).rejects.toThrow();
      expect(followed).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('shows the code, opens the browser, polls, and saves the token apart from the config', async () => {
    const server = await new FakeServer().start();
    try {
      const store = new ConfigStore(join(tempDir(), 'home'));
      const printed: string[] = [];
      const open = vi.fn();
      await pair({
        name: 'Test PC',
        open,
        print: (line) => printed.push(line),
        server: server.url,
        store,
      });
      expect(printed.join('\n')).toContain('BCDF-GHJK');
      expect(open).toHaveBeenCalledWith(`${server.url}/settings/local-agents/pair`);
      expect(server.pairingPolls).toBe(2);
      expect(store.loadToken()).toBe(DEVICE_TOKEN);
      expect(store.load()).toMatchObject({ deviceId: DEVICE_ID, server: server.url });
      expect(readFileSync(store.configPath, 'utf8')).not.toContain('bld_');
      expect(printed.join('\n')).not.toContain('DDDD');
    } finally {
      await server.close();
    }
  }, 15_000);
});

describe('companion service', () => {
  let server: FakeServer;

  beforeEach(async () => {
    server = await new FakeServer().start();
  });

  afterEach(async () => {
    delete process.env.FAKE_CODEX_ACCOUNT;
    await server.close();
  });

  it('connects, reports status, runs commands end to end, and resumes after a drop', async () => {
    process.env.FAKE_CODEX_ACCOUNT = 'chatgpt'; // policy allows Codex with an API key only
    const config = configFor(server);
    const workspace = config.workspaces[0];
    if (!workspace) throw new Error('no workspace');
    const { done, service } = startService(config);

    await waitFor(() => server.statuses.length > 0);
    expect(server.connects[0]?.authorization).toBe(`Bearer ${DEVICE_TOKEN}`);
    const report = server.statuses[0] as CompanionStatusReport;
    expect(report.workspaces).toEqual([{ id: workspace.id, label: 'Demo' }]);
    expect(JSON.stringify(report)).not.toContain(JSON.stringify(workspace.path).slice(1, -1));
    expect(report.providers.find((p) => p.provider === 'claude')?.policy.allowed).toBe(true);
    expect(report.providers.find((p) => p.provider === 'codex')?.policy.allowed).toBe(false);

    // A Claude run whose events are posted in order, with a retried batch deduplicated.
    server.failEventPosts = 1;
    const hello = randomUUID();
    server.send({
      model: null,
      permissionMode: 'acceptEdits',
      prompt: 'say hello',
      provider: 'claude',
      resume: null,
      runId: hello,
      turn: 1,
      type: 'run.start',
      workspaceId: workspace.id,
    });
    await waitFor(() => terminal(server.events(hello)) !== undefined);
    const seqs = server.events(hello).map((event) => event.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    expect(terminal(server.events(hello))?.data).toEqual({ status: 'completed' });

    // A follow-up turn of the same run runs, and its events are that turn's, numbered from 1.
    server.send({
      model: null,
      permissionMode: 'default',
      prompt: 'say hello',
      provider: 'claude',
      resume: null,
      runId: hello,
      turn: 2,
      type: 'run.start',
      workspaceId: workspace.id,
    });
    await waitFor(() => terminal(server.events(hello, 2)) !== undefined);
    expect(server.events(hello, 2)[0]?.seq).toBe(1);
    expect(terminal(server.events(hello, 2))?.data).toEqual({ status: 'completed' });

    // An approval answered through the command stream.
    const write = randomUUID();
    server.send({
      model: 'sonnet',
      permissionMode: 'default',
      prompt: 'please write',
      provider: 'claude',
      resume: null,
      runId: write,
      turn: 1,
      type: 'run.start',
      workspaceId: workspace.id,
    });
    await waitFor(() => server.events(write).some((event) => event.type === 'approval.request'));
    const request = server.events(write).find((event) => event.type === 'approval.request');
    if (request?.type !== 'approval.request') throw new Error('no approval');
    server.send({
      decision: 'allow',
      requestId: request.data.requestId,
      runId: write,
      type: 'approval.respond',
    });
    await waitFor(() => terminal(server.events(write)) !== undefined);
    expect(existsSync(join(workspace.path, 'hello.txt'))).toBe(true);

    // Refusals: Codex signed in with a ChatGPT plan, and an unknown workspace.
    const codex = randomUUID();
    server.send({
      model: null,
      permissionMode: 'default',
      prompt: 'say hello',
      provider: 'codex',
      resume: null,
      runId: codex,
      turn: 1,
      type: 'run.start',
      workspaceId: workspace.id,
    });
    const elsewhere = randomUUID();
    server.send({
      model: null,
      permissionMode: 'default',
      prompt: 'hi',
      provider: 'claude',
      resume: null,
      runId: elsewhere,
      turn: 1,
      type: 'run.start',
      workspaceId: 'ws_somewhere_else',
    });
    await waitFor(
      () =>
        terminal(server.events(codex)) !== undefined &&
        terminal(server.events(elsewhere)) !== undefined,
    );
    expect(terminal(server.events(codex))?.data).toMatchObject({
      failure: { class: 'policy' },
      status: 'failed',
    });
    expect(terminal(server.events(elsewhere))?.data).toMatchObject({
      failure: { class: 'workspace' },
    });

    // Interrupt through the stream.
    const slow = randomUUID();
    server.send({
      model: null,
      permissionMode: 'default',
      prompt: 'go slow',
      provider: 'claude',
      resume: null,
      runId: slow,
      turn: 1,
      type: 'run.start',
      workspaceId: workspace.id,
    });
    await waitFor(() => server.events(slow).some((event) => event.type === 'text.delta'));
    server.send({ runId: slow, turn: 1, type: 'run.interrupt' });
    await waitFor(() => terminal(server.events(slow)) !== undefined);
    expect(terminal(server.events(slow))?.data).toEqual({ status: 'interrupted' });

    // Drop the stream: the companion redials with Last-Event-ID and does not re-run replays.
    const before = server.connects.length;
    server.dropConnections();
    await waitFor(() => server.connects.length > before);
    expect(server.connects.at(-1)?.lastEventId).toBe('8');
    server.send({ type: 'status.refresh' });
    const reports = server.statuses.length;
    await waitFor(() => server.statuses.length > reports);

    service.supervisor.stop();
    expect(await done).toBe('stopped');
    expect(server.events(hello).filter((event) => event.type === 'terminal')).toHaveLength(1);
  }, 30_000);

  it('relays a sandbox tool call up as tool.call and its tool.result back down', async () => {
    const saved = process.env.BAIOS_COMPANION_HOME;
    process.env.BAIOS_COMPANION_HOME = tempDir();
    try {
      const { done, service } = startService({ ...configFor(server), sandboxRuns: true });
      await waitFor(() => server.statuses.length > 0);
      const runId = randomUUID();
      server.send({
        conversationKey: 'project-1',
        model: null,
        permissionMode: 'default',
        prompt: 'use tool:fs_read',
        provider: 'claude',
        resume: null,
        runId,
        toolMode: 'sandbox',
        toolset: [{ description: 'Read', inputSchema: { type: 'object' }, name: 'fs_read' }],
        turn: 1,
        type: 'run.start',
        workspaceId: null,
      });
      const call = () => server.events(runId).find((event) => event.type === 'tool.call');
      await waitFor(() => call() !== undefined);
      const posted = call();
      if (posted?.type !== 'tool.call') throw new Error('no tool.call');
      expect(posted.data).toMatchObject({ input: { path: 'README.md' }, name: 'fs_read' });
      server.send({
        callId: posted.data.callId,
        ok: true,
        output: 'file body',
        runId,
        turn: 1,
        type: 'tool.result',
      });
      await waitFor(() => terminal(server.events(runId)) !== undefined);
      const events = server.events(runId);
      expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
      const text = events.map((event) => (event.type === 'text.delta' ? event.data.text : ''));
      expect(text.join('')).toBe('ok file body');
      expect(terminal(events)?.data).toEqual({ status: 'completed' });
      service.supervisor.stop();
      expect(await done).toBe('stopped');
    } finally {
      if (saved === undefined) delete process.env.BAIOS_COMPANION_HOME;
      else process.env.BAIOS_COMPANION_HOME = saved;
    }
  }, 15_000);

  it('redials when the stream goes quiet for three heartbeats', async () => {
    await server.close();
    server = await new FakeServer({
      hello: {
        deviceId: DEVICE_ID,
        heartbeatSeconds: 1,
        policy: { claude: { allowedAuthMethods: [] }, codex: { allowedAuthMethods: [] } },
        type: 'hello',
      },
    }).start();
    const { done, service } = startService(configFor(server));
    await waitFor(() => server.connects.length >= 2, 8_000);
    service.supervisor.stop();
    expect(await done).toBe('stopped');
  }, 15_000);

  it('stops for good on 401, and on device.revoked', async () => {
    server.revoked = true;
    expect(await startService(configFor(server)).done).toBe('unauthorized');

    server.revoked = false;
    const { done } = startService(configFor(server));
    await waitFor(() => server.openStreams > 0);
    server.send({ type: 'device.revoked' });
    expect(await done).toBe('revoked');
  }, 15_000);
});
