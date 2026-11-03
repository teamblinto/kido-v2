import { HttpStatus, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLOCK } from '../../../common/clock/clock.port';
import { ProblemDetailsFilter } from '../../../common/errors/problem-details.filter';
import { APP_DATABASE } from '../../../database/database.constants';
import type { TenantTransaction } from '../../../database/database.types';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { GithubWebhookGuard, WEBHOOK_REJECTION } from './verifiers/github.verifier';
import { WebhookController, webhookEnvelopeSchema } from './webhook.controller';
import { type NewDelivery, WebhookDeliveryRepository } from './inbound-delivery.repository';

const SECRET = 'the-apps-webhook-secret';
const NOW = new Date('2026-09-22T11:00:00.000Z');
const ROW_ID = '9f1d4c22-3f0e-4c66-9f93-2c0b7d9f5a31';

const PUSH = JSON.stringify({
  after: '9a7c2d1e5b3f4086a2c1d0e9f8b7a6c5d4e3f201',
  installation: { id: 42_000_123 },
  ref: 'refs/heads/main',
  repository: { id: 8_800_001, name: 'shop' },
  // A key the contract does not name, which is the point of § 2: it rides along and is stored.
  zen: 'Non-blocking is better than blocking.',
});

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;
}

/**
 * `WebhookController` through the real HTTP stack (spec 026 T048, contracts/webhook.md § 1 and § 4).
 *
 * The repository and the outbox writer are doubles; what is under test is the controller's
 * contract, which is four sentences:
 *
 * - a verified delivery is persisted and enqueued **in one transaction**, and answers `204`;
 * - a duplicate delivery id answers the same `204`, writes nothing and enqueues **nothing**;
 * - a refusal is one `401` RFC 9457 problem with no detail about which check failed;
 * - the body is read with a permissive schema, so an unknown key is stored rather than refused.
 *
 * The transaction double runs the callback and records whether it was one call, because "the row
 * and the event commit together" is the guarantee the provider's retry safety rests on — and a
 * controller that wrote them in two transactions would pass every other assertion here.
 */
