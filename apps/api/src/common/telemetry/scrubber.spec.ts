import { Writable } from 'node:stream';

import { REDACTION_CENSOR } from './redaction';
import {
  createLogDestination,
  createScrubbingDestination,
  SECRET_SHAPES,
  scrubLogLine,
  scrubSecrets,
} from './scrubber';

/**
 * One representative value per shape. These are syntactically real — a pattern that only matches
 * the placeholder `xxx` in a spec proves nothing about the key that leaks in production — and none
 * of them is a live credential.
 */
const FIXTURES = [
  {
    name: 'anthropic api key',
    secret: 'sk-ant-api03-9fZq2LmT4hV8xBn1PrKdWsYc0EgAuJiOoQ',
    shape: 'provider-key',
  },
  {
    name: 'openai project key',
    secret: 'sk-proj-Tb7Lm2Qx9Vn4Kd8Ws1Zr6Yc3Hg5Ja0Pi',
    shape: 'provider-key',
  },
  { name: 'stripe secret key', secret: 'sk_live_51NxQvZ2eZvKYlo2C0aBcDeFg', shape: 'provider-key' },
  {
    name: 'github personal token',
    secret: 'ghp_16C7e42F292c6912E7710c838347Ae178B4a',
    shape: 'github-token',
  },
  {
    name: 'github server token',
    secret: 'ghs_1B4a2c6912E7710c838347Ae178B4a16C7e4',
    shape: 'github-token',
  },
  {
    name: 'github fine-grained token',
    secret: 'github_pat_11ABCDEFG0abcdefghijkl_9ZyXwVuTsRqPoNmLkJiHgFeDcBa',
    shape: 'github-token',
  },
  {
    name: 'jwt',
    secret:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    shape: 'jwt',
  },
  {
    name: 'argon2id hash',
    secret: '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG',
    shape: 'password-hash',
  },
  {
    name: 'bcrypt hash',
    secret: '$2b$12$K3JNi5xUuVh0GkOaVoJhSeqBQ8vYlR7dP2mXcZtA1sLfNwErTyUiO',
    shape: 'password-hash',
  },
  { name: 'aws access key id', secret: 'AKIAIOSFODNN7EXAMPLE', shape: 'aws-key' },
  {
    name: 'slack bot token',
    secret: 'xoxb-2401234567-2402345678-AbCdEfGhIjKlMnOpQrStUvWx',
    shape: 'slack-token',
  },
  {
    name: 'daytona api key',
    secret: 'dtn_581a9f3c2e7b4d6a1c8f0e9b5a7d3c2f4e6a8b0c1d9e7f5a3b2c4d6e8f0a1b3c',
    shape: 'daytona-key',
  },
  // Spec 030 R16: the connector providers' credentials.
  { name: 'resend api key', secret: 're_4kQz9Xw2Lm7Pv3Rt8Ny5Bc1D', shape: 'resend-key' },
  {
    name: 'supabase publishable key',
    secret: 'sb_publishable_Zx8Kq2Wm4Pn6Rt1Vb3Yc5D',
    shape: 'supabase-key',
  },
  {
    name: 'supabase secret key',
    secret: 'sb_secret_Hq7Lw2Mz9Kx4Pt6Rv1Nb8C',
    shape: 'supabase-key',
  },
  {
    name: 'netlify personal access token',
    secret: 'nfp_Q7mZ2xK9pW4rT8vN3bL6cY1dF5',
    shape: 'netlify-token',
  },
  {
    name: 'local agent pairing code in a request path',
    secret: '/api/v1/me/local-agents/pairings/BCDF-GHJK',
    shape: 'local-agent-pairing-code',
  },
  {
    name: 'neon api key',
    secret: 'napi_k3m9x2q7w4p8r1t6v5n0b3l7c2y9z4d8f1g6h5j0',
    shape: 'neon-key',
  },
] as const;

