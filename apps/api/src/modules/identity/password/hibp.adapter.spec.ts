import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import { breachCountIn, HIBP_RANGE_URL, HibpAdapter } from './hibp.adapter';

/**
 * A range response in the exact wire format the service returns — uppercase 35-character suffix,
 * a colon, a decimal count, one entry per line — trimmed to the handful of entries these tests
 * need. It is stored with LF because the repository is LF-only (`.gitattributes`); the real service
 * sends CRLF, which the CRLF case below reconstructs rather than trusting git to preserve.
 *
 * The counts of `0` are not corruption: they are the padding entries the service adds when asked
 * for them, so that response *size* does not leak how many real entries a prefix has. Treating one
 * as a hit would tell a user their password was breached when it was not.
 */
const RANGE_BODY = readFileSync(
  // Vitest runs from `apps/api`, the convention `no-plain-set.spec.ts` already relies on.
  join(process.cwd(), 'src/modules/identity/password/hibp-range-5baa6.fixture.txt'),
  'utf8',
);

/** SHA-1('password') = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8 — the canonical worked example. */
const BREACHED_SUFFIX = '1E4C9B93F3F0682250B6CF8331B7EE68FD8';
const PADDING_SUFFIX = '1E7A0C4B8D2F6A9E3B5C7D1F8A0B2C4D6E8';
const UNLISTED_SUFFIX = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';

describe('breachCountIn', () => {
  it('finds a listed suffix in a captured range response', () => {
    expect(breachCountIn(RANGE_BODY, BREACHED_SUFFIX)).toBe(10_437_277);
  });

  it('reads a response sent with CRLF, which is what the service actually sends', () => {
    expect(breachCountIn(RANGE_BODY.replaceAll('\n', '\r\n'), BREACHED_SUFFIX)).toBe(10_437_277);
  });

  it('matches the suffix case-insensitively', () => {
    expect(breachCountIn(RANGE_BODY.toLowerCase(), BREACHED_SUFFIX)).toBe(10_437_277);
    expect(breachCountIn(RANGE_BODY, BREACHED_SUFFIX.toLowerCase())).toBe(10_437_277);
  });

  it('returns zero for a suffix the response does not list', () => {
    expect(breachCountIn(RANGE_BODY, UNLISTED_SUFFIX)).toBe(0);
  });

  /**
   * The padding entries are indistinguishable from real ones except for the count, so this is the
   * one parsing detail that decides whether a correct implementation and a wrong one both "work".
   */
  it('treats a zero-count padding entry as not listed', () => {
    expect(breachCountIn(RANGE_BODY, PADDING_SUFFIX)).toBe(0);
  });

  it.each([
    ['an empty body', ''],
    ['blank lines and trailing whitespace', '\n\n   \n'],
    ['a line with no count', `${BREACHED_SUFFIX}\n`],
    ['a non-numeric count', `${BREACHED_SUFFIX}:many\n`],
    ['an HTML error page', '<html><body>502 Bad Gateway</body></html>'],
  ])('reads %s as "not listed" rather than throwing', (_name, body) => {
    expect(breachCountIn(body, BREACHED_SUFFIX)).toBe(0);
  });

  it('ignores surrounding whitespace on an otherwise good line', () => {
    expect(breachCountIn(`  ${BREACHED_SUFFIX}:42  `, BREACHED_SUFFIX)).toBe(42);
  });
});

describe('HibpAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function adapter(enabled = true): HibpAdapter {
    return new HibpAdapter({
      get: () => enabled,
    } as unknown as ConfigService<Environment, true>);
  }

  function stubFetch(implementation: typeof fetch): ReturnType<typeof vi.fn> {
    const spy = vi.fn(implementation);

    vi.stubGlobal('fetch', spy);

    return spy;
  }

  function respond(body: string, status = 200): typeof fetch {
    return () => Promise.resolve(new Response(body, { status }));
  }

  /**
   * k-anonymity is the entire reason this check is allowed to exist: the service learns a five-hex
   * prefix that ~800 other passwords share, and never the password, the full hash or the account.
   * If this assertion ever fails, the feature has become an exfiltration channel.
   */
  it('sends only the first five characters of the SHA-1, never the password or the full hash', async () => {
    const spy = stubFetch(respond(RANGE_BODY));

    await adapter().isBreached('password');

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];

    expect(url).toBe(`${HIBP_RANGE_URL}5BAA6`);
    expect(url).not.toContain(BREACHED_SUFFIX);
    expect(JSON.stringify(init)).not.toContain('password');
  });

  /** Without it the response size leaks how many entries the prefix has. */
  it('asks for padding', async () => {
    const spy = stubFetch(respond(RANGE_BODY));

    await adapter().isBreached('password');

    const [, init] = spy.mock.calls[0] as [string, RequestInit];

    expect(new Headers(init.headers).get('Add-Padding')).toBe('true');
  });

  it('reports a listed password as breached', async () => {
    stubFetch(respond(RANGE_BODY));

    await expect(adapter().isBreached('password')).resolves.toBe(true);
  });

  it('reports an unlisted password as not breached', async () => {
    stubFetch(respond(RANGE_BODY));

    await expect(adapter().isBreached('thermos-quibble-tundra-vellum')).resolves.toBe(false);
  });

  describe('failing open', () => {
    /** Every case here logs on purpose; capturing it keeps the suite's own output clean. */
    let warn: MockInstance;

    beforeEach(() => {
      warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    it.each([
      ['a 500 from the service', respond('', 500)],
      ['a 429 from the service', respond('', 429)],
      ['a connection failure', () => Promise.reject(new Error('ECONNREFUSED'))],
      ['a timeout', () => Promise.reject(new DOMException('aborted', 'TimeoutError'))],
    ])('answers "not breached" on %s', async (_name, implementation) => {
      stubFetch(implementation);

      await expect(adapter().isBreached('password')).resolves.toBe(false);
    });

    /**
     * A connection that dies part-way through the body rejects the `text()` read, and not always
     * with an `Error` — the reason has to survive being turned into a log line either way.
     */
    it('answers "not breached" when the body cannot be read', async () => {
      stubFetch(() => {
        const response = new Response('');

        vi.spyOn(response, 'text').mockRejectedValue('socket hang up');

        return Promise.resolve(response);
      });

      await expect(adapter().isBreached('password')).resolves.toBe(false);

      expect(String(warn.mock.calls[0]?.[0])).toContain('request failed');
    });

    it('warns, so the outage is visible in the logs of the request that hit it', async () => {
      stubFetch(respond('', 503));
      await adapter().isBreached('password');

      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).not.toContain('password');
    });

    it('counts the outcome, so a silent third-party outage is alertable', async () => {
      const subject = adapter();

      stubFetch(respond('', 500));
      await subject.isBreached('password');

      stubFetch(respond(RANGE_BODY));
      await subject.isBreached('password');
      await subject.isBreached('thermos-quibble-tundra-vellum');

      expect(subject.metrics()).toEqual({
        breached: 1,
        clean: 1,
        skipped: 0,
        unavailable: 1,
      });
    });
  });

  describe('when the check is disabled', () => {
    it('never calls the service', async () => {
      const spy = stubFetch(respond(RANGE_BODY));

      await expect(adapter(false).isBreached('password')).resolves.toBe(false);

      expect(spy).not.toHaveBeenCalled();
    });

    it('counts the skip separately from an outage, which is not the same event', async () => {
      const subject = adapter(false);

      await subject.isBreached('password');

      expect(subject.metrics()).toEqual({ breached: 0, clean: 0, skipped: 1, unavailable: 0 });
    });
  });
});