describe('WebhookController', () => {
  let app: INestApplication;
  let insertIfNew: ReturnType<typeof vi.fn>;
  let append: ReturnType<typeof vi.fn>;
  let transactions: number;

  beforeEach(async () => {
    transactions = 0;
    insertIfNew = vi.fn<
      (tx: TenantTransaction, delivery: NewDelivery) => Promise<string | undefined>
    >(() => Promise.resolve(ROW_ID));
    append = vi.fn(() => Promise.resolve({ eventId: 'e' }));

    const db = {
      transaction: async <T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> => {
        transactions += 1;

        return fn({} as TenantTransaction);
      },
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        { provide: APP_DATABASE, useValue: db },
        { provide: WebhookDeliveryRepository, useValue: { insertIfNew } },
        { provide: OutboxWriter, useValue: { append } },
        { provide: CLOCK, useValue: { now: () => NOW } },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        GithubWebhookGuard,
        { provide: ConfigService, useValue: { get: () => SECRET } },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  function post(body: string, signature = sign(body)): request.Test {
    return request(app.getHttpServer() as Server)
      .post('/webhooks/github')
      .set('content-type', 'application/json')
      .set('x-github-delivery', 'd-1')
      .set('x-github-event', 'push')
      .set('x-hub-signature-256', signature)
      .send(body);
  }

  it('answers 204 with no body when the delivery is accepted', async () => {
    const response = await post(PUSH).expect(HttpStatus.NO_CONTENT);

    expect(response.text).toBe('');
    expect(response.body).toEqual({});
  });

  it('persists the delivery with the whole body, unknown keys and all', async () => {
    await post(PUSH).expect(HttpStatus.NO_CONTENT);

    expect(insertIfNew).toHaveBeenCalledTimes(1);

    const [, delivery] = insertIfNew.mock.calls[0] as [unknown, NewDelivery];

    expect(delivery).toEqual({
      body: JSON.parse(PUSH) as Record<string, unknown>,
      deliveryId: 'd-1',
      eventType: 'push',
      installationId: 42_000_123,
      receivedAt: NOW,
    });
    // The clock is injected, never `now()` — the row's `received_at` is this application's clock.
    expect(delivery.receivedAt).toBe(NOW);
  });

  it('writes the row and the outbox event on one transaction', async () => {
    await post(PUSH).expect(HttpStatus.NO_CONTENT);

    expect(transactions).toBe(1);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[1]).toEqual({
      aggregateId: ROW_ID,
      payload: { deliveryId: ROW_ID },
      type: 'webhook.received',
    });
    // The event carries an id and nothing else: the payload is the row, and the row is where the
    // retention sweep can reach it.
    expect(JSON.stringify(append.mock.calls[0]?.[1])).not.toContain('refs/heads/main');
  });

  it('answers 204 for a duplicate delivery id and enqueues nothing', async () => {
    // Zero rows from `ON CONFLICT DO NOTHING`: the provider is retrying something already held.
    insertIfNew.mockResolvedValue(undefined);

    const response = await post(PUSH).expect(HttpStatus.NO_CONTENT);

    expect(response.text).toBe('');
    expect(insertIfNew).toHaveBeenCalledTimes(1);
    expect(append).not.toHaveBeenCalled();
    // Still exactly one transaction: the conflict is an answer, not an error path.
    expect(transactions).toBe(1);
  });

  it('answers a duplicate indistinguishably from an acceptance', async () => {
    const accepted = await post(PUSH);
    insertIfNew.mockResolvedValue(undefined);
    const duplicate = await post(PUSH);

    expect(duplicate.status).toBe(accepted.status);
    expect(duplicate.text).toBe(accepted.text);
    // Nothing on the wire tells a caller whether this delivery id has been seen before — the two
    // answers have to be the same answer, headers that vary by request excepted.
    expect(duplicate.headers['content-type']).toBe(accepted.headers['content-type']);
  });

  it.each([
    ['a wrong signature', `sha256=${'a'.repeat(64)}`],
    ['a signature of the wrong length', `${sign(PUSH)}ff`],
    ['no prefix', sign(PUSH).slice('sha256='.length)],
    ['a signature from another secret', sign(PUSH, 'not-it')],
  ])('refuses %s with one 401 problem carrying no detail of the cause', async (_case, header) => {
    const response = await post(PUSH, header).expect(HttpStatus.UNAUTHORIZED);
    const problem = response.body as Record<string, unknown>;

    expect(problem.status).toBe(401);
    expect(problem.type).toContain('unauthorized');
    expect(problem.detail).toBe(WEBHOOK_REJECTION);
    // Not "wrong length", not "no prefix": the sender learns nothing about how close they got.
    expect(JSON.stringify(problem)).not.toMatch(/length|prefix|secret|hmac/i);
    expect(insertIfNew).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('refuses an absent signature before anything reaches the database', async () => {
    await request(app.getHttpServer() as Server)
      .post('/webhooks/github')
      .set('content-type', 'application/json')
      .set('x-github-delivery', 'd-1')
      .set('x-github-event', 'push')
      .send(PUSH)
      .expect(HttpStatus.UNAUTHORIZED);

    expect(transactions).toBe(0);
  });

  it('persists a body with none of the four fields rather than refusing it', async () => {
    // "A delivery missing any of them is persisted and marked `ignored`, never refused" — a refusal
    // would tell GitHub the endpoint is broken when the truth is that this is not an event we act on.
    const unrelated = JSON.stringify({ action: 'created', member: { login: 'someone' } });

    await post(unrelated).expect(HttpStatus.NO_CONTENT);

    const [, delivery] = insertIfNew.mock.calls[0] as [unknown, NewDelivery];

    expect(delivery.installationId).toBeNull();
    expect(delivery.body).toEqual(JSON.parse(unrelated));
    expect(append).toHaveBeenCalledTimes(1);
  });

  it('persists a body that is not an object at all', async () => {
    await post('[1,2,3]').expect(HttpStatus.NO_CONTENT);

    const [, delivery] = insertIfNew.mock.calls[0] as [unknown, NewDelivery];

    expect(delivery.body).toEqual({});
    expect(delivery.installationId).toBeNull();
  });

  describe('the envelope schema', () => {
    it('is permissive, so an undeclared key parses rather than refusing the delivery', () => {
      const parsed = webhookEnvelopeSchema.safeParse({ ref: 'refs/heads/main', zen: 'anything' });

      expect(parsed.success).toBe(true);
      // Strict would make every field GitHub adds a 422 — the failure mode ADR 050 exists to avoid.
      expect(parsed.data).toEqual({ ref: 'refs/heads/main' });
    });

    it('treats every field as optional', () => {
      expect(webhookEnvelopeSchema.safeParse({}).success).toBe(true);
    });

    it('still refuses a field of the wrong type, which is a body we could not act on', () => {
      expect(webhookEnvelopeSchema.safeParse({ installation: { id: 'forty-two' } }).success).toBe(
        false,
      );
    });
  });
});
