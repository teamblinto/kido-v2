import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { CompanionRunEvent, CompanionStatusReport } from '@repo/contracts';

import { ApiClient, normalizeServerUrl } from '../src/http.ts';
import { createService, type Service } from '../src/service.ts';
import {
  DEVICE_ID,
  DEVICE_TOKEN,
  FAKE_CLAUDE,
  FakeServer,
  SELF_SCRIPT,
  tempDir,
  waitFor,
} from './helpers.ts';

function startService(server: FakeServer): { done: Promise<string>; service: Service } {
  const service = createService({
    claudeBinary: FAKE_CLAUDE,
    interruptGraceMs: 400,
    maxConcurrentRuns: 4, // runs below overlap while finished ones shut their CLI down
    selfScript: SELF_SCRIPT,
    server: server.url,
    sessionsDir: tempDir(),
    token: DEVICE_TOKEN,
    uplink: { flushMs: 10 },
  });
  return { done: service.run(), service };
}

const TOOLSET = [{ description: 'Read', inputSchema: { type: 'object' }, name: 'fs_read' }];

const runStart = (runId: string, prompt: string, turn = 1) => ({
  conversationKey: 'project-1',
  model: null,
  prompt,
  provider: 'claude',
  resume: null,
  runId,
  toolset: TOOLSET,
  turn,
  type: 'run.start',
});

const terminal = (events: CompanionRunEvent[]) => events.find((event) => event.type === 'terminal');

describe('api client', () => {
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
});

describe('runner service', () => {
  let server: FakeServer;

  beforeEach(async () => {
    server = await new FakeServer().start();
  });

  afterEach(async () => {
    await server.close();
  });

  it('connects, reports status, runs commands end to end, and resumes after a drop', async () => {
    const { done, service } = startService(server);

    await waitFor(() => server.statuses.length > 0);
    expect(server.connects[0]?.authorization).toBe(`Bearer ${DEVICE_TOKEN}`);
    const report = server.statuses[0] as CompanionStatusReport;
    expect(Object.keys(report).sort()).toEqual(['companionVersion', 'providers']);
    expect(report.providers.map((p) => [p.provider, p.policy.allowed])).toEqual([['claude', true]]);

    // A run whose events are posted in order, with a retried batch deduplicated.
    server.failEventPosts = 1;
    const hello = randomUUID();
    server.send(runStart(hello, 'say hello'));
    await waitFor(() => terminal(server.events(hello)) !== undefined);
    const seqs = server.events(hello).map((event) => event.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    expect(terminal(server.events(hello))?.data).toEqual({ status: 'completed' });

    // A follow-up turn of the same run runs, and its events are that turn's, numbered from 1.
    server.send(runStart(hello, 'say hello', 2));
    await waitFor(() => terminal(server.events(hello, 2)) !== undefined);
    expect(server.events(hello, 2)[0]?.seq).toBe(1);
    expect(terminal(server.events(hello, 2))?.data).toEqual({ status: 'completed' });

    // Interrupt through the stream.
    const slow = randomUUID();
    server.send(runStart(slow, 'go slow'));
    await waitFor(() => server.events(slow).some((event) => event.type === 'text.delta'));
    server.send({ runId: slow, turn: 1, type: 'run.interrupt' });
    await waitFor(() => terminal(server.events(slow)) !== undefined);
    expect(terminal(server.events(slow))?.data).toEqual({ status: 'interrupted' });

    // Drop the stream: the runner redials with Last-Event-ID and does not re-run replays.
    const before = server.connects.length;
    server.dropConnections();
    await waitFor(() => server.connects.length > before);
    expect(server.connects.at(-1)?.lastEventId).toBe('4');
    server.send({ type: 'status.refresh' });
    const reports = server.statuses.length;
    await waitFor(() => server.statuses.length > reports);

    service.supervisor.stop();
    expect(await done).toBe('stopped');
    expect(server.events(hello).filter((event) => event.type === 'terminal')).toHaveLength(1);
  }, 30_000);

  it('relays a sandbox tool call up as tool.call and its tool.result back down', async () => {
    const { done, service } = startService(server);
    await waitFor(() => server.statuses.length > 0);
    const runId = randomUUID();
    server.send(runStart(runId, 'use tool:fs_read'));
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
  }, 15_000);

  it('redials when the stream goes quiet for three heartbeats', async () => {
    await server.close();
    server = await new FakeServer({
      hello: {
        deviceId: DEVICE_ID,
        heartbeatSeconds: 1,
        policy: { claude: { allowedAuthMethods: [] } },
        type: 'hello',
      },
    }).start();
    const { done, service } = startService(server);
    await waitFor(() => server.connects.length >= 2, 8_000);
    service.supervisor.stop();
    expect(await done).toBe('stopped');
  }, 15_000);

  it('stops for good on 401, and on device.revoked', async () => {
    server.revoked = true;
    expect(await startService(server).done).toBe('unauthorized');

    server.revoked = false;
    const { done } = startService(server);
    await waitFor(() => server.openStreams > 0);
    server.send({ type: 'device.revoked' });
    expect(await done).toBe('revoked');
  }, 15_000);
});
