import type { ExecutionContext } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DomainError } from '../../../../common/errors/domain-error';
import {
  GITHUB_WEBHOOK_DELIVERY,
  type GithubWebhookDelivery,
  GithubWebhookGuard,
  WEBHOOK_REJECTION,
} from './github.verifier';

const SECRET = 'the-apps-webhook-secret';
const WIRE = '{\n  "zen" : "Design for failure." ,\n  "after" : "a1b2c3"\n}\n';

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;
}

interface ProbeRequest {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Buffer;
}

/** A request whose parsed body deliberately differs, byte for byte, from what arrived. */
function requestOf(overrides: Partial<ProbeRequest> = {}): ProbeRequest {
  return {
    body: JSON.parse(WIRE) as unknown,
    headers: {
      'x-github-delivery': '0e3a5b90-6b1e-4f5a-8f1c-3c9a6f2d4b77',
      'x-github-event': 'push',
      'x-hub-signature-256': sign(WIRE),
    },
    rawBody: Buffer.from(WIRE, 'utf8'),
    ...overrides,
  };
}

function contextOf(request: ProbeRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/**
 * `GithubWebhookGuard` (spec 026 T051, contracts/webhook.md § 1 and § 3).
 *
 * Two properties, and they are the whole of the guard:
 *
 * 1. **It verifies the bytes that arrived.** `request.rawBody`, never `request.body`. A guard that
 *    re-serialises the parsed body computes an HMAC over something the sender never signed, and the
 *    failure is silent: every delivery is refused, or — worse — the subset that round-trips
 *    identically is accepted and the rest is not. The probe request here is built so the two differ.
 * 2. **Every refusal is the same refusal.** Absent, malformed, wrong length, wrong value, wrong
 *    secret, no delivery id, no event name: one `401` carrying one sentence. Which check failed is
 *    a measure of how close a forgery got.
 *
 * It is module-scoped (`@UseGuards` on the controller), never an `APP_GUARD` — the precedent
 * `SandboxCallbackGuard` set. The guard chain every other route rides is untouched by this feature,
 * and `connectors.module.spec.ts` is where that is asserted.
 */
describe('GithubWebhookGuard', () => {
  let guard: GithubWebhookGuard;

  beforeEach(() => {
    guard = new GithubWebhookGuard({ get: () => SECRET } as never);
  });

  function refusal(request: ProbeRequest): DomainError {
    try {
      guard.canActivate(contextOf(request));
    } catch (error) {
      return error as DomainError;
    }

    throw new Error('the guard admitted a request it should have refused');
  }

  it('admits a delivery signed over the bytes that arrived', () => {
    const request = requestOf();

    expect(guard.canActivate(contextOf(request))).toBe(true);
  });

  it('leaves the delivery id and event name on the request for the controller', () => {
    const request = requestOf();
    guard.canActivate(contextOf(request));

    const delivery = (request as unknown as Record<PropertyKey, GithubWebhookDelivery>)[
      GITHUB_WEBHOOK_DELIVERY
    ];

    expect(delivery).toEqual({
      deliveryId: '0e3a5b90-6b1e-4f5a-8f1c-3c9a6f2d4b77',
      eventType: 'push',
    });
  });

  it('verifies the raw bytes and not the re-serialised body', () => {
    const request = requestOf();

    // The trap research R8 describes, stated as an assertion so the probe cannot stop being a probe.
    expect(JSON.stringify(request.body)).not.toBe(WIRE);
    // Signed over the re-serialisation: the sender did not send those bytes, so this is a forgery.
    expect(() =>
      guard.canActivate(
        contextOf(requestOf({ headers: headersWith(sign(JSON.stringify(requestOf().body))) })),
      ),
    ).toThrow(DomainError);
    // And the honest signature still passes, which is what proves the guard read `rawBody`.
    expect(guard.canActivate(contextOf(request))).toBe(true);
  });

  it('refuses a body changed by one byte after it was signed', () => {
    const tampered = WIRE.replace('a1b2c3', 'a1b2c4');

    expect(tampered).not.toBe(WIRE);
    expect(tampered).toHaveLength(WIRE.length);

    expect(() =>
      guard.canActivate(contextOf(requestOf({ rawBody: Buffer.from(tampered, 'utf8') }))),
    ).toThrow(DomainError);
  });

  it.each([
    ['no signature header', requestOf({ headers: headersWith(undefined) })],
    ['an empty signature header', requestOf({ headers: headersWith('') })],
    ['a signature with no prefix', requestOf({ headers: headersWith(sign(WIRE).slice(7)) })],
    ['a signature of the wrong length', requestOf({ headers: headersWith(`${sign(WIRE)}ff`) })],
    [
      'a right-length signature with a wrong value',
      requestOf({ headers: headersWith(`sha256=${'a'.repeat(64)}`) }),
    ],
    ['a signature from another secret', requestOf({ headers: headersWith(sign(WIRE, 'not-it')) })],
    ['a repeated header', requestOf({ headers: headersWith([sign(WIRE), sign(WIRE)]) })],
    ['no raw body at all', requestOf({ rawBody: undefined })],
    [
      'no delivery id',
      requestOf({ headers: { ...headersWith(sign(WIRE)), 'x-github-delivery': undefined } }),
    ],
    [
      'no event name',
      requestOf({ headers: { ...headersWith(sign(WIRE)), 'x-github-event': undefined } }),
    ],
  ])('refuses %s with one indistinguishable 401', (_case, request) => {
    const error = refusal(request);

    expect(error).toBeInstanceOf(DomainError);
    expect(error.type).toBe('unauthorized');
    expect(error.status).toBe(401);
    // One sentence for every cause, and nothing in it names the cause. A refusal that said
    // "wrong length" would hand a forger the one thing they cannot otherwise measure.
    expect(error.detail).toBe(WEBHOOK_REJECTION);
    expect(error.extensions).toEqual({});
  });

  it('gives every refusal the identical message, header to header', () => {
    const messages = new Set(
      [
        requestOf({ headers: headersWith(undefined) }),
        requestOf({ headers: headersWith(`sha256=${'a'.repeat(64)}`) }),
        requestOf({ headers: headersWith(`${sign(WIRE)}ff`) }),
        requestOf({ rawBody: undefined }),
      ].map((request) => JSON.stringify(refusal(request))),
    );

    expect(messages.size).toBe(1);
  });

  it('never reads the parsed body', () => {
    // A getter that fails the test if anything touches it: the parsed body is data the guard has
    // no business in, because nothing has yet proved where it came from.
    const touched = vi.fn();
    const request = requestOf();
    Object.defineProperty(request, 'body', {
      get: () => {
        touched();

        return {};
      },
    });

    expect(guard.canActivate(contextOf(request))).toBe(true);
    expect(touched).not.toHaveBeenCalled();
  });

  it('refuses everything when the configured secret is empty', () => {
    const empty = new GithubWebhookGuard({ get: () => '' } as never);

    expect(() =>
      empty.canActivate(contextOf(requestOf({ headers: headersWith(sign(WIRE, '')) }))),
    ).toThrow(DomainError);
  });
});

function headersWith(
  signature: string | string[] | undefined,
): Record<string, string | string[] | undefined> {
  return {
    'x-github-delivery': '0e3a5b90-6b1e-4f5a-8f1c-3c9a6f2d4b77',
    'x-github-event': 'push',
    'x-hub-signature-256': signature,
  };
}
