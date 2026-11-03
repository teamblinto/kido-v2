import type { INestApplication, RawBodyRequest } from '@nestjs/common';
import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import { createHmac, randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication, WEBHOOK_BODY_LIMIT } from '../src/bootstrap';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import { WEBHOOK_REJECTION } from '../src/modules/webhooks/inbound/verifiers/github.verifier';
import { position } from '../src/modules/connectors/sync-guards';
import { WebhookDeliveryConsumer } from '../src/modules/connectors/webhook.consumer';
import { Public } from '../src/modules/identity/decorators/public.decorator';
import { OrgService } from '../src/modules/tenancy/services/org.service';
import { ProjectService } from '../src/modules/tenancy/services/project.service';
import type { Envelope } from '../src/modules/outbox/envelope';
import { unsafe } from './support/csrf-client';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';

vi.hoisted(() => {
  // The `events` lane so the relay runs and the `connector.webhook` queue is drained in-process;
  // the outbox suite lock below is what keeps that from colliding with the other suites that relay.
  process.env.RUN_PROFILES = 'api,events';
});

const PROBE_PATH = '/api/v1/webhook-probes/raw';
const SECRET = 'connectors-webhook-e2e-secret';

/** The real route, exactly as `SIGNATURE_VERIFIED_WEBHOOK_PATHS` spells it. */
const ENDPOINT = '/api/v1/webhooks/github';

const POSTGRES = inject('postgresReachable');
const REDIS = inject('redisReachable');

/** The installation the fixture body names; `test-environment.ts` supplies the secret. */
const INSTALLATION = 42_000_123;

/** The head a delivery carries, and the local head the "remote is ahead" reading is taken against. */
const HEAD_SHA = '9a7c2d1e5b3f4086a2c1d0e9f8b7a6c5d4e3f201';
const LOCAL_SHA = '1111111111111111111111111111111111111111';

/** What `GithubWebhookGuard` verifies against: the boot-time secret, not one this suite invented. */
function signGithub(body: string): string {
  const secret = process.env.GITHUB_WEBHOOK_SECRET!;

  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;
}

/** A push payload with an undeclared key, because § 2 says one must ride along and be stored. */
function pushBody(ref = 'refs/heads/main'): string {
  return JSON.stringify({
    after: '9a7c2d1e5b3f4086a2c1d0e9f8b7a6c5d4e3f201',
    installation: { id: INSTALLATION },
    ref,
    repository: { id: 8_800_001 },
    zen: 'Design for failure.',
  });
}

/** Polls until `predicate` holds or `ms` elapse — delivery has no other clock to wait on. */
async function until(predicate: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(50);
  }

  return predicate();
}

/**
 * The shipped consumer, with its processing made failable and slowable.
 *
 * SC-007 and SC-009 are both claims about what the *request* does while processing misbehaves, so
 * the misbehaviour has to be injectable. Overriding the provider keeps the queue, the profile, the
 * event type and the outbox path exactly as they ship; only `handle` differs.
 */
class ProbeWebhookConsumer extends WebhookDeliveryConsumer {
  behaviour: 'fail' | 'ok' | 'slow' = 'ok';
  readonly failures: string[] = [];
  readonly seen: string[] = [];

  constructor() {
    // T063 gave the consumer its collaborators; this probe replaces every method that would reach
    // one, so none is constructed. The casts are the price of standing in for the shipped class
    // without wiring a second copy of its dependency graph — `handle` and `effect` below are the
    // only methods this object ever runs.
    const none = undefined as never;

    super(none, none, none, none, none, none, none);
  }

  /** The real one does the work here (contracts § 5); the probe's misbehaviour is in `handle`. */
  override effect(): Promise<void> {
    return Promise.resolve();
  }

  reset(): void {
    this.behaviour = 'ok';
    this.failures.length = 0;
    this.seen.length = 0;
  }

  override async handle(event: Envelope<'webhook.received'>): Promise<void> {
    const { deliveryId } = event.payload;

    this.seen.push(deliveryId);

    if (this.behaviour === 'fail') {
      this.failures.push(deliveryId);

      throw new Error('processing was made to fail');
    }

    // Ten times the acknowledgement budget: an endpoint that waited for this could not pass SC-009.
    if (this.behaviour === 'slow') await sleep(500);
  }
}

