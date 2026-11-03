import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import type { Environment } from '../../../config/environment';
import type { BreachedPasswordPort } from './breached-password.port';

/** The k-anonymity range endpoint. Only a five-character hash prefix is ever appended to it. */
export const HIBP_RANGE_URL = 'https://api.pwnedpasswords.com/range/';

/**
 * Short on purpose. This sits on the signup and password-change path, and the check is advisory:
 * waiting three seconds to find out that we cannot find out is worse than not asking.
 */
const REQUEST_TIMEOUT_MS = 2_000;

/** The service asks that clients identify themselves rather than sending a bare request. */
const USER_AGENT = 'forge-api (+https://forge.dev)';

/** Bounded, three-plus-one values — a Prometheus label §06 would accept without a cardinality note. */
export type BreachCheckOutcome = 'breached' | 'clean' | 'skipped' | 'unavailable';

/**
 * Have I Been Pwned's range API, over k-anonymity.
 *
 * The password never leaves the process. Its SHA-1 is split, the first five hex characters are sent,
 * and the ~800 suffixes that share that prefix come back for us to search locally — so the service
 * learns a bucket, never a password, a hash or an account.
 *
 * **It fails open** (ADR 008). Every failure mode — a non-2xx, a refused connection, a timeout, a
 * body that does not parse — answers "not breached", warns, and counts the outcome. HIBP being down
 * must not stop signups; the zxcvbn floor and Argon2id still apply, and a breached password that
 * slips through during an outage is caught at the next password change.
 *
 * SHA-1 is not a security choice here — it is the protocol the corpus is indexed by, and it is used
 * as a bucketing function, never to store anything.
 */
@Injectable()
export class HibpAdapter implements BreachedPasswordPort {
  private readonly counts: Record<BreachCheckOutcome, number> = {
    breached: 0,
    clean: 0,
    skipped: 0,
    unavailable: 0,
  };
  private readonly enabled: boolean;
  private readonly logger = new Logger(HibpAdapter.name);

  // Named token, for the reason `hasher.ts` gives.
  constructor(@Inject(ConfigService) config: ConfigService<Environment, true>) {
    this.enabled = config.get('BREACH_CHECK_ENABLED', { infer: true });
  }

  async isBreached(password: string): Promise<boolean> {
    if (!this.enabled) {
      return this.record('skipped');
    }

    const digest = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = digest.slice(0, 5);
    const suffix = digest.slice(5);

    let body: string;

    try {
      const response = await fetch(`${HIBP_RANGE_URL}${prefix}`, {
        headers: {
          // Without it the response size is a function of how many entries the prefix really has,
          // which leaks back to anyone who can see the encrypted connection's length.
          'Add-Padding': 'true',
          'User-Agent': USER_AGENT,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        return this.unavailable(`responded ${response.status}`);
      }

      body = await response.text();
    } catch (error) {
      return this.unavailable(error instanceof Error ? error.message : 'request failed');
    }

    return this.record(breachCountIn(body, suffix) > 0 ? 'breached' : 'clean');
  }

  /**
   * The counter §06 wants behind a bounded label, readable by whichever task first stands up a
   * Prometheus registry. Until then it is still the thing a test asserts on, which is what stops
   * "fails open" from becoming "fails silently".
   */
  metrics(): Readonly<Record<BreachCheckOutcome, number>> {
    return { ...this.counts };
  }

  /** Never includes the password, the hash or the prefix — only why the corpus could not answer. */
  private unavailable(reason: string): boolean {
    this.logger.warn(`breach check unavailable, failing open (ADR 008): ${reason}`);

    return this.record('unavailable');
  }

  private record(outcome: BreachCheckOutcome): boolean {
    this.counts[outcome] += 1;

    return outcome === 'breached';
  }
}

/**
 * How many times the corpus lists one suffix, given a whole range response.
 *
 * Every unreadable line is worth zero rather than an exception: the body is a third party's, the
 * only consequence of misreading one line is a password that is not rejected, and throwing here
 * would convert a malformed response into a failed signup — the exact outcome ADR 008 rejects.
 *
 * A count of `0` is a *padding* entry, added at our request so the response size says nothing about
 * how many real entries the prefix has. Reading one as a hit would tell a user their password was
 * breached when it was not.
 */
export function breachCountIn(body: string, suffix: string): number {
  const wanted = suffix.trim().toUpperCase();

  for (const line of body.split('\n')) {
    const [candidate, count] = line.trim().toUpperCase().split(':');

    if (candidate !== wanted || count === undefined) {
      continue;
    }

    const occurrences = Number.parseInt(count, 10);

    return Number.isNaN(occurrences) ? 0 : occurrences;
  }

  return 0;
}
