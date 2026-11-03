import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { type RunResponse, runResponseSchema } from '@repo/contracts';
import { schema } from '@repo/db';
import { eq, isNull } from 'drizzle-orm';
import { createHmac, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Logger, PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { inject } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { ConflictError } from '../src/common/errors/domain-error';
import type { Environment } from '../src/config/environment';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  AGENT_TIMINGS,
  type AgentTimings,
  LLM_PROVIDER,
  SUMMARY_TAIL_TURNS,
  SUMMARY_THRESHOLD_TOKENS,
} from '../src/modules/agent/agent.constants';
import { AuditService } from '../src/modules/audit/audit.service';
import { CloudflareForSaasAdapter } from '../src/modules/deploy/domains/cloudflare-for-saas.adapter';
import type { DnsPort } from '../src/modules/deploy/domains/dns.port';
import { CHALLENGE_PREFIX } from '../src/modules/deploy/domains/domain.constants';
import { DomainRepository } from '../src/modules/deploy/domains/domain.repository';
import { DomainChecker } from '../src/modules/deploy/domains/domain-checker';
import { DomainNotices } from '../src/modules/deploy/domains/domain-notices';
import { ownershipToken, ownershipTxtValue } from '../src/modules/deploy/domains/ownership-token';
import { OutboxWriter } from '../src/modules/outbox/outbox-writer';
import { SandboxService } from '../src/modules/sandbox/sandbox.service';
import {
  DESTINATION_POLICY,
  type DestinationPolicy,
} from '../src/modules/webhooks/outbound/destination';
import { WEBHOOK_RESOLVER } from '../src/modules/webhooks/outbound/resolver.port';
import {
  CLOUDFLARE_TOKEN,
  NEON_KEY,
  NETLIFY_TOKEN,
  RESEND_KEY,
  RESEND_SENDING_KEY,
  SUPABASE_CLIENT_SECRET,
} from './fixtures/provider-fixtures';
import { unsafe } from './support/csrf-client';
import { type FakeCloudflare, startFakeCloudflare } from './support/fake-cloudflare';
import { type FakeDaytona, startFakeDaytona } from './support/fake-daytona';
import { fakeGit } from './support/fake-git';
import { type FakeReceiver, respond, startFakeReceiver } from './support/fake-receiver';
import { FakeResolver } from './support/fake-resolver';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { ScriptedProvider, type ScriptedStep } from './support/scripted-provider';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

/**
 * Hoisted above the imports on purpose. `ConfigModule.forRoot()` runs while `@Module` is being
 * evaluated — that is import time — so setting these in `beforeAll` would be too late: `AppModule`
 * would already have read `LOG_LEVEL`, and this suite would have quietly tested `info` while
 * claiming to test `trace`. The requirement is "at any level, including trace", so it runs at the
 * level that emits the most rather than the level production happens to be set to.
 */