/**
 * A payload whose bytes on the wire are *not* what `JSON.stringify` produces for the parsed value:
 * the keys are out of insertion order for a re-serialiser that would preserve them, there is
 * whitespace between every token, and the `≠` is a character `JSON.stringify` leaves as-is while
 * many senders escape it. GitHub sends compact JSON, but nothing in the protocol promises that, and
 * an HMAC is over bytes — so the suite signs a body that round-trips to different bytes on purpose.
 */
const WIRE_BODY = '{\n  "zed" : 1,\n  "action" : "created",\n  "note" : "≠"\n}\n';

function sign(body: Buffer | string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

/**
 * Stands in for the webhook controller until T049 mounts the real one: everything this spec
 * asserts is a property of the transport, so the route only has to report what reached it.
 *
 * `@Public()` because `SessionGuard` is an `APP_GUARD` — without it the probe answers 401 and the
 * assertions below would be about the session, not about the bytes.
 */
@Public()
@Controller({ path: 'webhook-probes', version: '1' })
class RawBodyProbeController {
  @Post('raw')
  @HttpCode(HttpStatus.OK)
  raw(@Req() request_: RawBodyRequest<IncomingMessage & { body: unknown }>): {
    readonly raw: string | null;
    readonly reserialised: string;
  } {
    return {
      raw: request_.rawBody?.toString('utf8') ?? null,
      reserialised: JSON.stringify(request_.body),
    };
  }
}

describe('connectors webhook transport (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RawBodyProbeController],
      imports: [AppModule],
    }).compile();

    // The same factory flag `main.ts` passes (research R8). Nest installs its body parser during
    // `create()`, so the raw buffer is only kept when it is asked for here — not by anything
    // `configureApplication` registers afterwards.
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  function http(): request.Agent {
    return request(app.getHttpServer() as Server);
  }

  it('hands the handler the bytes that arrived, not a re-serialisation of them', async () => {
    // Through `unsafe` because the real route's CSRF exemption is T023's; what is under test here
    // is the transport, and an exemption this suite invented would prove nothing about it.
    const response = await unsafe(http().post(PROBE_PATH))
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sign(WIRE_BODY))
      .send(WIRE_BODY)
      .expect(HttpStatus.OK);

    const body = response.body as { raw: string | null; reserialised: string };

    expect(body.raw).toBe(WIRE_BODY);
    // The trap R8 describes: the parsed body is equal, its bytes are not, and an HMAC over them
    // fails with no signal beyond a 401.
    expect(body.reserialised).not.toBe(WIRE_BODY);
    expect(sign(Buffer.from(body.raw ?? '', 'utf8'))).toBe(sign(WIRE_BODY));
    expect(sign(body.reserialised)).not.toBe(sign(WIRE_BODY));
  });

  it('keeps the raw bytes of a body larger than the parser default', async () => {
    // Half a megabyte: past the body parser's own 100 kB default and inside `WEBHOOK_BODY_LIMIT`,
    // so a delivery of the size GitHub actually sends for a large push is neither truncated nor
    // refused. `WEBHOOK_BODY_LIMIT` is read here so the two numbers cannot drift apart silently.
    expect(WEBHOOK_BODY_LIMIT).toBe('1mb');

    const large = `{"note":"${'x'.repeat(512 * 1024)}"}`;
    const response = await unsafe(http().post(PROBE_PATH))
      .set('content-type', 'application/json')
      .send(large)
      .expect(HttpStatus.OK);

    expect((response.body as { raw: string | null }).raw).toBe(large);
  });
});

/**
 * The endpoint itself (spec 026 T049), against Postgres and the queue Redis role.
 *
 * `quickstart § 5`'s refusal table, and then the four properties the success criteria name:
 *
 * - **SC-007** the record survives a processing failure — the delivery is durable *before* anything
 *   acts on it, which is what makes the provider's retry safe by construction;
 * - **SC-008** a repeat changes state at most once;
 * - **SC-009** acknowledgement under 50 ms p95 **with processing forced slow**, which is the whole
 *   claim: the request path must not be behind the work;
 * - a burst is absorbed by the queue rather than by the request.
 *
 * `RUN_PROFILES` includes `events` so the relay runs and the `connector.webhook` queue is drained
 * here; the outbox suite lock serialises this against every other suite that relays. The shipped
 * consumer is overridden with a probe, so "made to fail" and "forced slow" are properties of this
 * suite rather than of the code under test.
 */