const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEAx7Vn2pQmR8sLdTfYbGhJkNcWvUeZaOiPqXrSmTuVwYzAbCdE',
  'FgHiJkLmNoPqRsTuVwXyZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFG',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

function expectHidden(scrubbed: string, secret: string): void {
  expect(scrubbed).not.toContain(secret);
  expect(scrubbed).toContain('[Redacted');
}

describe('scrubSecrets', () => {
  it.each(FIXTURES)('redacts a $name', ({ secret }) => {
    expectHidden(scrubSecrets(`credential=${secret} end`), secret);
  });

  it.each(FIXTURES)('names the $shape shape it matched on a $name', ({ secret, shape }) => {
    expect(scrubSecrets(secret)).toContain(`[Redacted:${shape}]`);
  });

  it('redacts a PEM block written with real newlines', () => {
    expectHidden(scrubSecrets(`key:\n${PEM}\nafter`), 'MIIEowIBAAKCAQEA');
  });

  /**
   * The scrubber runs on serialised NDJSON, where a multi-line PEM has already become a single line
   * with two-character `\n` escapes. A pattern that only understands real newlines would sail past
   * every PEM that ever reaches a log file, which is the only place it can reach.
   */
  it('redacts a PEM block written with JSON-escaped newlines', () => {
    const escaped = JSON.stringify(PEM);

    expectHidden(scrubSecrets(escaped), 'MIIEowIBAAKCAQEA');
  });

  it('redacts a PEM block whose footer was truncated away', () => {
    const truncated = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw';

    expectHidden(scrubSecrets(truncated), 'MIIEvQIBADANBgkqhkiG9w0B');
  });

  it('redacts a __Host- cookie value but keeps the cookie name', () => {
    const scrubbed = scrubSecrets('__Host-forge_session=8Fq2LmT4hV8xBn1PrKdWsYc0; other=1');

    expect(scrubbed).not.toContain('8Fq2LmT4hV8xBn1PrKdWsYc0');
    expect(scrubbed).toContain('__Host-forge_session=');
    expect(scrubbed).toContain('other=1');
  });

  it('redacts a __Secure- cookie value', () => {
    expectHidden(scrubSecrets('__Secure-refresh=9ZyXwVuTsRqPoNmLkJiHg'), '9ZyXwVuTsRqPoNmLkJiHg');
  });

  it('redacts a bearer token that is not otherwise shaped', () => {
    expectHidden(
      scrubSecrets('Bearer 7Kd2Lm9Qx4Vn8Ws1Zr6Yc3Hg5Ja0Pi'),
      '7Kd2Lm9Qx4Vn8Ws1Zr6Yc3Hg5Ja0Pi',
    );
  });

  it('redacts basic auth credentials', () => {
    expectHidden(scrubSecrets('Basic dXNlcjpwYXNzd29yZA=='), 'dXNlcjpwYXNzd29yZA==');
  });

  it('redacts the password in a connection string but keeps the host', () => {
    const scrubbed = scrubSecrets('postgres://forge:s3cr3tP4ss@db.internal:5432/forge');

    expect(scrubbed).not.toContain('s3cr3tP4ss');
    expect(scrubbed).toContain('db.internal:5432/forge');
  });

  it('redacts a TOTP seed out of an otpauth URI', () => {
    expectHidden(
      scrubSecrets('otpauth://totp/Forge:a@b.dev?secret=JBSWY3DPEHPK3PXP&issuer=Forge'),
      'JBSWY3DPEHPK3PXP',
    );
  });

  /**
   * `req.query` is redacted by path, but pino-http logs `req.url` as well and the raw query string
   * is still in it. Redacting the whole URL would cost every route and status a log is read for,
   * so the parameter *name* decides, and the rest of the line survives.
   */
  it.each([
    ['token', '/api/v1/verify?token=rst_9ZyXwVuTsRqPoNmLkJiHgFeDcBa1234567890'],
    ['code', '/api/v1/oauth/callback?code=4/0AY0e-g7&state=xyz'],
    ['access_token', '/cb#access_token=ya29.a0AfH6SMBx1234567890'],
    ['api_key', '/v1/things?api_key=abcdef123456&page=2'],
  ])('redacts a %s query parameter', (_name, url) => {
    const scrubbed = scrubSecrets(url);

    expect(scrubbed).toContain('[Redacted:query-credential]');
    expect(scrubbed).not.toMatch(/=(?:rst_|4\/0AY0e|ya29|abcdef)/);
  });

  it('keeps the path and the harmless parameters of a redacted URL', () => {
    const scrubbed = scrubSecrets('/api/v1/verify?token=rst_9ZyXwVuTsRq&next=/dashboard');

    expect(scrubbed).toContain('/api/v1/verify?token=');
    expect(scrubbed).toContain('next=/dashboard');
    expect(scrubbed).not.toContain('rst_9ZyXwVuTsRq');
  });

  it('keeps the route of a redacted pairing code, and the approve and deny routes whole', () => {
    expect(scrubSecrets('GET /api/v1/me/local-agents/pairings/bcdf-ghjk?x=1 200')).toBe(
      'GET /api/v1/me/local-agents/pairings/[Redacted:local-agent-pairing-code]?x=1 200',
    );

    for (const route of ['approve', 'deny']) {
      const url = `POST /api/v1/me/local-agents/pairings/${route} 204`;
      expect(scrubSecrets(url)).toBe(url);
    }
  });

  it('leaves a query parameter that names nothing secret alone', () => {
    const url = '/api/v1/things?page=2&sort=name&limit=50';

    expect(scrubSecrets(url)).toBe(url);
  });

  /**
   * Over-redaction is the safe direction but it is not free — a scrubber that eats request ids and
   * durations makes the log useless and gets switched off, which is how it ends up leaking.
   */
  it.each([
    'GET /api/v1/health 200 in 4ms',
    'request id 01JQ8ZK4M6N2P7R9T3V5X8Y0BC',
    'user asked to skip-verification for account 42',
    'took 1.5s, retried 3 times',
    'AKIA is a prefix we mention in a comment',
  ])('leaves ordinary log text alone: %s', (text) => {
    expect(scrubSecrets(text)).toBe(text);
  });

  it('redacts every shape when several share one line', () => {
    const line = FIXTURES.map((fixture) => fixture.secret).join(' ');
    const scrubbed = scrubSecrets(line);

    for (const { secret } of FIXTURES) {
      expect(scrubbed).not.toContain(secret);
    }
  });

  it('is idempotent, so a censored line survives a second pass unchanged', () => {
    const once = scrubSecrets(FIXTURES.map((fixture) => fixture.secret).join(' '));

    expect(scrubSecrets(once)).toBe(once);
  });

  it('exposes a shape entry for every name the fixtures claim', () => {
    const names = new Set(SECRET_SHAPES.map((shape) => shape.name));

    for (const { shape } of FIXTURES) {
      expect(names).toContain(shape);
    }
  });
});

