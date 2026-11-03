import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CompanionAuthEvent, CompanionRunEvent, CompanionStatusReport } from '@repo/contracts';
import { build } from 'tsup';

import tsupConfig from '../tsup.config.ts';
import { ConfigStore, hostedConfig } from '../src/config.ts';
import { ClaudeSignIn, findSignInUrl, isAllowedSignInUrl, loadHostedEnv } from '../src/hosted.ts';
import { log, setLogLevel } from '../src/log.ts';
import { createService } from '../src/service.ts';
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

const URL_LINE =
  "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=c1&state=s1";
const CODE = 'abc#xyz';

function tokenFile(content = DEVICE_TOKEN): string {
  const path = join(tempDir(), 'token');
  writeFileSync(path, `${content}\n`, { mode: 0o600 });
  return path;
}

/** Runs `fn` with these env vars set, restoring the old values after. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('hosted config', () => {
  it('finds the sign-in URL and accepts only Anthropic hosts over https', () => {
    expect(findSignInUrl(URL_LINE)).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&client_id=c1&state=s1',
    );
    expect(findSignInUrl('Opening browser to sign in…')).toBeNull();
    for (const host of ['claude.com', 'claude.ai', 'platform.claude.com']) {
      expect(isAllowedSignInUrl(`https://${host}/oauth`)).toBe(true);
    }
    for (const bad of [
      'http://claude.com/oauth',
      'https://claude.com.evil.example/oauth',
      'https://evil.example/?claude.com',
      'https://user@claude.com/',
      'https://claude.com:8443/',
      'not a url',
    ]) {
      expect(isAllowedSignInUrl(bad)).toBe(false);
    }
  });

  it('reads the server and token from the environment only', () => {
    expect(() => loadHostedEnv({})).toThrow(
      'Hosted mode needs BAIOS_SERVER_URL and BAIOS_TOKEN_FILE in the environment.',
    );
    expect(() => loadHostedEnv({ BAIOS_SERVER_URL: 'https://baios.example' })).toThrow(
      'needs BAIOS_TOKEN_FILE',
    );
    const file = tokenFile();
    expect(
      loadHostedEnv({ BAIOS_SERVER_URL: 'https://baios.example/', BAIOS_TOKEN_FILE: file }),
    ).toEqual({ allowInsecureHttp: false, server: 'https://baios.example', token: DEVICE_TOKEN });
    // Read once, then gone: the platform mints a new one per restart (L1).
    expect(existsSync(file)).toBe(false);
    expect(() =>
      loadHostedEnv({ BAIOS_SERVER_URL: 'https://a.example', BAIOS_TOKEN_FILE: tokenFile('nope') }),
    ).toThrow('does not hold a valid device token');
    expect(() =>
      loadHostedEnv({
        BAIOS_SERVER_URL: 'https://a.example',
        BAIOS_TOKEN_FILE: join(tempDir(), 'x'),
      }),
    ).toThrow('Could not read BAIOS_TOKEN_FILE');
  });

  it('allows a non-loopback http server only with BAIOS_ALLOW_INSECURE_HTTP=1', () => {
    const env = { BAIOS_SERVER_URL: 'http://api:3000', BAIOS_TOKEN_FILE: tokenFile() };
    expect(() => loadHostedEnv(env)).toThrow('https');
    expect(() => loadHostedEnv({ ...env, BAIOS_ALLOW_INSECURE_HTTP: 'true' })).toThrow('https');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      expect(loadHostedEnv({ ...env, BAIOS_ALLOW_INSECURE_HTTP: '1' })).toMatchObject({
        allowInsecureHttp: true,
        server: 'http://api:3000',
      });
      // L4: loud about it, but not for a loopback server.
      expect(warn.mock.calls.flat().join('\n')).toMatch(/INSECURE.*api:3000/);
      warn.mockClear();
      loadHostedEnv({
        BAIOS_ALLOW_INSECURE_HTTP: '1',
        BAIOS_SERVER_URL: 'http://127.0.0.1:3000',
        BAIOS_TOKEN_FILE: tokenFile(),
      });
      expect(warn.mock.calls.flat().join('\n')).not.toContain('INSECURE');
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps Claude only, no workspaces, and touches no file', () => {
    const config = hostedConfig('https://baios.example');
    expect(config.providers.codex.enabled).toBe(false);
    expect(config.workspaces).toEqual([]);
  });
});

describe('claude auth login relay', () => {
  let posted: CompanionAuthEvent[];
  let refreshed: number;
  let loginFile: string;
  let signIn: ClaudeSignIn;

  const make = (timeoutMs?: number) =>
    new ClaudeSignIn({
      binary: FAKE_CLAUDE,
      post: (event) => {
        posted.push(event);
        return Promise.resolve();
      },
      refreshStatus: () => {
        refreshed += 1;
        return Promise.resolve();
      },
      timeoutMs,
    });
  const send = (command: Record<string, unknown>) =>
    signIn.handle(JSON.stringify({ provider: 'claude', ...command }));
  const results = () => posted.filter((event) => event.type === 'auth.login.result');
  const waitForResults = (count: number) => waitFor(() => results().length >= count);
  const started = async () => {
    send({ type: 'auth.login.start' });
    await waitFor(() => posted.some((event) => event.type === 'auth.login.url'));
  };

  beforeEach(() => {
    posted = [];
    refreshed = 0;
    loginFile = join(tempDir(), 'logged-in');
    process.env.FAKE_CLAUDE_LOGIN_FILE = loginFile;
    signIn = make();
  });
  afterEach(() => {
    signIn.stop();
    delete process.env.FAKE_CLAUDE_LOGIN_FILE;
  });

  it('relays the URL, submits the code, and reports success with a fresh status', async () => {
    await started();
    expect(posted[0]).toEqual({
      provider: 'claude',
      type: 'auth.login.url',
      url: 'https://claude.com/cai/oauth/authorize?code=true&client_id=c1&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s1',
    });
    send({ code: CODE, type: 'auth.login.code' });
    await waitFor(() => refreshed > 0);
    expect(results()).toEqual([
      { message: null, ok: true, provider: 'claude', type: 'auth.login.result' },
    ]);
    expect(existsSync(loginFile)).toBe(true);
  });

  it('keeps waiting after an invalid code, and accepts a good one next', async () => {
    await started();
    send({ code: 'no-hash-here', type: 'auth.login.code' });
    await waitForResults(1);
    expect(results()[0]).toMatchObject({
      message: 'Invalid code. Please make sure the full code was copied.',
      ok: false,
    });
    send({ code: CODE, type: 'auth.login.code' });
    await waitForResults(2);
    expect(results()[1]).toMatchObject({ ok: true });
  });

  it('refuses a code of the wrong shape without writing or echoing it (L2)', async () => {
    await started();
    send({ code: 'abc#xyz && rm -rf ~', type: 'auth.login.code' });
    await waitForResults(1);
    expect(results()[0]).toEqual({
      message: 'Invalid code format',
      ok: false,
      provider: 'claude',
      type: 'auth.login.result',
    });
    expect(JSON.stringify(posted)).not.toContain('rm -rf');
    // Still waiting: the CLI never saw it, and the real code goes through.
    send({ code: CODE, type: 'auth.login.code' });
    await waitForResults(2);
    expect(results()[1]).toMatchObject({ ok: true });
  });

  it('ends on a rejected code', async () => {
    await started();
    send({ code: 'wrong#code', type: 'auth.login.code' });
    await waitForResults(1);
    expect(results()[0]).toMatchObject({ ok: false });
    expect(JSON.stringify(results())).not.toContain('wrong');
    send({ code: CODE, type: 'auth.login.code' });
    await waitForResults(2);
    expect(JSON.stringify(results()[1])).toContain('No sign-in is waiting');
    expect(refreshed).toBe(0);
  });

  it('times out, and cancels without a report', async () => {
    signIn = make(400);
    await started();
    await waitForResults(1);
    expect(results()[0]).toMatchObject({ message: 'Sign-in timed out', ok: false });

    signIn = make();
    await started();
    send({ type: 'auth.login.cancel' });
    send({ code: CODE, type: 'auth.login.code' });
    await waitForResults(2);
    expect(JSON.stringify(results()[1])).toContain('No sign-in is waiting');
    expect(existsSync(loginFile)).toBe(false);
  });

  it('refuses a sign-in address on another host', async () => {
    await withEnv({ FAKE_CLAUDE_LOGIN_URL: 'https://evil.example/cai/oauth' }, async () => {
      send({ type: 'auth.login.start' });
      await waitForResults(1);
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ ok: false, type: 'auth.login.result' });
    expect(JSON.stringify(posted[0])).toContain('unexpected sign-in address');
  });

  it('signs out with claude auth logout and reports status', async () => {
    writeFileSync(loginFile, 'signed in');
    send({ type: 'auth.logout' });
    await waitFor(() => refreshed > 0);
    expect(existsSync(loginFile)).toBe(false);
  });
});

describe('hosted runner', () => {
  let server: FakeServer;

  beforeEach(async () => {
    server = await new FakeServer().start();
  });
  afterEach(async () => {
    await server.close();
  });

  const startHosted = () => {
    const config = hostedConfig(server.url);
    config.providers.claude.binary = FAKE_CLAUDE;
    const service = createService({
      config,
      hosted: true,
      interruptGraceMs: 400,
      selfScript: SELF_SCRIPT,
      token: DEVICE_TOKEN,
      uplink: { flushMs: 10 },
    });
    return { done: service.run(), service };
  };

  it('signs in over event: auth frames without the code reaching a log or BAIOS', async () => {
    const loginFile = join(tempDir(), 'logged-in');
    const logged: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      logged.push(String(chunk));
      return true;
    });
    setLogLevel('debug');
    try {
      await withEnv({ FAKE_CLAUDE_LOGIN_FILE: loginFile }, async () => {
        const { done, service } = startHosted();
        await waitFor(() => server.statuses.length > 0);
        const first = server.statuses[0] as CompanionStatusReport;
        expect(first.workspaces).toEqual([]);
        expect(first.providers.map((status) => status.provider)).toEqual(['claude']);
        expect(first.providers[0]?.auth.status).toBe('unauthenticated');

        server.sendAuth({ provider: 'claude', type: 'auth.login.start' });
        await waitFor(() => server.authEvents.length > 0);
        expect(server.authEvents[0]).toMatchObject({ type: 'auth.login.url' });
        server.sendAuth({
          code: 'pasted-without-hash',
          provider: 'claude',
          type: 'auth.login.code',
        });
        await waitFor(() => server.authEvents.length > 1);
        server.sendAuth({ code: CODE, provider: 'claude', type: 'auth.login.code' });
        await waitFor(() => server.authEvents.length > 2);
        expect(server.authEvents[2]).toEqual({
          message: null,
          ok: true,
          provider: 'claude',
          type: 'auth.login.result',
        });
        const reports = () => server.statuses as CompanionStatusReport[];
        await waitFor(() => reports().at(-1)?.providers[0]?.auth.status === 'authenticated');

        // Workspace mode is refused outright.
        const runId = randomUUID();
        server.send({
          model: null,
          permissionMode: 'default',
          prompt: 'hi',
          provider: 'claude',
          resume: null,
          runId,
          turn: 1,
          type: 'run.start',
          workspaceId: 'ws_somewhere',
        });
        const terminal = (): CompanionRunEvent | undefined =>
          server.events(runId).find((event) => event.type === 'terminal');
        await waitFor(() => terminal() !== undefined);
        expect(terminal()?.data).toMatchObject({
          failure: { class: 'workspace' },
          status: 'failed',
        });
        expect(JSON.stringify(terminal()?.data)).toContain('only in sandbox tool mode');

        service.supervisor.stop();
        expect(await done).toBe('stopped');
      });
    } finally {
      setLogLevel('info');
      spy.mockRestore();
    }
    const everything = [...logged, ...server.bodies].join('\n');
    expect(logged.join('')).toContain('claude auth login: Opening browser');
    // L3: nothing from the login's output once a code went in, even at debug.
    expect(logged.join('')).not.toContain('Invalid code. Please');
    expect(logged.join('')).not.toContain('Login successful');
    for (const secret of [CODE, 'pasted-without-hash']) expect(everything).not.toContain(secret);
  }, 20_000);

  it('ignores event: auth frames when not hosted', async () => {
    const config = new ConfigStore(join(tempDir(), 'home')).load();
    config.server = server.url;
    config.deviceId = DEVICE_ID;
    config.providers.claude.binary = FAKE_CLAUDE;
    config.providers.codex.binary = FAKE_CODEX;
    const service = createService({ config, selfScript: SELF_SCRIPT, token: DEVICE_TOKEN });
    const done = service.run();
    await waitFor(() => server.statuses.length > 0);
    expect((server.statuses[0] as CompanionStatusReport).providers).toHaveLength(2);
    server.sendAuth({ provider: 'claude', type: 'auth.login.start' });
    server.send({ type: 'status.refresh' });
    await waitFor(() => server.statuses.length > 1);
    expect(server.authEvents).toEqual([]);
    service.supervisor.stop();
    expect(await done).toBe('stopped');
  }, 15_000);

  it('exits non-zero on 401 so the platform restarts it with a fresh token', async () => {
    server.revoked = true;
    // Not spawnSync: the fake server lives in this process and must keep answering.
    const child = spawn(process.execPath, [SELF_SCRIPT, 'start', '--hosted'], {
      env: { ...process.env, BAIOS_SERVER_URL: server.url, BAIOS_TOKEN_FILE: tokenFile() },
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise((resolve) => child.once('close', resolve));
    const result = { status: code, stderr };
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no longer accepts');
    expect(result.stderr).not.toContain(DEVICE_TOKEN);

    const missing = spawnSync(process.execPath, [SELF_SCRIPT, 'start', '--hosted'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('needs BAIOS_SERVER_URL and BAIOS_TOKEN_FILE');
  }, 20_000);
});

describe('runner bundle', () => {
  it('runs on its own, with no node_modules anywhere near it', async () => {
    const outDir = tempDir('baios-runner-');
    await build({ ...tsupConfig, outDir, silent: true, sourcemap: false });
    const bundle = join(outDir, 'main.js');
    expect(readFileSync(bundle, 'utf8')).not.toMatch(/from\s*["'](?:zod|@repo\/contracts)/);
    const runner = join(tempDir('baios-home-'), 'runner.js');
    writeFileSync(runner, readFileSync(bundle));
    const run = (args: string[], env: Record<string, string> = {}) =>
      spawnSync(process.execPath, [runner, ...args], {
        cwd: outDir,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, ...env },
      });
    expect(run(['version']).status).toBe(0);
    const bad = run(['start', '--hosted'], {
      BAIOS_SERVER_URL: 'https://baios.example',
      BAIOS_TOKEN_FILE: tokenFile('not-a-token'),
    });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('does not hold a valid device token');
  }, 60_000);
});