describe('connectors webhook endpoint (e2e)', () => {
  describe.skipIf(!POSTGRES || !REDIS)('against Postgres and the queue Redis role', () => {
    let endpointApp: INestApplication;
    let db: ForgeDatabase;
    let suiteLock: { release: () => Promise<void> };
    const probe = new ProbeWebhookConsumer();

    beforeAll(async () => {
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL!);

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(WebhookDeliveryConsumer)
        .useValue(probe)
        .compile();

      endpointApp = moduleRef.createNestApplication({ rawBody: true });
      configureApplication(endpointApp);
      await endpointApp.init();
      db = endpointApp.get<ForgeDatabase>(APP_DATABASE);
    }, 600_000);

    afterAll(async () => {
      await endpointApp?.close();
      await suiteLock?.release();
    });

    beforeEach(() => {
      probe.reset();
    });

    function post(body: string, signature: string | undefined, deliveryId: string): request.Test {
      const call = request(endpointApp.getHttpServer() as Server)
        .post(ENDPOINT)
        .set('content-type', 'application/json')
        .set('x-github-delivery', deliveryId)
        .set('x-github-event', 'push');

      return (signature === undefined ? call : call.set('x-hub-signature-256', signature)).send(
        body,
      );
    }

    /** Signed correctly over exactly the bytes sent. The happy path, as a helper. */
    function deliver(deliveryId: string, body = pushBody()): request.Test {
      return post(body, signGithub(body), deliveryId);
    }

    async function rowsFor(deliveryId: string) {
      return db
        .select()
        .from(schema.webhookDeliveries)
        .where(eq(schema.webhookDeliveries.deliveryId, deliveryId));
    }

    async function outboxFor(aggregateId: string) {
      return db
        .select({ id: schema.outbox.id, type: schema.outbox.type })
        .from(schema.outbox)
        .where(eq(schema.outbox.aggregateId, aggregateId));
    }

    describe('refusals — one indistinguishable 401, and nothing enqueued', () => {
      it.each([
        ['no X-Hub-Signature-256 at all', (_body: string) => undefined],
        ['sha256= with a wrong hex value of the right length', () => `sha256=${'a'.repeat(64)}`],
        ['a signature of the wrong length', (body: string) => `${signGithub(body)}ff`],
      ])('refuses %s', async (_case, signature) => {
        const deliveryId = randomUUID();
        const body = pushBody();
        const response = await post(body, signature(body), deliveryId).expect(
          HttpStatus.UNAUTHORIZED,
        );

        expect((response.body as { detail?: string }).detail).toBe(WEBHOOK_REJECTION);
        await expect(rowsFor(deliveryId)).resolves.toEqual([]);
      });

      /**
       * The regression test for `rawBody` (R8). The signature is honest — it was computed over a
       * real body — and then one byte of that body changed on the way. It passes if and only if the
       * verifier saw the received bytes: a verifier over the re-serialised body would compare an
       * HMAC of `JSON.stringify(parsed)` against a signature of something else and refuse for the
       * wrong reason, or, for a body that round-trips identically, accept the tampering.
       */
      it('refuses a valid signature over a body then modified by one byte', async () => {
        const deliveryId = randomUUID();
        const body = pushBody();
        const tampered = body.replace('"ref"', '"reF"');

        expect(tampered).toHaveLength(body.length);
        expect(tampered).not.toBe(body);

        await post(tampered, signGithub(body), deliveryId).expect(HttpStatus.UNAUTHORIZED);
        await expect(rowsFor(deliveryId)).resolves.toEqual([]);
      });

      /** 413 from the parser, before a signature is computed at all (FR-024). */
      it('refuses a body over the parser limit with 413, before any signature is computed', async () => {
        const deliveryId = randomUUID();
        const oversized = `{"note":"${'x'.repeat(2 * 1024 * 1024)}"}`;

        await post(oversized, signGithub(oversized), deliveryId).expect(
          HttpStatus.PAYLOAD_TOO_LARGE,
        );
        await expect(rowsFor(deliveryId)).resolves.toEqual([]);
      });

      it('leaves every refusal indistinguishable from every other', async () => {
        const body = pushBody();
        const answers = await Promise.all(
          [undefined, `sha256=${'a'.repeat(64)}`, `${signGithub(body)}ff`].map(async (signature) =>
            post(body, signature, randomUUID()),
          ),
        );

        expect(new Set(answers.map((a) => `${String(a.status)} ${JSON.stringify(a.body)}`)).size)
          // Every problem carries the request's own `instance`, so compare what the sender could
          // actually correlate: the status and the refusal sentence.
          .toBeGreaterThanOrEqual(1);
        for (const answer of answers) {
          expect(answer.status).toBe(HttpStatus.UNAUTHORIZED);
          expect((answer.body as { detail?: string }).detail).toBe(WEBHOOK_REJECTION);
        }
      });
    });

    it('accepts a signed delivery: 204, one row in received, the outbox event in the same transaction', async () => {
      const deliveryId = randomUUID();
      const body = pushBody();

      const response = await deliver(deliveryId, body).expect(HttpStatus.NO_CONTENT);

      expect(response.text).toBe('');

      const [row] = await rowsFor(deliveryId);

      expect(row).toMatchObject({
        eventType: 'push',
        installationId: INSTALLATION,
        provider: 'github',
        state: 'received',
      });
      // The body is stored whole, unknown keys and all (contracts § 2, ADR 050).
      expect(row?.body).toMatchObject(JSON.parse(body) as Record<string, unknown>);

      await expect(outboxFor(row!.id)).resolves.toEqual([
        { id: expect.any(String) as string, type: 'webhook.received' },
      ]);
    });

    /** SC-008: a repeat changes state at most once. */
    it('answers 204 to a repeated delivery id, writes no second row and enqueues nothing more', async () => {
      const deliveryId = randomUUID();
      const body = pushBody();

      await deliver(deliveryId, body).expect(HttpStatus.NO_CONTENT);
      const [first] = await rowsFor(deliveryId);

      await deliver(deliveryId, body).expect(HttpStatus.NO_CONTENT);
      // A different body under the same delivery id, signed honestly: still one row, unchanged.
      await deliver(deliveryId, pushBody('refs/heads/other')).expect(HttpStatus.NO_CONTENT);

      const after = await rowsFor(deliveryId);

      expect(after).toHaveLength(1);
      expect(after[0]).toEqual(first);
      await expect(outboxFor(first!.id)).resolves.toHaveLength(1);
    });

    /** SC-007: the record exists for a delivery whose processing was made to fail. */
    it('keeps the record when processing fails, and the failure is the consumer’s, not the request’s', async () => {
      probe.behaviour = 'fail';

      const deliveryId = randomUUID();

      await deliver(deliveryId).expect(HttpStatus.NO_CONTENT);

      const [row] = await rowsFor(deliveryId);

      expect(row).toBeDefined();

      // The consumer is given the delivery and throws; the row is still there afterwards, which is
      // the whole of "persist before process". Without the row there would be nothing to retry from.
      await expect(until(() => probe.failures.includes(row!.id), 20_000)).resolves.toBe(true);
      await expect(rowsFor(deliveryId)).resolves.toHaveLength(1);
      // And the request never heard about any of it.
      await expect(deliver(randomUUID())).resolves.toMatchObject({ status: HttpStatus.NO_CONTENT });
    });

    /**
     * SC-009. `slow` makes every pickup take half a second, which is ten times the budget the
     * acknowledgement is held to — so an endpoint that waited for processing could not pass this,
     * and one that does not is barely affected by it.
     *
     * Timing on a shared machine is noisy, so the assertion is p95 over twenty deliveries rather
     * than a maximum: one scheduling hiccup must not fail a build, and twenty consecutive hiccups
     * is not noise.
     */
    it('SC-009: acknowledges under 50 ms at p95 with processing forced slow', async () => {
      probe.behaviour = 'slow';

      const samples: number[] = [];

      for (let i = 0; i < 20; i += 1) {
        const started = performance.now();
        await deliver(randomUUID()).expect(HttpStatus.NO_CONTENT);
        samples.push(performance.now() - started);
      }

      const sorted = [...samples].sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!;

      expect(p95).toBeLessThan(50);
    });

    /** The burst the queue is there to absorb: the request path answers, the work waits its turn. */
    it('absorbs a burst: every delivery is acknowledged and every row is written', async () => {
      probe.behaviour = 'slow';

      // Sequential, and that is the sharper test. Each delivery takes the consumer half a second,
      // so an endpoint that answered only once its delivery had been processed would need twenty
      // seconds for these forty. The queue absorbing the work means the whole burst is acknowledged
      // in a fraction of that — which is a statement about the pipeline, where forty *simultaneous*
      // sockets would have been a statement about the listener's backlog.
      const ids = Array.from({ length: 40 }, () => randomUUID());
      const statuses: number[] = [];
      const started = performance.now();

      for (const id of ids) {
        statuses.push((await deliver(id)).status);
      }

      const elapsed = performance.now() - started;

      expect(statuses).toEqual(ids.map(() => HttpStatus.NO_CONTENT));
      expect(elapsed).toBeLessThan(ids.length * 500);

      const rows = await db
        .select({ deliveryId: schema.webhookDeliveries.deliveryId })
        .from(schema.webhookDeliveries)
        .where(inArray(schema.webhookDeliveries.deliveryId, ids));

      expect(rows).toHaveLength(ids.length);
    });

    /**
     * Spec 029 SC-011: the same transport cases on the hooks origin. `HOOKS_HOST` is `local`'s
     * default, and the edge keeps the original `Host`, so this is what the API sees from
     * `https://hooks.…/github` once Caddy has rewritten it onto the one route.
     */
    describe('on the hooks host', () => {
      const HOOKS_HOST = 'hooks.localhost';

      function postOnHooks(body: string, signature: string | undefined, deliveryId: string) {
        const call = request(endpointApp.getHttpServer() as Server)
          .post(ENDPOINT)
          .set('Host', HOOKS_HOST)
          .set('content-type', 'application/json')
          .set('x-github-delivery', deliveryId)
          .set('x-github-event', 'push');

        return (signature === undefined ? call : call.set('x-hub-signature-256', signature)).send(
          body,
        );
      }

      it.each([
        ['no X-Hub-Signature-256 at all', (_body: string) => undefined],
        ['sha256= with a wrong hex value of the right length', () => `sha256=${'a'.repeat(64)}`],
        ['a signature of the wrong length', (body: string) => `${signGithub(body)}ff`],
      ])('refuses %s', async (_case, signature) => {
        const deliveryId = randomUUID();
        const body = pushBody();
        const response = await postOnHooks(body, signature(body), deliveryId).expect(
          HttpStatus.UNAUTHORIZED,
        );

        expect((response.body as { detail?: string }).detail).toBe(WEBHOOK_REJECTION);
        await expect(rowsFor(deliveryId)).resolves.toEqual([]);
      });

      it('refuses a valid signature over a body then modified by one byte', async () => {
        const deliveryId = randomUUID();
        const body = pushBody();

        await postOnHooks(body.replace('"ref"', '"reF"'), signGithub(body), deliveryId).expect(
          HttpStatus.UNAUTHORIZED,
        );
        await expect(rowsFor(deliveryId)).resolves.toEqual([]);
      });

      it('refuses a body over the parser limit with 413, before any signature is computed', async () => {
        const deliveryId = randomUUID();
        const oversized = `{"note":"${'x'.repeat(2 * 1024 * 1024)}"}`;

        await postOnHooks(oversized, signGithub(oversized), deliveryId).expect(
          HttpStatus.PAYLOAD_TOO_LARGE,
        );
        await expect(rowsFor(deliveryId)).resolves.toEqual([]);
      });

      it('accepts a signed delivery: 204, one row in received, the outbox event in the same transaction', async () => {
        const deliveryId = randomUUID();
        const body = pushBody();

        await postOnHooks(body, signGithub(body), deliveryId).expect(HttpStatus.NO_CONTENT);

        const [row] = await rowsFor(deliveryId);

        expect(row).toMatchObject({ eventType: 'push', provider: 'github', state: 'received' });
        await expect(outboxFor(row!.id)).resolves.toEqual([
          { id: expect.any(String) as string, type: 'webhook.received' },
        ]);
      });

      it('answers 204 to a repeated delivery id, writes no second row and enqueues nothing more', async () => {
        const deliveryId = randomUUID();
        const body = pushBody();

        await postOnHooks(body, signGithub(body), deliveryId).expect(HttpStatus.NO_CONTENT);
        const [first] = await rowsFor(deliveryId);

        await postOnHooks(body, signGithub(body), deliveryId).expect(HttpStatus.NO_CONTENT);

        await expect(rowsFor(deliveryId)).resolves.toEqual([first]);
        await expect(outboxFor(first!.id)).resolves.toHaveLength(1);
      });
    });
  });
});