describe('scrubLogLine', () => {
  it('redacts a secret-shaped value nested four levels deep', () => {
    const line = JSON.stringify({
      level: 30,
      msg: 'run started',
      run: { credentials: { byok: { key: 'sk-ant-api03-9fZq2LmT4hV8xBn1PrKdWsYc0EgAuJiOoQ' } } },
    });

    expectHidden(scrubLogLine(line), 'sk-ant-api03-9fZq2LmT4hV8xBn1PrKdWsYc0EgAuJiOoQ');
  });

  it('redacts a secret interpolated into the message string', () => {
    const line = JSON.stringify({
      level: 10,
      msg: 'token=ghp_16C7e42F292c6912E7710c838347Ae178B4a',
    });

    expectHidden(scrubLogLine(line), 'ghp_16C7e42F292c6912E7710c838347Ae178B4a');
  });

  it('redacts a secret inside an error stack', () => {
    const line = JSON.stringify({
      err: {
        message: 'auth failed',
        stack: 'Error: auth failed with sk_live_51NxQvZ2eZvKYlo2C0aBcDeFg\n    at x',
      },
      level: 50,
    });

    expectHidden(scrubLogLine(line), 'sk_live_51NxQvZ2eZvKYlo2C0aBcDeFg');
  });

  /** Spec 040: the request record pino-http wrote for a pairing preview, as QA found it leaking. */
  it('redacts a pairing code in every place the request record carries the path', () => {
    const line = JSON.stringify({
      level: 30,
      msg: 'request completed',
      req: {
        id: 7,
        method: 'GET',
        originalUrl: '/api/v1/me/local-agents/pairings/GTXM-NVDB',
        params: {
          splat: ['api', 'v1', 'me', 'local-agents', 'pairings', 'GTXM-NVDB'],
          userCode: 'GTXM-NVDB',
        },
        url: '/api/v1/me/local-agents/pairings/GTXM-NVDB',
      },
    });
    const scrubbed = JSON.parse(scrubLogLine(line)) as {
      req: { params: { splat: string[] }; url: string };
    };

    expect(JSON.stringify(scrubbed)).not.toContain('GTXM-NVDB');
    expect(scrubbed.req.url).toBe(
      '/api/v1/me/local-agents/pairings/[Redacted:local-agent-pairing-code]',
    );
    expect(scrubbed.req.params.splat).toEqual([
      'api',
      'v1',
      'me',
      'local-agents',
      'pairings',
      '[Redacted:local-agent-pairing-code]',
    ]);
  });

  it('keeps the approve and deny routes whole in the splat param', () => {
    for (const route of ['approve', 'deny']) {
      const splat = ['api', 'v1', 'me', 'local-agents', 'pairings', route];
      const line = JSON.stringify({ req: { params: { splat } } });

      expect(JSON.parse(scrubLogLine(line))).toEqual({ req: { params: { splat } } });
    }
  });

  /**
   * The value-shape rules only catch secrets whose format gives them away. A password is just a
   * string, so the second family of rules works on the key name instead — at any depth, under any
   * parent, which is what a path list cannot do.
   */
  it.each([
    'password',
    'newPassword',
    'currentPassword',
    'passphrase',
    'sessionId',
    'session_token',
    'refreshToken',
    'resetToken',
    'clientSecret',
    'apiKey',
    'api_key',
    'privateKey',
    'recoveryCodes',
    'mfaSeed',
    'totpSecret',
    'dek',
  ])('redacts the value of a field named %s wherever it appears', (key) => {
    const line = JSON.stringify({ level: 30, outer: { [key]: 'correct-horse-battery-staple' } });

    expect(scrubLogLine(line)).not.toContain('correct-horse-battery-staple');
  });

  /**
   * Spec 032 R15: the OAuth grant and link-flow fields. `code` is anchored — a bare `code` is an
   * authorisation code, while `statusCode` or `errorCode` is not a secret.
   */
  it.each([
    'accessToken',
    'refreshToken',
    'idToken',
    'code',
    'codeVerifier',
    'deviceCode',
    'code_verifier',
    'device_code',
  ])('redacts the value of an OAuth field named %s (032 R15)', (key) => {
    const line = JSON.stringify({ level: 30, body: { [key]: 'plain-looking-value-123' } });

    expect(scrubLogLine(line)).not.toContain('plain-looking-value-123');
  });

  it('leaves statusCode and errorCode alone although they contain "code"', () => {
    const line = JSON.stringify({ errorCode: 'ECONNREFUSED', level: 30, statusCode: '502' });

    expect(JSON.parse(scrubLogLine(line))).toMatchObject({
      errorCode: 'ECONNREFUSED',
      statusCode: '502',
    });
  });

  /**
   * The bare `code` rule is narrowed to credentials: a pg SQLSTATE or a Node errno on `err.code`
   * is what an operator reads first, and none of those shapes is an authorisation code.
   */
  it.each(['23505', '40P01', 'ECONNREFUSED', 'EAI_AGAIN', 'ERR_INVALID_ARG_TYPE', '429'])(
    'keeps an error code %s readable on err.code',
    (code) => {
      const line = JSON.stringify({ err: { code, message: 'failed', type: 'Error' }, level: 50 });

      expect(JSON.parse(scrubLogLine(line))).toMatchObject({ err: { code } });
    },
  );

  it.each([
    'SplxlOBeZQQYbYS6WxSbIA',
    '4/0AY0e-g7xQ2mK9pL3nR8wT',
    'fake_code_Zq2LmT4hV8xBn1PrKdWsYc0E',
    'a1b2c3d4e5f6a7b8c9d0',
    'WDJB-MJHT',
  ])('still censors an authorisation code %s on a field named code', (code) => {
    const line = JSON.stringify({ body: { code, state: 'x' }, level: 30 });

    expect(scrubLogLine(line)).not.toContain(code);
  });

  it.each([
    ['a JWT-shaped id token', FIXTURES.find((fixture) => fixture.shape === 'jwt')!.secret],
    ['an sk-ant-oat subscription token', 'sk-ant-oat01-Zq2LmT4hV8xBn1PrKdWsYc0EgAuJiOoQ9fXy'],
  ])('censors %s wherever it appears, whatever the key (032 R15)', (_name, secret) => {
    const line = JSON.stringify({ level: 30, msg: `grant ${secret}`, detail: { note: secret } });

    expectHidden(scrubLogLine(line), secret);
  });

  it('redacts every element of a secret-named array', () => {
    const line = JSON.stringify({ level: 30, recoveryCodes: ['aaaa-1111', 'bbbb-2222'] });
    const scrubbed = scrubLogLine(line);

    expect(scrubbed).not.toContain('aaaa-1111');
    expect(scrubbed).not.toContain('bbbb-2222');
  });

  it('leaves a non-secret field of the same object intact', () => {
    const line = JSON.stringify({ email: 'a@b.dev', level: 30, password: 'hunter2' });
    const scrubbed = JSON.parse(scrubLogLine(line)) as Record<string, unknown>;

    expect(scrubbed).toMatchObject({ email: 'a@b.dev', level: 30, password: REDACTION_CENSOR });
  });

  it('leaves a numeric field alone even when its name looks secret', () => {
    const line = JSON.stringify({ level: 30, tokenCount: 512 });

    expect(JSON.parse(scrubLogLine(line))).toMatchObject({ tokenCount: 512 });
  });

  it('emits valid JSON that pino consumers can still parse', () => {
    const line = JSON.stringify({ level: 30, msg: `key ${FIXTURES[0].secret}`, pem: PEM });

    expect(() => {
      JSON.parse(scrubLogLine(line));
    }).not.toThrow();
  });

  /**
   * `pino-pretty` and a crashing serialiser can both put a non-JSON line on the stream. Falling
   * back to the string rules keeps the guarantee that nothing leaves unscrubbed; throwing here
   * would take out the logger, and a logger that crashes is a logger someone removes.
   */
  it('falls back to string scrubbing when the line is not JSON', () => {
    const scrubbed = scrubLogLine('INFO plain text ghp_16C7e42F292c6912E7710c838347Ae178B4a');

    expectHidden(scrubbed, 'ghp_16C7e42F292c6912E7710c838347Ae178B4a');
  });

  it('leaves a clean line byte-identical', () => {
    const line = JSON.stringify({ level: 30, msg: 'listening on 3000' });

    expect(scrubLogLine(line)).toBe(line);
  });
});

