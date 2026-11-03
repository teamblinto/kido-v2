import { describe, expect, it, vi } from 'vitest';

import type { MailDelivery, MailMessage } from './mailer.port';
import { RESEND_ENDPOINT, type ResendFetch, ResendMailer } from './resend.mailer';
import { verificationMail } from './templates';

const API_KEY = 're_2vQx8LmT_9pKdZa4WsYb7NcRf1HgUj6E';
const FROM = 'Forge <noreply@forge.dev>';
const TOKEN = 'PJmOx0m9k-2wQ7bYt1RfZs3aLdN6uVcH';

const MESSAGE: MailMessage = verificationMail({
  appUrl: 'https://app.forge.dev',
  expiresInMinutes: 1_440,
  to: 'someone@example.com',
  token: TOKEN,
});

/** Everything a vendor could put in a 4xx body that §05 says must not reach us or our logs. */
const VENDOR_BODY = {
  message: `Invalid \`to\` field: someone@example.com is suppressed. Original request: ${TOKEN}`,
  name: 'validation_error',
};

function answering(
  status: number,
  body: unknown = VENDOR_BODY,
): { calls: Parameters<ResendFetch>[]; mailer: ResendMailer } {
  const calls: Parameters<ResendFetch>[] = [];
  const fetch: ResendFetch = (url, init) => {
    calls.push([url, init]);

    return Promise.resolve({
      json: () => Promise.resolve(body),
      ok: status >= 200 && status < 300,
      status,
    });
  };

  return { calls, mailer: new ResendMailer({ apiKey: API_KEY, fetch, from: FROM }) };
}

/** A transport that rejects, which is how `fetch` reports a refused connection or a timeout. */
function rejecting(error: Error): ResendMailer {
  return new ResendMailer({
    apiKey: API_KEY,
    fetch: () => Promise.reject(error),
    from: FROM,
  });
}

/** A transport that throws before it ever returns a promise, with a value that is not an `Error`. */
function throwingSync(value: unknown): ResendMailer {
  return new ResendMailer({
    apiKey: API_KEY,
    fetch: () => {
      throw value;
    },
    from: FROM,
  });
}

function rendered(delivery: MailDelivery): string {
  return JSON.stringify(delivery);
}

/**
 * The one request the adapter made. Throws rather than returning `undefined` so a send that never
 * reached the transport fails as itself, instead of as a member access on nothing.
 */
function onlyCall(calls: readonly Parameters<ResendFetch>[]): Parameters<ResendFetch> {
  const [call, ...rest] = calls;

  if (call === undefined || rest.length > 0) {
    throw new Error(`expected exactly one request, got ${calls.length}`);
  }

  return call;
}

/** The JSON the adapter posted, as something a `toMatchObject` can be pointed at. */
function sentBody(calls: readonly Parameters<ResendFetch>[]): unknown {
  return JSON.parse(onlyCall(calls)[1].body);
}

describe('ResendMailer.send on success', () => {
  it('posts the message to the emails endpoint', async () => {
    const { calls, mailer } = answering(200, { id: 're_9aB3' });

    await mailer.send(MESSAGE);

    const [url, init] = onlyCall(calls);

    expect(url).toBe(RESEND_ENDPOINT);
    expect(init.method).toBe('POST');
  });

  it('returns the provider message id, for the audit trail', async () => {
    const { mailer } = answering(200, { id: 're_9aB3' });

    expect(await mailer.send(MESSAGE)).toEqual({
      outcome: 'sent',
      providerMessageId: 're_9aB3',
    });
  });

  it('reports the send without an id when the response carries none', async () => {
    const { mailer } = answering(200, {});

    expect(await mailer.send(MESSAGE)).toEqual({ outcome: 'sent', providerMessageId: undefined });
  });

  it('treats an unreadable success body as a success, because the mail did go out', async () => {
    const mailer = new ResendMailer({
      apiKey: API_KEY,
      fetch: () =>
        Promise.resolve({
          json: () => Promise.reject(new Error('not json')),
          ok: true,
          status: 200,
        }),
      from: FROM,
    });

    expect((await mailer.send(MESSAGE)).outcome).toBe('sent');
  });

  it('sends the configured sender, not one the caller chose', async () => {
    const { calls, mailer } = answering(200, { id: 're_9aB3' });

    await mailer.send(MESSAGE);

    expect(sentBody(calls)).toMatchObject({ from: FROM });
  });

  it('sends both body parts and the subject', async () => {
    const { calls, mailer } = answering(200, { id: 're_9aB3' });

    await mailer.send(MESSAGE);

    expect(sentBody(calls)).toMatchObject({
      html: MESSAGE.html,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      to: MESSAGE.to,
    });
  });

  /** A bearer credential in a query string is written to every proxy access log on the way. */
  it('carries the api key in the authorization header and nowhere else', async () => {
    const { calls, mailer } = answering(200, { id: 're_9aB3' });

    await mailer.send(MESSAGE);

    const [url, init] = onlyCall(calls);

    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(url).not.toContain(API_KEY);
    expect(init.body).not.toContain(API_KEY);
  });

  it('bounds the request, so a hanging provider does not hold the signup open', async () => {
    const { calls, mailer } = answering(200, { id: 're_9aB3' });

    await mailer.send(MESSAGE);

    expect(onlyCall(calls)[1].signal).toBeInstanceOf(AbortSignal);
  });
});