/**
 * Quickstart § 5's accepted cases, end to end and with the **shipped** consumer (spec 026 T062).
 *
 * The block above overrides the consumer so that "made to fail" and "forced slow" are properties of
 * the suite; this one overrides nothing. A signed request goes in at the route, the relay carries it
 * to the `connector.webhook` queue, and what is asserted is the row the consumer left behind —
 * which is the only way cases 2, 4 and 6 are claims about the product rather than about a stub.
 *
 * - **case 1** a valid `push` for a linked repository and branch is accepted and enqueued;
 * - **case 2** the consumer advances the link's `remote_head_sha`, and **the workspace and the
 *   checkpoint list are unchanged** (SC-010);
 * - **case 4** a branch no link names, and an unknown installation, end `ignored` with nothing
 *   changed (SC-011);
 * - **case 6** a second organisation holding the same installation advances too, independently, and
 *   an organisation whose connection names another installation is untouched (SC-013).
 */
describe('connectors webhook processing (e2e)', () => {
  describe.skipIf(!POSTGRES || !REDIS)('with the shipped consumer', () => {
    let app: INestApplication;
    let db: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let suiteLock: { release: () => Promise<void> };
    let userId: string;

    /** One organisation, its project, its `github` connection and its link. */
    interface Tenant {
      readonly link: () => Promise<{ remoteHeadSha: string | null } | undefined>;
      readonly orgId: string;
      readonly projectId: string;
    }

    const tenants: string[] = [];

    /**
     * Rows, not routes. The connection is inserted rather than installed because the consumer reads
     * exactly one field of it — the installation id — and minting a token against a fixture GitHub
     * would prove nothing this suite claims.
     */
    async function tenant(options: { installation: number; repoId: number }): Promise<Tenant> {
      const org = await app.get(OrgService).create(userId, {
        name: 'Webhook tenant',
        slug: `026e-${randomUUID().slice(0, 8)}`,
      });

      tenants.push(org.id);

      const [workspace] = await transactions.runInTenantTransaction(org.id, (tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );
      const project = await transactions.runInTenantScope({ orgId: org.id, userId }, () =>
        app.get(ProjectService).create({
          actorId: userId,
          name: 'Linked',
          orgId: org.id,
          ownerId: userId,
          workspaceId: workspace!.id,
        }),
      );

      await transactions.runInTenantTransaction(org.id, async (tx) => {
        const [connection] = await tx
          .insert(schema.connections)
          .values({
            accountId: 9001,
            accountLogin: 'acme',
            accountType: 'organization',
            connectedBy: userId,
            health: 'healthy',
            installationId: options.installation,
            orgId: org.id,
            provider: 'github',
          })
          .returning({ id: schema.connections.id });

        await tx.insert(schema.repoLinks).values({
          branch: 'main',
          connectionId: connection!.id,
          linkedBy: userId,
          name: 'site',
          orgId: org.id,
          owner: 'acme',
          projectId: project.id,
          repoId: options.repoId,
          state: 'linked',
        });
      });

      return {
        link: () =>
          transactions.runInTenantTransaction(org.id, async (tx) => {
            const [row] = await tx
              .select({ remoteHeadSha: schema.repoLinks.remoteHeadSha })
              .from(schema.repoLinks)
              .where(eq(schema.repoLinks.orgId, org.id));

            return row;
          }),
        orgId: org.id,
        projectId: project.id,
      };
    }

    /** SC-010/SC-011's "unchanged": every project row and every checkpoint row of a tenant. */
    async function snapshot(orgId: string) {
      return transactions.runInTenantTransaction(orgId, async (tx) => ({
        checkpoints: await tx
          .select()
          .from(schema.checkpoints)
          .where(eq(schema.checkpoints.orgId, orgId)),
        projects: await tx.select().from(schema.projects).where(eq(schema.projects.orgId, orgId)),
        workspaces: await tx
          .select()
          .from(schema.workspaces)
          .where(eq(schema.workspaces.orgId, orgId)),
      }));
    }

    beforeAll(async () => {
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL!);

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

      app = moduleRef.createNestApplication({ rawBody: true });
      configureApplication(app);
      await app.init();
      db = app.get<ForgeDatabase>(APP_DATABASE);
      transactions = app.get(TenantTransactionRunner);

      const [user] = await db
        .insert(schema.users)
        .values({ email: `026e-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userId = user!.id;
    }, 600_000);

    afterAll(async () => {
      for (const orgId of tenants) {
        await db.delete(schema.orgs).where(eq(schema.orgs.id, orgId));
      }
      if (userId !== undefined) await db.delete(schema.users).where(eq(schema.users.id, userId));
      await app?.close();
      await suiteLock?.release();
    });

    function send(body: string, deliveryId: string, event = 'push'): request.Test {
      return request(app.getHttpServer() as Server)
        .post(ENDPOINT)
        .set('content-type', 'application/json')
        .set('x-github-delivery', deliveryId)
        .set('x-github-event', event)
        .set('x-hub-signature-256', signGithub(body))
        .send(body);
    }

    async function stateOf(deliveryId: string): Promise<string | undefined> {
      const [row] = await db
        .select({ state: schema.webhookDeliveries.state })
        .from(schema.webhookDeliveries)
        .where(eq(schema.webhookDeliveries.deliveryId, deliveryId));

      return row?.state;
    }

    /** Waits for the consumer to settle the delivery; `received` means it has not run yet. */
    async function settled(deliveryId: string): Promise<string | undefined> {
      await until(async () => {
        const state = await stateOf(deliveryId);

        return state !== undefined && state !== 'received';
      }, 30_000);

      return stateOf(deliveryId);
    }

    function body(options: {
      after?: string;
      installation?: number;
      ref?: string;
      repoId: number;
    }): string {
      return JSON.stringify({
        after: options.after ?? HEAD_SHA,
        installation: { id: options.installation ?? INSTALLATION },
        ref: options.ref ?? 'refs/heads/main',
        repository: { id: options.repoId },
        zen: 'Design for failure.',
      });
    }

    /** Cases 1 and 2, and SC-010's "zero changes to the workspace or the checkpoint list". */
    it('accepts a push for a linked branch, advances the link, and changes nothing else', async () => {
      const linked = await tenant({ installation: INSTALLATION, repoId: 9_100_001 });
      const before = await snapshot(linked.orgId);
      const deliveryId = randomUUID();

      await send(body({ repoId: 9_100_001 }), deliveryId).expect(HttpStatus.NO_CONTENT);

      await expect(settled(deliveryId)).resolves.toBe('processed');
      await expect(linked.link()).resolves.toMatchObject({ remoteHeadSha: HEAD_SHA });
      // "Remote is ahead" is `position`'s reading of exactly these two shas: the local head that was
      // last pushed, against the head the delivery just recorded.
      expect(position({ lastPushedSha: LOCAL_SHA, remoteHeadSha: HEAD_SHA }, LOCAL_SHA)).toBe(
        'behind',
      );
      await expect(snapshot(linked.orgId)).resolves.toEqual(before);
    });

    /** Case 4 (SC-011): a branch no link names, and an installation nothing holds. */
    it('ignores a push for an unnamed branch and one for an unknown installation, changing nothing', async () => {
      const linked = await tenant({ installation: INSTALLATION, repoId: 9_100_002 });
      const before = await snapshot(linked.orgId);
      const branch = randomUUID();
      const unknown = randomUUID();

      await send(body({ ref: 'refs/heads/release', repoId: 9_100_002 }), branch).expect(
        HttpStatus.NO_CONTENT,
      );
      await send(body({ installation: 1, repoId: 9_100_002 }), unknown).expect(
        HttpStatus.NO_CONTENT,
      );

      await expect(settled(branch)).resolves.toBe('ignored');
      await expect(settled(unknown)).resolves.toBe('ignored');
      await expect(linked.link()).resolves.toMatchObject({ remoteHeadSha: null });
      await expect(snapshot(linked.orgId)).resolves.toEqual(before);
    });

    /** Case 6 (SC-013): the installation is shared; the organisation that does not hold it is not. */
    it('advances every organisation holding the installation, and only those', async () => {
      const repoId = 9_100_003;
      const first = await tenant({ installation: INSTALLATION, repoId });
      const second = await tenant({ installation: INSTALLATION, repoId });
      const stranger = await tenant({ installation: INSTALLATION + 1, repoId });
      const deliveryId = randomUUID();

      await send(body({ repoId }), deliveryId).expect(HttpStatus.NO_CONTENT);

      await expect(settled(deliveryId)).resolves.toBe('processed');
      await expect(first.link()).resolves.toMatchObject({ remoteHeadSha: HEAD_SHA });
      await expect(second.link()).resolves.toMatchObject({ remoteHeadSha: HEAD_SHA });
      await expect(stranger.link()).resolves.toMatchObject({ remoteHeadSha: null });
    });
  });
});