describe('createScrubbingDestination', () => {
  function sink(): { lines: string[]; stream: Writable } {
    const lines: string[] = [];

    return {
      lines,
      stream: new Writable({
        write(chunk, _encoding, callback) {
          lines.push(String(chunk));
          callback();
        },
      }),
    };
  }

  it('forwards a scrubbed line to the inner destination', () => {
    const inner = sink();
    const destination = createScrubbingDestination(inner.stream);

    destination.write(`${JSON.stringify({ level: 30, msg: `k ${FIXTURES[0].secret}` })}\n`);

    expect(inner.lines.join('')).not.toContain(FIXTURES[0].secret);
  });

  it('preserves the trailing newline pino writes', () => {
    const inner = sink();
    const destination = createScrubbingDestination(inner.stream);

    destination.write(`${JSON.stringify({ level: 30, msg: 'ok' })}\n`);

    expect(inner.lines.join('')).toBe(`${JSON.stringify({ level: 30, msg: 'ok' })}\n`);
  });

  it('forwards two lines written in one chunk as two lines', () => {
    const inner = sink();
    const destination = createScrubbingDestination(inner.stream);

    destination.write('{"level":30,"msg":"a"}\n{"level":30,"msg":"b"}\n');

    expect(inner.lines.join('').trimEnd().split('\n')).toHaveLength(2);
  });

  /**
   * A `Writable` is allowed to receive a secret split across two chunks. Scrubbing each chunk on
   * arrival would let the halves pass and rejoin in the file, so the stream buffers to the newline
   * pino terminates every record with and scrubs whole lines only.
   */
  it('redacts a secret split across two chunk boundaries', () => {
    const inner = sink();
    const destination = createScrubbingDestination(inner.stream);
    const line = `${JSON.stringify({ level: 30, msg: `k ${FIXTURES[0].secret}` })}\n`;
    const split = Math.floor(line.length / 2);

    destination.write(line.slice(0, split));
    destination.write(line.slice(split));

    expect(inner.lines.join('')).not.toContain(FIXTURES[0].secret);
  });

  it('flushes a final unterminated line, scrubbed, when the stream ends', async () => {
    const inner = sink();
    const destination = createScrubbingDestination(inner.stream);

    destination.write(JSON.stringify({ level: 30, msg: `k ${FIXTURES[0].secret}` }));
    await new Promise<void>((resolve) => destination.end(resolve));

    expect(inner.lines.join('')).not.toContain(FIXTURES[0].secret);
    expect(inner.lines.join('')).toContain('[Redacted');
  });
});