const FAKE = vi.hoisted(() => {
  process.env.LOG_LEVEL = 'trace';
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // 021's probe drives a real run through the agent consumer against a fake Daytona (below).
  process.env.RUN_PROFILES = 'api,agent,events';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  process.env.DAYTONA_API_URL = `http://127.0.0.1:${port}/api`;
  process.env.DAYTONA_API_KEY = 'dtn_fake_key';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-redaction-e2e';
  // A distinctive value rather than the published example: a scan for
  // `local-example-webhook-secret` proves nothing, because that string is in the repository
  // already and would be "found" by any careless assertion (spec 026 SC-012).
  process.env.GITHUB_WEBHOOK_SECRET = 'whsec_4Jd7QmR2vLpXz9TnYb6KcFhGs8AeUi1OoPa3NxZw';

  return { port };
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/** Its own fake sandbox id, so a stale tenant left by another suite never collides at `register`. */
const SANDBOX_ID = 'sandbox-fake-redaction-0001';
const TIMINGS: AgentTimings = {
  batchMs: 10,
  batchSize: 32,
  cancelPollMs: 20,
  heartbeatMs: 200,
  leaseTtlMs: 1_000,
  providerAttempts: 3,
  providerBackoffBaseMs: 10,
  providerBackoffCapMs: 50,
  reaperMs: 60_000,
  staleAfterMs: 60_000,
  summaryMs: 30_000,
};

/**
 * The log-scraping gate behind §05 and success criterion 18: no secret-shaped value in captured
 * output, at any level, including `trace`.
 *
 * It runs against the real application — the real `AppModule`, the real pino configuration, the
 * real transport — and captures what the process would actually have written. Nothing is stubbed,
 * because a redaction test that scrapes a stream it built itself only proves the fixture.
 *
 * The flows live in a table so the four that do not exist yet are visible rather than absent. A
 * pending entry is never silently skipped: each one carries a guard that fails the moment its
 * route starts answering, which is the point at which somebody has to come back and drive it for
 * real. Silence is the failure mode this file exists to prevent.
 */

/**
 * Syntactically real, none of them live. A pattern proven only against `xxx` proves nothing about
 * the credential that leaks.
 */
const SECRETS = {
  anthropicKey:
    'sk-ant-api03-FqR2dEpQ1cDoP0bCnOzaBmNyZAlMxY9kLwX8jKvW7iJuV6hItU5gHsT4fGrS3eFqR2dEpQ1cDoP0bCnO',
  argon2Hash: '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG',
  daytonaKey: 'dtn_581a9f3c2e7b4d6a1c8f0e9b5a7d3c2f4e6a8b0c1d9e7f5a3b2c4d6e8f0a1b3c',
  githubToken: 'ghp_16C7e42F292c6912E7710c838347Ae178B4a',
  /** The GitHub App installation token shape the 018 connector seals (T021). */
  githubInstallationToken: 'ghs_7Kq2LmT4hV8xBn1PrKdWsYc0EgAuJiOoQrTvWx',
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  /** 020 SC-002 probes: the two shapes a BYOK key takes, at the real length. */
  byokAnthropicKey: 'sk-ant-api03-Qm7vXz2LpWk9RtHn4YbJc6FdGs8AeUi1OoPa3NxZ',
  byokOpenAiKey: 'sk-proj-Vb3kLm8QzTw2RxPn6YcJd9FhGs4AeUi7OoPa1NxZ',
  /**
   * Spec 028 FR-032: the platform's Cloudflare API token, the shape Cloudflare issues (40 characters
   * of `[A-Za-z0-9_-]`, no prefix). Nothing about it is secret-shaped, so the scrubber has no
   * pattern for it: what keeps it off the stream is that no code path ever logs it.
   */
  cloudflareApiToken: 'Zq8vT3mK1pL6nR9wX2yB5cD7fG0hJ4kM8sQ1uV3e',
  password: 'correct-horse-battery-staple',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx7Vn2pQmR8sLdTfYbGhJkNcWvUeZaOiPqXrSmTuVwYzAbCdE\n-----END RSA PRIVATE KEY-----',
  providerKey: 'sk-ant-api03-9fZq2LmT4hV8xBn1PrKdWsYc0EgAuJiOoQ',
  resetToken: 'rst_9ZyXwVuTsRqPoNmLkJiHgFeDcBa1234567890',
  sessionToken: '8Fq2LmT4hV8xBn1PrKdWsYc0EgAuJiOoQrTvWxYz',
  totpSeed: 'JBSWY3DPEHPK3PXP',
  /**
   * Spec 030 SC-002: the connector fixtures' credentials (`fixtures/provider-fixtures.ts`), the
   * shapes research R16 names. Cloudflare's and Supabase's carry no shape: nothing logs them.
   */
  connectorCloudflareToken: CLOUDFLARE_TOKEN,
  connectorNeonKey: NEON_KEY,
  connectorNetlifyToken: NETLIFY_TOKEN,
  connectorResendKey: RESEND_KEY,
  connectorResendSendingKey: RESEND_SENDING_KEY,
  connectorSupabaseClientSecret: SUPABASE_CLIENT_SECRET,
  /**
   * Spec 032 SC-003: a link's authorisation code and a subscription grant, in the double's shapes.
   * None has a shape the scrubber knows; the key-name rule (`code`, `…Token`) is what censors them.
   */
  byosCode: 'fake_code_Wq7vXz2LpWk9RtHn4YbJc6FdGs8AeUi1',
  byosAccessToken: 'fake_at_Rk3mT8vLq2xPw9nBy4cZ6dFh1jGs5aEu',
  byosRefreshToken: 'fake_rt_Hn4YbJc6FdGs8AeUi1OoPa3NxZq7vXz2L',
  /** Spec 026: the App's webhook signing secret. Every delivery is proved with it and none holds it. */
  webhookSigningSecret: 'whsec_4Jd7QmR2vLpXz9TnYb6KcFhGs8AeUi1OoPa3NxZw',
} as const;

/** The literal values that must never survive to the stream, whatever wrapped them. */
const FORBIDDEN: readonly string[] = [
  SECRETS.anthropicKey,
  SECRETS.argon2Hash,
  SECRETS.byokAnthropicKey,
  SECRETS.byosAccessToken,
  SECRETS.byosCode,
  SECRETS.byosRefreshToken,
  SECRETS.byokOpenAiKey,
  SECRETS.cloudflareApiToken,
  SECRETS.connectorCloudflareToken,
  SECRETS.connectorNeonKey,
  SECRETS.connectorNetlifyToken,
  SECRETS.connectorResendKey,
  SECRETS.connectorResendSendingKey,
  SECRETS.connectorSupabaseClientSecret,
  SECRETS.daytonaKey,
  SECRETS.githubToken,
  SECRETS.githubInstallationToken,
  SECRETS.jwt,
  SECRETS.password,
  'MIIEowIBAAKCAQEA',
  SECRETS.providerKey,
  SECRETS.resetToken,
  SECRETS.sessionToken,
  SECRETS.totpSeed,
  SECRETS.webhookSigningSecret,
];

/** Credential-bearing headers every flow carries, so each one is a real test of the header paths. */
const SECRET_HEADERS: Readonly<Record<string, string>> = {
  authorization: `Bearer ${SECRETS.jwt}`,
  cookie: `__Host-forge_session=${SECRETS.sessionToken}; theme=dark`,
  'x-api-key': SECRETS.providerKey,
};

type FlowStatus = 'live' | 'pending';

interface RedactionFlow {
  readonly method: 'get' | 'post' | 'put';
  readonly name: string;
  /** What the flow would send once it exists; asserted against the transport even while pending. */
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly path: string;
  readonly query?: string;
  readonly status: FlowStatus;
}

/**
 * One entry per flow T09 names. `pending` is a statement about the route, not about the assertion:
 * the payload is still pushed through the real transport below, and the route is still probed.
 */
const FLOWS: readonly RedactionFlow[] = [
  {
    method: 'get',
    name: 'service root',
    path: '/api/v1',
    query: `?token=${SECRETS.resetToken}&code=${SECRETS.totpSeed}`,
    status: 'live',
  },
  {
    method: 'get',
    name: 'health probe',
    path: '/api/v1/health',
    status: 'live',
  },
  {
    method: 'post',
    name: 'signup',
    path: '/api/v1/auth/signup',
    payload: { email: 'new@forge.dev', password: SECRETS.password },
    // Flipped by T13, which landed the route. Whether the policy accepts this particular password
    // is beside the point: the assertions are that nothing secret reaches stdout and that the
    // record still parses, and both hold for a 422 exactly as they do for a 202.
    status: 'live',
  },
  {
    method: 'post',
    name: 'login',
    path: '/api/v1/auth/login',
    payload: { email: 'user@forge.dev', password: SECRETS.password },
    status: 'live',
  },
  {
    method: 'post',
    name: 'password reset',
    path: '/api/v1/auth/password/reset',
    payload: { newPassword: SECRETS.password, resetToken: SECRETS.resetToken },
    // Flipped by T19, which landed the route. The payload is deliberately left as the shape this
    // table has always pushed rather than narrowed to the one the endpoint now takes: a `422` runs
    // the error path over a body carrying both a password and a token, which is the more demanding
    // test of the two for a scrubber.
    status: 'live',
  },
  {
    method: 'post',
    name: 'MFA enrolment',
    path: '/api/v1/auth/mfa/totp',
    payload: { recoveryCodes: ['aaaa-1111', 'bbbb-2222'], totpSecret: SECRETS.totpSeed },
    // Flipped by T20, which landed the route. The request arrives with no session, so this drives
    // the `401` path — and that is the more demanding case for a scrubber, not a lesser one: the
    // guard rejects before any handler runs, so the body carrying a seed and two recovery codes is
    // logged by the framework rather than by code that knows what is in it. The payload keeps the
    // shape this table has always pushed for the reason the reset entry gives.
    status: 'live',
  },
  {
    method: 'put',
    name: 'BYOK key store',
    path: '/api/v1/orgs/00000000-0000-0000-0000-000000000000/provider-keys/anthropic',
    payload: { apiKey: SECRETS.byokAnthropicKey },
    // 020 SC-002. No session, so the `401` path: the framework logs the body carrying the key
    // before any handler that knows what is in it runs.
    status: 'live',
  },
  {
    method: 'put',
    name: 'BYOK key store (OpenAI)',
    path: '/api/v1/orgs/00000000-0000-0000-0000-000000000000/provider-keys/openai',
    payload: { apiKey: SECRETS.byokOpenAiKey },
    status: 'live',
  },
  {
    method: 'post',
    name: 'BYOS link completion',
    path: '/api/v1/me/linked-accounts/openai/complete',
    payload: { code: SECRETS.byosCode, state: 'a'.repeat(43) },
    // 032 SC-003. No session, so the `401` path: the body carrying the provider's authorisation
    // code is logged by the framework before any handler that knows what is in it runs.
    status: 'live',
  },
];

/** The flows T09 requires an entry for. A later edit may flip a status; it may not drop a row. */
const REQUIRED_FLOWS = ['signup', 'login', 'password reset', 'MFA enrolment'] as const;

const live = FLOWS.filter((flow) => flow.status === 'live');
const pending = FLOWS.filter((flow) => flow.status === 'pending');

describe('log redaction (e2e)', () => {
  let app: INestApplication;
  let logger: PinoLogger;
  let suiteLock: { release: () => Promise<void> } | undefined;
  const provider = new ScriptedProvider();
  const webhookResolver = new FakeResolver();
  const loopbackOnly: DestinationPolicy = { isAllowedAddress: (ip) => ip === '127.0.0.1' };

  beforeAll(async () => {
    // The agent and events profiles are on: one process, one queue, so the worker lock is held.
    suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LLM_PROVIDER)
      .useValue(provider)
      .overrideProvider(AGENT_TIMINGS)
      .useValue(TIMINGS)
      // Spec 029: outbound webhook attempts reach a loopback receiver by name. Loopback admitted
      // here only; the real policy is proved by `webhooks-destination.e2e-spec.ts`.
      .overrideProvider(WEBHOOK_RESOLVER)
      .useValue(webhookResolver)
      .overrideProvider(DESTINATION_POLICY)
      .useValue(loopbackOnly)
      .compile();
    // `rawBody: true`, as `main.ts` passes it (ADR 049): without it the webhook guard refuses every
    // delivery and the scan below would be scanning an empty table.
    app = module.createNestApplication({ rawBody: true });
    // As `main.ts` wires it: every Nest `Logger` line reaches the sink through pino, so a
    // service that logs content is caught here rather than hidden behind the testing logger.
    app.useLogger(app.get(Logger));
    configureApplication(app);
    await app.init();
    logger = await app.resolve(PinoLogger);
  }, 600_000);

  afterAll(async () => {
    await app.close();
    await suiteLock?.release();
  });

  /**
   * Captures what the process writes rather than what a helper decides to collect, and does not
   * forward it on. If the scrubber ever fails, the secret is asserted against here and never
   * printed into a CI log — a failing redaction test must not itself become the leak.
   */
  async function captureStdout(run: () => Promise<void> | void): Promise<string> {
    const chunks: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: Uint8Array | string): boolean => {
        chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));

        return true;
      });

    try {
      await run();
      // pino-http logs on response finish, one turn after supertest resolves.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      spy.mockRestore();
    }

    return chunks.join('');
  }

  function expectNoSecrets(captured: string): void {
    // An empty capture would pass every `not.toContain` below it. It is the vacuous pass this file
    // is written to make impossible, so it is asserted first.
    expect(captured.length).toBeGreaterThan(0);

    for (const secret of FORBIDDEN) {
      expect(captured).not.toContain(secret);
    }
  }

  describe('flows that are live today', () => {
    it.each(live)('$name leaves no secret-shaped value on the stream', async (flow) => {
      const captured = await captureStdout(async () => {
        await request(app.getHttpServer() as Server)
          [flow.method](`${flow.path}${flow.query ?? ''}`)
          .set(SECRET_HEADERS)
          .send(flow.payload);
      });

      expectNoSecrets(captured);
    });

    it.each(live)('$name still produces a parseable log record', async (flow) => {
      const captured = await captureStdout(async () => {
        await request(app.getHttpServer() as Server)
          [flow.method](`${flow.path}${flow.query ?? ''}`)
          .set(SECRET_HEADERS);
      });

      const records = captured
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(records.length).toBeGreaterThan(0);
      expect(records.every((record) => typeof record.level === 'number')).toBe(true);
    });
  });

  /**
   * Declared only while something is actually pending, and as of T20 nothing is: `MFA enrolment`
   * was the last entry, and landing its route is what turned the guard below red.
   *
   * Conditional rather than left standing and empty, because Vitest fails a suite that declares no
   * tests — and the alternative shapes are both worse. A `describe.skip` would be a block nobody
   * ever reads again, and an unconditional placeholder assertion would be a test that passes by
   * having nothing to say. The mechanism is unharmed: the day a task adds a `pending` row, this
   * block comes back with it.
   */
  describe.skipIf(pending.length === 0)('flows that are not built yet', () => {
    // Visible in the runner as pending work rather than absent from it. `todo` cannot pass by
    // accident, and the guards below turn each one red the moment its route exists.
    for (const flow of pending) {
      it.todo(`${flow.name} is driven end to end once its route exists`);
    }

    // Keeps the suite non-empty for Vitest when `skipIf` is inert; never runs while any row is
    // pending, because then the `it.todo`s and the guard below populate it.
    it.skipIf(pending.length > 0)('has no flow left waiting for a route', () => {
      expect(pending).toEqual([]);
    });

    /**
     * The guard. While the route 404s this asserts a fact that is true and checkable; the day
     * somebody lands the route it fails, naming the flow, and the only way to make it green is to
     * flip the table entry to `live` and let the real assertion above run. That is the opposite of
     * a skipped test: it cannot be forgotten, because implementing the feature breaks the build.
     */
    it.each(pending)(
      '$name is still unimplemented — flip its table entry to live when this fails',
      async (flow) => {
        const response = await request(app.getHttpServer() as Server)
          [flow.method](flow.path)
          .set(SECRET_HEADERS)
          .send(flow.payload);

        expect(response.status).toBe(404);
      },
    );
  });

  /**
   * The pending routes cannot be driven, but their payloads can be pushed through the same real
   * transport the route would use. This is what stops the four pending entries from being an
   * excuse: the shapes they carry are proven scrubbed today, and only the HTTP driving is owed.
   */
  describe('the transport, at trace level', () => {
    it.each(FLOWS.filter((flow) => flow.payload !== undefined))(
      "scrubs $name's payload when it is logged",
      async (flow) => {
        const captured = await captureStdout(() => {
          logger.trace({ flow: flow.name, request: flow.payload }, 'flow payload');
        });

        expectNoSecrets(captured);
      },
    );

    it('scrubs a secret interpolated into a trace message', async () => {
      const captured = await captureStdout(() => {
        logger.trace(`provider call with ${SECRETS.providerKey}`);
      });

      expectNoSecrets(captured);
    });

    it('scrubs a GitHub App installation token out of a trace message', async () => {
      const captured = await captureStdout(() => {
        logger.trace(
          { token: SECRETS.githubInstallationToken },
          `github push with ${SECRETS.githubInstallationToken}`,
        );
      });

      expectNoSecrets(captured);
    });

    // Spec 030 SC-002: a pasted connector credential logged by mistake is censored by its shape.
    it.each([
      ['Netlify token', SECRETS.connectorNetlifyToken],
      ['Neon key', SECRETS.connectorNeonKey],
      ['Resend key', SECRETS.connectorResendKey],
      ['Resend sending key', SECRETS.connectorResendSendingKey],
    ])('scrubs a connector %s out of a trace message and a field', async (_label, credential) => {
      const captured = await captureStdout(() => {
        logger.trace({ pasted: { value: credential } }, `connector verify with ${credential}`);
      });

      expectNoSecrets(captured);
    });

    it('scrubs a secret nested well below any path the redact list names', async () => {
      const captured = await captureStdout(() => {
        logger.debug(
          { run: { credential: { byok: { value: SECRETS.providerKey } } } },
          'run started',
        );
      });

      expectNoSecrets(captured);
    });

    it('scrubs a PEM block and a password hash out of an error stack', async () => {
      const captured = await captureStdout(() => {
        logger.error(
          { err: new Error(`decrypt failed for ${SECRETS.pem} / ${SECRETS.argon2Hash}`) },
          'crypto failure',
        );
      });

      expectNoSecrets(captured);
    });

    it('scrubs a Daytona API key logged under a key nobody predicted', async () => {
      const captured = await captureStdout(() => {
        logger.warn({ daytona: SECRETS.daytonaKey }, 'sandbox lookup');
      });

      expectNoSecrets(captured);
    });

    it('scrubs an Anthropic API key logged under a key nobody predicted', async () => {
      const captured = await captureStdout(() => {
        logger.warn({ somethingNobodyListed: SECRETS.anthropicKey }, 'provider lookup');
      });

      expectNoSecrets(captured);
    });

    it('scrubs a GitHub token logged under a key nobody predicted', async () => {
      const captured = await captureStdout(() => {
        logger.info({ somethingNobodyListed: SECRETS.githubToken }, 'connector sync');
      });

      expectNoSecrets(captured);
    });

    it.each(['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const)(
      'scrubs at %s level',
      async (level) => {
        const captured = await captureStdout(() => {
          logger[level]({ apiKey: SECRETS.providerKey }, 'levelled');
        });

        expectNoSecrets(captured);
      },
    );
  });

  /**
   * 020 SC-002: the sinks a BYOK key could reach besides a request body (the two `BYOK key store`
   * flows above) — a thrown `DomainError` message, an `audit.record` metadata object, a run `state`
   * event's `reason`. Each is pushed through the real transport and must show the censor marker,
   * not merely lack the key: a sink that dropped the whole record would pass `not.toContain`.
   */
  describe('BYOK sinks (020 SC-002)', () => {
    const PROBES = [
      ['Anthropic', SECRETS.byokAnthropicKey],
      ['OpenAI', SECRETS.byokOpenAiKey],
    ] as const;

    function expectCensored(captured: string): void {
      expectNoSecrets(captured);
      expect(captured).toContain('[Redacted:provider-key]');
    }

    it.each(PROBES)('censors an %s key in a thrown DomainError message', async (_name, key) => {
      const captured = await captureStdout(() => {
        logger.error(
          { err: new ConflictError(`provider rejected ${key}`, { reason: 'key-rejected' }) },
          'key store refused',
        );
      });

      expectCensored(captured);
    });

    it.each(PROBES)('censors an %s key in audit.record metadata', async (_name, key) => {
      const captured = await captureStdout(() => {
        logger.info(
          {
            action: 'provider-key.added',
            metadata: { apiKey: key, lastFour: key.slice(-4), note: `stored ${key}` },
            target: 'provider-key',
          },
          'audit.record',
        );
      });

      expectCensored(captured);
    });

    it.each(PROBES)('censors an %s key in a run state event reason', async (_name, key) => {
      const captured = await captureStdout(() => {
        logger.info(
          {
            event: {
              data: { from: 'running', reason: `provider unauthorised for ${key}`, to: 'failed' },
              type: 'state',
            },
          },
          'run event',
        );
      });

      expectCensored(captured);
    });
  });

  /**
   * Spec 032 SC-003: the link body's `code` and a grant carried on a thrown error. Neither value has
   * a shape; the key-name rule censors both, and the record itself survives.
   */
  describe('BYOS sinks (032 SC-003)', () => {
    it('censors the complete body’s code in a request log record', async () => {
      const captured = await captureStdout(() => {
        logger.info(
          { req: { body: { code: SECRETS.byosCode, state: 'a'.repeat(43) }, method: 'POST' } },
          'request completed',
        );
      });

      expectNoSecrets(captured);
      expect(captured).toContain('request completed');
    });

    it('censors a grant carried on a thrown error', async () => {
      const captured = await captureStdout(() => {
        const error = Object.assign(new Error('BYOS refresh failed'), {
          grant: {
            accessToken: SECRETS.byosAccessToken,
            refreshToken: SECRETS.byosRefreshToken,
          },
        });
        logger.error({ err: error }, 'refresh failed');
      });

      expectNoSecrets(captured);
      expect(captured).toContain('BYOS refresh failed');
    });
  });

  /**
   * 021: the repository map and the running summary are project and conversation content. Their
   * log lines carry sizes and counts; the text itself must never reach the sink, at trace level.
   */
  describe.skipIf(!postgres || !redis)('021 context assembly (real run, fake Daytona)', () => {
    const MAP_SENTINEL = 'SENTINEL_MAP_7f3a';
    const SUMMARY_SENTINEL = 'SENTINEL_SUMMARY_9c1b';
    let fake: FakeDaytona;
    let world: TwoTenantWorld;

    beforeAll(async () => {
      fake = await startFakeDaytona({ port: FAKE.port, sandboxId: SANDBOX_ID });
      fakeGit(fake);
      world = await createTwoTenantWorld(app);
      const transactions = app.get(TenantTransactionRunner);
      const { orgId, projectId } = world.alpha;
      await transactions.runInTenantScope({ orgId, userId: null }, (tx) =>
        app.get(SandboxService).register(tx, { daytonaId: fake.sandboxId, orgId, projectId }),
      );
    }, 600_000);

    afterAll(async () => {
      if (world) await destroyTwoTenantWorld(app, world);
      await fake?.close();
    });

    async function completeRun(steps: readonly ScriptedStep[]): Promise<RunResponse> {
      provider.script(...steps);
      const path = `/api/v1/orgs/${world.alpha.orgId}/projects/${world.alpha.projectId}/runs`;
      const response = await unsafe(http(app).post(path), [world.alpha.owner.cookie])
        .send({ prompt: 'Read the big file until you know it' })
        .expect(201);
      const created = runResponseSchema.parse(response.body);
      const deadline = Date.now() + 30_000;

      for (;;) {
        const read = await http(app)
          .get(`${path}/${created.id}`)
          .set('Cookie', world.alpha.owner.cookie)
          .expect(200);
        const run = runResponseSchema.parse(read.body);
        if (run.status === 'succeeded') return run;
        if (run.status === 'failed' || Date.now() > deadline) {
          throw new Error(`run ended ${run.status}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    it('021: map and summary log lines carry sizes and counts, never the map or summary text', async () => {
      // A sentinel path in the map; a big file whose reads push the conversation over the
      // summary threshold within `SUMMARY_TAIL_TURNS + 1` turns, so the cheap-model call fires.
      const turns = SUMMARY_TAIL_TURNS + 1;
      const big = 'x'.repeat(Math.ceil((SUMMARY_THRESHOLD_TOKENS * 4) / turns) + 4_096);
      fake.workspace.set(`${fake.workDir}/src/${MAP_SENTINEL}.ts`, {
        content: Buffer.from('export const sentinel = 1;\n'),
        kind: 'file',
      });
      fake.workspace.set(`${fake.workDir}/big.txt`, { content: Buffer.from(big), kind: 'file' });
      const reads: ScriptedStep[] = Array.from({ length: turns }, (_, i) => ({
        toolCalls: [{ id: `call-${String(i)}`, input: { path: 'big.txt' }, name: 'fs_read' }],
      }));

      const captured = await captureStdout(async () => {
        await completeRun([
          ...reads,
          // The summary call, then the model's final answer.
          { text: `The user read big.txt repeatedly. ${SUMMARY_SENTINEL}` },
          { text: 'done' },
        ]);
      });

      // The probe looked at the right lines: a map size and a summary token count were logged.
      expect(captured).toMatch(/map rebuilt: run=\S+ files=\d+ unread=\d+ bytes=\d+/);
      expect(captured).toMatch(/summary stored: run=\S+ through=\S+ tokens=\d+/);
      expect(captured).not.toContain(MAP_SENTINEL);
      expect(captured).not.toContain(SUMMARY_SENTINEL);
    }, 60_000);
  });

  /**
   * Spec 026 SC-012: the webhook's own surfaces.
   *
   * Four places a credential could come to rest once an inbound delivery is accepted — the
   * `webhook_deliveries` row, the response, the process's stdout and the audit trail — scanned for
   * the App's signing secret and for every token this file already forbids. The signing secret is
   * the one that matters most here: it is the only credential the request path uses, it is used on
   * every single delivery, and an endpoint that echoed it into a log line would hand anyone reading
   * that log the ability to forge deliveries for the whole App.
   *
   * Every scan refuses an empty input **first**. A scan of nothing finds nothing, and this file
   * exists to make that particular green impossible.
   */
  describe.skipIf(!postgres || !redis)('webhook surfaces (026 SC-012)', () => {
    let db: ForgeDatabase;
    let world: TwoTenantWorld;

    beforeAll(async () => {
      db = app.get<ForgeDatabase>(APP_DATABASE);
      // Two real tenants, so the audit scan below has a trail to scan. Without them `audit_log` is
      // empty and the scan passes by finding nothing — which is the vacuous green this file exists
      // to refuse, and which the first run of this test duly failed on.
      world = await createTwoTenantWorld(app);
    }, 120_000);

    afterAll(async () => {
      if (world) await destroyTwoTenantWorld(app, world);
    });

    function signed(body: string): string {
      return `sha256=${createHmac('sha256', SECRETS.webhookSigningSecret)
        .update(Buffer.from(body, 'utf8'))
        .digest('hex')}`;
    }

    /** Every `audit_log` row every tenant holds, serialised — the trail as a scanner would see it. */
    async function auditText(): Promise<string> {
      const runner = app.get(TenantTransactionRunner);
      const tenants = await db
        .select({ id: schema.orgs.id })
        .from(schema.orgs)
        .where(isNull(schema.orgs.deletedAt));
      const parts: string[] = [];

      for (const { id } of tenants) {
        const rows = await runner.runInTenantTransaction(id, async (tx) =>
          tx.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, id)),
        );

        parts.push(JSON.stringify(rows));
      }

      return parts.join('\n');
    }

    function scan(what: string, text: string): void {
      // Refused first, so a capture that collected nothing cannot pass by having nothing in it.
      expect(text.length, `${what} was empty; a scan of nothing proves nothing`).toBeGreaterThan(0);

      for (const secret of FORBIDDEN) {
        expect(text, `${what} carried a forbidden value`).not.toContain(secret);
      }
    }

    it('leaves the signing secret in none of the row, the response, the stream or the trail', async () => {
      const deliveryId = randomUUID();
      const body = JSON.stringify({
        after: '9a7c2d1e5b3f4086a2c1d0e9f8b7a6c5d4e3f201',
        installation: { id: 42_000_123 },
        ref: 'refs/heads/main',
        repository: { id: 8_800_001 },
      });
      let response: request.Response | undefined;

      const captured = await captureStdout(async () => {
        response = await request(app.getHttpServer() as Server)
          .post('/api/v1/webhooks/github')
          .set(SECRET_HEADERS)
          .set('content-type', 'application/json')
          .set('x-github-delivery', deliveryId)
          .set('x-github-event', 'push')
          .set('x-hub-signature-256', signed(body))
          .send(body)
          .expect(204);
      });

      // The delivery really was accepted: without this the three scans below are scans of a
      // pipeline that refused, which would prove nothing about what an accepted one leaves behind.
      const rows = await db.select().from(schema.webhookDeliveries);

      expect(rows.some((row) => row.deliveryId === deliveryId)).toBe(true);

      scan('the stdout capture', captured);
      scan('the response', `${String(response?.status)} ${response?.text ?? ''}`.trim());
      scan('every webhook_deliveries row', JSON.stringify(rows));
      scan('every audit_log row', await auditText());
    });

    it('leaves the signing secret out of a refusal, which is the path that handles a forgery', async () => {
      const body = JSON.stringify({ ref: 'refs/heads/main' });
      let response: request.Response | undefined;

      const captured = await captureStdout(async () => {
        response = await request(app.getHttpServer() as Server)
          .post('/api/v1/webhooks/github')
          .set(SECRET_HEADERS)
          .set('content-type', 'application/json')
          .set('x-github-delivery', randomUUID())
          .set('x-github-event', 'push')
          .set('x-hub-signature-256', `sha256=${'a'.repeat(64)}`)
          .send(body)
          .expect(401);
      });

      scan('the refusal stdout capture', captured);
      scan('the refusal response', response?.text ?? '');
      // Not the expected signature, not the computed one, not a prefix of either: a refusal that
      // showed its working would be a signature oracle.
      expect(response?.text ?? '').not.toContain('sha256=');
    });
  });

  /**
   * Spec 029 T054: an outbound webhook attempt that succeeds and one that fails leave, on no log
   * line at any level, the endpoint's signing secret (`whsec_`), the endpoint URL's full query
   * string, or the receiver's response body. The capture spans the whole flow: the endpoint is
   * created over HTTP (the response carries the secret), a test ping is sent, and the in-process
   * attempt worker settles it.
   */
  describe.skipIf(!postgres || !redis)('outbound webhook attempts (029 T054)', () => {
    const HOST = 'receiver.redaction-e2e.test';
    const QUERY = '?token=qs_T054Zq8vT3mK1pL6nR9wX2yB&tenant=redaction';
    const SUCCESS_BODY = 'receiver-said-ok-T054-9fZq2LmT4hV8xBn1';
    const FAILURE_BODY = 'receiver-said-down-T054-7Kq2LmT4hV8xBn1';
    let receiver: FakeReceiver;
    let world: TwoTenantWorld;

    beforeAll(async () => {
      receiver = await startFakeReceiver();
      webhookResolver.set(HOST, [['127.0.0.1']]);
      world = await createTwoTenantWorld(app);
    }, 120_000);

    afterAll(async () => {
      if (world) await destroyTwoTenantWorld(app, world);
      await receiver?.close();
    });

    async function attempt(path: string, expected: 'pending' | 'succeeded'): Promise<string> {
      const orgId = world.alpha.orgId;
      const endpoints = `/api/v1/orgs/${orgId}/webhooks/endpoints`;
      return captureStdout(async () => {
        const created = await unsafe(http(app).post(endpoints), [world.alpha.owner.cookie])
          .send({
            eventTypes: ['deploy.succeeded'],
            url: `${receiver.url(path, { host: HOST })}${QUERY}`,
          })
          .expect(201);
        const { endpoint, secret } = created.body as { endpoint: { id: string }; secret: string };
        // The flow really carried a secret and a query: otherwise the scans below prove nothing.
        expect(secret).toMatch(/^whsec_/);

        const sent = await unsafe(http(app).post(`${endpoints}/${endpoint.id}/test`), [
          world.alpha.owner.cookie,
        ]).expect(202);
        const sendId = (sent.body as { id: string }).id;

        const deadline = Date.now() + 15_000;
        // Settled: out of `pending`, or back in it after one retryable attempt (US3's schedule).
        let state = 'pending';
        let attempted = false;
        while (state === 'pending' && !attempted && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const [row] = await app.get(TenantTransactionRunner).runInTenantTransaction(orgId, (tx) =>
            tx
              .select({
                attempts: schema.webhookSends.attempts,
                claimedUntil: schema.webhookSends.claimedUntil,
                state: schema.webhookSends.state,
              })
              .from(schema.webhookSends)
              .where(eq(schema.webhookSends.id, sendId)),
          );
          state = row?.state ?? 'pending';
          attempted = (row?.attempts ?? 0) > 0 && row?.claimedUntil === null;
        }
        expect(state).toBe(expected);
        const [received] = receiver.requests(path);
        expect(received?.path).toBe(`${path}${QUERY}`);
      });
    }

    function scan(captured: string): void {
      expect(captured.length).toBeGreaterThan(0);
      for (const line of captured.split('\n')) {
        expect(line).not.toContain('whsec_');
        expect(line).not.toContain(QUERY);
        expect(line).not.toContain(QUERY.slice(1));
        expect(line).not.toContain(SUCCESS_BODY);
        expect(line).not.toContain(FAILURE_BODY);
      }
      for (const secret of FORBIDDEN) expect(captured).not.toContain(secret);
    }

    it('a successful attempt logs no signing secret, query string or response body', async () => {
      receiver.script('/ok', respond(200, { body: SUCCESS_BODY }));
      scan(await attempt('/ok', 'succeeded'));
    });

    it('a failed attempt logs no signing secret, query string or response body', async () => {
      receiver.script('/down', respond(500, { body: FAILURE_BODY }));
      scan(await attempt('/down', 'pending'));
    });
  });

  /**
   * Spec 028 FR-032, SC-014: the edge calls a domain check makes, one that fails and one that
   * succeeds, leave `CLOUDFLARE_API_TOKEN` on no log line at any level. The real
   * `CloudflareForSaasAdapter` talks to the fake edge over HTTP with the token as its bearer; the
   * real `DomainChecker` drives it and logs through the app's own logger (`useLogger` above), so
   * its `registration deferred` warning is on the captured stream. The checker is built from the
   * app's repository, transactions, audit and outbox, with DNS answering that ownership is proved
   * (so the check asks the edge to register) and a clock in 2100, so the rows are due only to it
   * and never to a domain sweep in a concurrent suite.
   */
  describe.skipIf(!postgres || !redis)('the edge token (028 FR-032, SC-014)', () => {
    const at = new Date('2100-06-01T00:00:00.000Z');
    const target = 'customers.forge-edge.test';
    const tokens = new Map<string, string>();
    let fake: FakeCloudflare;
    let adapter: CloudflareForSaasAdapter;
    let checker: DomainChecker;
    let world: TwoTenantWorld;
    const inserted: string[] = [];

    const dns: DnsPort = {
      resolveCaa: () => Promise.resolve({ kind: 'empty' }),
      resolveCnameChain: () => Promise.resolve({ chain: [target], kind: 'answer' }),
      resolveSoaOwner: () => Promise.resolve({ kind: 'empty' }),
      resolveTxt: (name) => {
        const token = tokens.get(name.slice(CHALLENGE_PREFIX.length));

        return Promise.resolve(
          token === undefined
            ? { kind: 'empty' }
            : { kind: 'answer', records: [ownershipTxtValue(token)] },
        );
      },
    };

    beforeAll(async () => {
      fake = await startFakeCloudflare({ apiToken: SECRETS.cloudflareApiToken });
      const values: Record<string, string> = {
        CLOUDFLARE_API_TOKEN: SECRETS.cloudflareApiToken,
        CLOUDFLARE_API_URL: fake.apiUrl,
        CLOUDFLARE_ZONE_ID: fake.zoneId,
        CUSTOM_HOSTNAME_CA: 'lets_encrypt',
        CUSTOM_HOSTNAME_TARGET: target,
      };
      const config = { get: (key: string) => values[key] } as unknown as ConfigService<
        Environment,
        true
      >;

      adapter = new CloudflareForSaasAdapter(config);
      checker = new DomainChecker(
        app.get(TenantTransactionRunner),
        app.get(DomainRepository),
        app.get(AuditService),
        app.get(OutboxWriter),
        { now: () => new Date(at.getTime() + 5000) },
        dns,
        adapter,
        config,
        app.get(DomainNotices),
      );
      world = await createTwoTenantWorld(app);
    }, 600_000);

    afterAll(async () => {
      // Whatever the settles wrote to the shared outbox is not for a relay elsewhere.
      for (const id of inserted) {
        await app
          .get<ForgeDatabase>(APP_DATABASE)
          .update(schema.outbox)
          .set({ publishedAt: new Date() })
          .where(eq(schema.outbox.aggregateId, id));
      }
      if (world) await destroyTwoTenantWorld(app, world);
      await fake?.close();
    });

    /** A pending domain on alpha's project whose ownership record DNS will show. */
    async function pendingDomain(): Promise<{ hostname: string; id: string }> {
      const { orgId, owner, projectId } = world.alpha;
      const hostname = `edge-${randomUUID().slice(0, 8)}.redaction.example.test`;
      const token = ownershipToken();
      const domain = await app.get(TenantTransactionRunner).runInTenantTransaction(orgId, (tx) =>
        app.get(DomainRepository).insert(tx, {
          addedBy: owner.userId,
          hostname,
          now: at,
          orgId,
          ownershipToken: token,
          projectId,
        }),
      );

      tokens.set(hostname, token);
      inserted.push(domain.id);
      return { hostname, id: domain.id };
    }

    /** The token really was on the wire: without it, "not in the logs" is true of a no-op. */
    function expectBearerSent(path: string): void {
      expect(
        fake.requests.some(
          (sent) =>
            sent.path.includes(path) &&
            sent.headers.authorization === `Bearer ${SECRETS.cloudflareApiToken}`,
        ),
      ).toBe(true);
    }

    it('a failing registration (the edge answers 503) logs its deferral without the token', async () => {
      const domain = await pendingDomain();
      const before = fake.requests.length;
      let outcome: Awaited<ReturnType<DomainChecker['checkOne']>> | undefined;

      fake.failNext(503);
      const captured = await captureStdout(async () => {
        outcome = await checker.checkOne(world.alpha.orgId, domain.id);
      });

      expect(fake.requests.length).toBeGreaterThan(before);
      expectBearerSent('custom_hostnames');
      expect(outcome?.kind).toBe('settled');
      expect(fake.find(domain.hostname)).toBeUndefined();
      // The warning was written, so the scan is of the failure path's own line.
      expect(captured).toContain('registration deferred');
      expectNoSecrets(captured);
    });

    it('a successful registration logs nothing that carries the token', async () => {
      const domain = await pendingDomain();
      let outcome: Awaited<ReturnType<DomainChecker['checkOne']>> | undefined;

      const captured = await captureStdout(async () => {
        outcome = await checker.checkOne(world.alpha.orgId, domain.id);
        // One line of our own, so the capture is never empty whatever the success path logs.
        logger.info({ domainId: domain.id }, 'edge registration probe done');
      });

      expect(outcome?.kind).toBe('settled');
      expect(fake.find(domain.hostname)).toBeDefined();
      expectBearerSent('custom_hostnames');
      expectNoSecrets(captured);
    });

    it.each(['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const)(
      'an edge failure logged whole at %s level carries no token',
      async (level) => {
        const failures: unknown[] = [];

        fake.failNext(503);
        await adapter
          .register(`edge-503-${level}.redaction.example.test`)
          .catch((error: unknown) => {
            failures.push(error);
          });
        fake.refuseNext(403, 'Authentication error');
        await adapter
          .register(`edge-403-${level}.redaction.example.test`)
          .catch((error: unknown) => {
            failures.push(error);
          });
        await adapter.status('no-such-edge-id').catch((error: unknown) => {
          failures.push(error);
        });

        expect(failures).toHaveLength(3);

        const captured = await captureStdout(() => {
          for (const err of failures) logger[level]({ err }, 'edge call failed');
        });

        expectNoSecrets(captured);
      },
    );
  });

  describe('the table itself', () => {
    it('drives at least one flow for real', () => {
      expect(live.length).toBeGreaterThan(0);
    });

    it.each(REQUIRED_FLOWS)('has an entry for %s', (name) => {
      expect(FLOWS.map((flow) => flow.name)).toContain(name);
    });

    it('gives every pending flow a payload, so nothing is pending and empty', () => {
      for (const flow of pending) {
        expect(flow.payload).toBeDefined();
      }
    });
  });
});