/**
 * §10: "classify before retrying — a 4xx from a connector, a validation error or a permission
 * denial is terminal. Only timeouts, 5xx and 429 are retried."
 */
describe('ResendMailer.send failure classification', () => {
  it.each([
    [429, 'throttled', true],
    [500, 'unavailable', true],
    [502, 'unavailable', true],
    [503, 'unavailable', true],
    [504, 'unavailable', true],
    [401, 'not-configured', false],
    [403, 'not-configured', false],
    [422, 'invalid-recipient', false],
    [400, 'rejected', false],
    [404, 'rejected', false],
    [409, 'rejected', false],
  ] as const)('reports %i as %s', async (status, reason, retryable) => {
    const { mailer } = answering(status);
    const delivery = await mailer.send(MESSAGE);

    expect(delivery).toMatchObject({
      failure: { reason, retryable, status },
      outcome: 'failed',
    });
  });

  it.each([
    ['a refused connection', new TypeError('fetch failed')],
    ['an abort', Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })],
  ])('reports %s as unavailable with no status', async (_label, thrown) => {
    const delivery = await rejecting(thrown).send(MESSAGE);

    expect(delivery).toMatchObject({
      failure: { reason: 'unavailable', retryable: true, status: undefined },
      outcome: 'failed',
    });
  });

  /** Nothing guarantees a transport rejects with an `Error`, and a `catch` that assumed one throws. */
  it('reports a transport that throws a value that is not an error the same way', async () => {
    const delivery = await throwingSync('something went wrong').send(MESSAGE);

    expect(delivery).toMatchObject({
      failure: { reason: 'unavailable', retryable: true, status: undefined },
      outcome: 'failed',
    });
  });

  /**
   * The decision this port exists to make safe (ADR 004): a mail failure must not roll back the
   * account creation it accompanies. It cannot, if it never reaches a `catch` at all.
   */
  it.each([400, 401, 422, 429, 500, 503])(
    'resolves rather than rejecting on %i',
    async (status) => {
      const { mailer } = answering(status);

      await expect(mailer.send(MESSAGE)).resolves.toMatchObject({ outcome: 'failed' });
    },
  );

  it('resolves rather than rejecting when the transport throws', async () => {
    await expect(rejecting(new TypeError('fetch failed')).send(MESSAGE)).resolves.toMatchObject({
      outcome: 'failed',
    });
  });
});

/**
 * §05: "provider errors are classified and re-stated rather than passed through. A provider's error
 * body frequently echoes part of the request — which here means the user's source code, their
 * prompt, and occasionally a header — so forwarding it verbatim into our UI, our logs and our error
 * tracker moves tenant content into three systems that were never scoped to hold it."
 */
describe('ResendMailer.send re-states the vendor rather than forwarding it', () => {
  it('never puts the vendor message in the failure', async () => {
    const { mailer } = answering(422);

    expect(rendered(await mailer.send(MESSAGE))).not.toContain(VENDOR_BODY.message);
  });

  it('never puts the vendor error name in the failure', async () => {
    const { mailer } = answering(422);

    expect(rendered(await mailer.send(MESSAGE))).not.toContain(VENDOR_BODY.name);
  });

  it('never puts the token echoed back by the vendor in the failure', async () => {
    const { mailer } = answering(422);

    expect(rendered(await mailer.send(MESSAGE))).not.toContain(TOKEN);
  });

  it('never puts the api key in the failure', async () => {
    const { mailer } = answering(401);

    expect(rendered(await mailer.send(MESSAGE))).not.toContain(API_KEY);
  });

  it('never puts the recipient in the failure, which is the caller’s to log or not', async () => {
    const { mailer } = answering(422);

    expect(rendered(await mailer.send(MESSAGE))).not.toContain(MESSAGE.to);
  });

  it('never puts the message body or its link in the failure', async () => {
    const { mailer } = answering(500);
    const delivery = rendered(await mailer.send(MESSAGE));

    expect(delivery).not.toContain('/auth/verify');
    expect(delivery).not.toContain(MESSAGE.subject);
  });

  it('does not read the body of a failed response at all', async () => {
    const json = vi.fn(() => Promise.resolve(VENDOR_BODY));
    const mailer = new ResendMailer({
      apiKey: API_KEY,
      fetch: () => Promise.resolve({ json, ok: false, status: 422 }),
      from: FROM,
    });

    await mailer.send(MESSAGE);

    expect(json).not.toHaveBeenCalled();
  });

  it('says enough for an operator to act, without any of that', async () => {
    const { mailer } = answering(401);
    const delivery = await mailer.send(MESSAGE);

    expect(delivery.outcome).toBe('failed');
    expect(delivery.outcome === 'failed' && delivery.failure.detail).toMatch(/401/);
  });

  it('never puts the thrown transport error message in the failure', async () => {
    const delivery = await rejecting(new TypeError(`connect ECONNREFUSED ${API_KEY}`)).send(
      MESSAGE,
    );

    expect(rendered(delivery)).not.toContain(API_KEY);
    expect(rendered(delivery)).not.toContain('ECONNREFUSED');
  });
});