/**
 * The development branch is the one the rest of the suite never reaches, because tests run with
 * `NODE_ENV=test`. It is also the branch that loads `pino-pretty` dynamically and rearranges the
 * stream chain, so "it worked in production" says nothing about it. If pretty-printing ever ran
 * *before* the scrubber, a developer's terminal and scrollback would be the leak.
 */
describe('createLogDestination', () => {
  it('scrubs before pretty-printing, so the rendered line carries no secret', async () => {
    const written: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        written.push(String(chunk));
        callback();
      },
    });

    const destination = await createLogDestination({ pretty: true, sink });

    destination.write(
      `${JSON.stringify({ level: 30, msg: `key ${FIXTURES[0].secret}`, time: 0 })}\n`,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const rendered = written.join('');

    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toContain(FIXTURES[0].secret);
    expect(rendered).toContain('[Redacted:provider-key]');
  });

  it('renders the surviving part of the line, so pretty output is still readable', async () => {
    const written: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        written.push(String(chunk));
        callback();
      },
    });

    const destination = await createLogDestination({ pretty: true, sink });

    destination.write(`${JSON.stringify({ level: 30, msg: 'listening on 3000', time: 0 })}\n`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(written.join('')).toContain('listening on 3000');
  });

  it('scrubs when pretty-printing is off', async () => {
    const written: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        written.push(String(chunk));
        callback();
      },
    });

    const destination = await createLogDestination({ pretty: false, sink });

    destination.write(`${JSON.stringify({ level: 30, msg: `key ${FIXTURES[0].secret}` })}\n`);

    expect(written.join('')).not.toContain(FIXTURES[0].secret);
    expect(written.join('')).toContain('[Redacted:provider-key]');
  });
});
