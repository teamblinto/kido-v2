import { describe, expect, it } from 'vitest';

import { FakeDns } from '../../../../test/support/fake-dns';
import { caaChain, caaIdentifier, caaVerdict, caaVerdictFromAnswers, observeCaa } from './caa';
import type { CaaRecord, DnsAnswer } from './dns.port';

const LE = 'letsencrypt.org';

function issue(value: string, critical = false): CaaRecord {
  return { critical, tag: 'issue', value };
}

/** The chain for `app.acme.com`: the hostname's own set, then `acme.com`'s. */
function chain(own: readonly CaaRecord[], parent: readonly CaaRecord[] = []) {
  return [
    { records: own, zone: 'app.acme.com' },
    { records: parent, zone: 'acme.com' },
  ];
}

function blockedAt(zone: string, identifier = LE) {
  return { record: `0 issue "${identifier}"`, verdict: 'blocked', zone };
}

describe('caaIdentifier', () => {
  it('maps the pinned CUSTOM_HOSTNAME_CA to its CAA issuer domain', () => {
    expect(caaIdentifier('lets_encrypt')).toBe('letsencrypt.org');
    expect(caaIdentifier('google')).toBe('pki.goog');
  });
});

describe('caaChain', () => {
  it('lists the hostname and each parent above the top-level label', () => {
    expect(caaChain('a.b.app.acme.com')).toEqual([
      'a.b.app.acme.com',
      'b.app.acme.com',
      'app.acme.com',
      'acme.com',
    ]);
    expect(caaChain('app.acme.co.uk')).toEqual(['app.acme.co.uk', 'acme.co.uk', 'co.uk']);
  });
});

describe('caaVerdict (R5)', () => {
  it('no CAA anywhere → permitted (the control)', () => {
    expect(caaVerdict(chain([]), LE)).toEqual({ verdict: 'permitted' });
    expect(caaVerdict([], LE)).toEqual({ verdict: 'permitted' });
  });

  it('issue for the pinned CA → permitted, with or without parameters after ";"', () => {
    expect(caaVerdict(chain([issue(LE)]), LE)).toEqual({ verdict: 'permitted' });
    expect(caaVerdict(chain([issue(`${LE}; validationmethods=http-01`)]), LE)).toEqual({
      verdict: 'permitted',
    });
    expect(caaVerdict(chain([issue(`${LE};validationmethods=http-01`)]), LE)).toEqual({
      verdict: 'permitted',
    });
  });

  it('issue for another CA only → blocked, naming the zone and the record to add', () => {
    expect(caaVerdict(chain([issue('sectigo.com')]), LE)).toEqual(blockedAt('app.acme.com'));
  });

  it('any issue property for the pinned CA permits, beside others', () => {
    expect(caaVerdict(chain([issue('sectigo.com'), issue(LE)]), LE)).toEqual({
      verdict: 'permitted',
    });
  });

  it('issuewild for the pinned CA only → blocked (our hostnames are not wildcards)', () => {
    expect(caaVerdict(chain([{ critical: false, tag: 'issuewild', value: LE }]), LE)).toEqual(
      blockedAt('app.acme.com'),
    );
  });

  it('inherited from the parent when the hostname has none → blocked, naming the parent zone', () => {
    expect(caaVerdict(chain([], [issue('sectigo.com')]), LE)).toEqual(blockedAt('acme.com'));
  });

  it("the hostname's own set overrides the parent's", () => {
    expect(caaVerdict(chain([issue(LE)], [issue('sectigo.com')]), LE)).toEqual({
      verdict: 'permitted',
    });
    expect(caaVerdict(chain([issue('sectigo.com')], [issue(LE)]), LE)).toEqual(
      blockedAt('app.acme.com'),
    );
  });

  it('issue ";" (no CA may issue) → blocked', () => {
    expect(caaVerdict(chain([issue(';')]), LE)).toEqual(blockedAt('app.acme.com'));
    expect(caaVerdict(chain([issue('')]), LE)).toEqual(blockedAt('app.acme.com'));
  });

  it('an unknown tag with the critical flag → blocked, even beside a permitting issue', () => {
    const unknown: CaaRecord = { critical: true, tag: 'futuretag', value: 'x' };
    expect(caaVerdict(chain([unknown]), LE)).toEqual(blockedAt('app.acme.com'));
    expect(caaVerdict(chain([issue(LE), unknown]), LE)).toEqual(blockedAt('app.acme.com'));
  });

  it('an unknown tag without the critical flag is ignored', () => {
    expect(caaVerdict(chain([{ critical: false, tag: 'futuretag', value: 'x' }]), LE)).toEqual({
      verdict: 'permitted',
    });
  });

  it('an iodef-only set → permitted, and it stops the climb', () => {
    const iodef: CaaRecord = { critical: false, tag: 'iodef', value: 'mailto:sec@acme.com' };
    expect(caaVerdict(chain([iodef], [issue('sectigo.com')]), LE)).toEqual({
      verdict: 'permitted',
    });
  });

  it('compares the issuer domain case-insensitively and ignores surrounding space', () => {
    expect(caaVerdict(chain([issue(' LetsEncrypt.org ')]), LE)).toEqual({ verdict: 'permitted' });
  });

  it('with CUSTOM_HOSTNAME_CA=google the identifier is pki.goog', () => {
    const google = caaIdentifier('google');
    expect(caaVerdict(chain([issue('pki.goog')]), google)).toEqual({ verdict: 'permitted' });
    expect(caaVerdict(chain([issue(LE)]), google)).toEqual(blockedAt('app.acme.com', 'pki.goog'));
  });
});

describe('caaVerdictFromAnswers', () => {
  const empty = { kind: 'empty' } as const;
  const unavailable = { kind: 'unavailable' } as const;
  const answer = (records: readonly CaaRecord[]): DnsAnswer<{ records: readonly CaaRecord[] }> => ({
    kind: 'answer',
    records,
  });

  it('climbs past empty levels to the first answer', () => {
    expect(
      caaVerdictFromAnswers(
        [
          { answer: empty, zone: 'app.acme.com' },
          { answer: answer([issue('sectigo.com')]), zone: 'acme.com' },
        ],
        LE,
      ),
    ).toEqual(blockedAt('acme.com'));
  });

  it('an unavailable level before the relevant set → unavailable', () => {
    expect(
      caaVerdictFromAnswers(
        [
          { answer: unavailable, zone: 'app.acme.com' },
          { answer: answer([issue(LE)]), zone: 'acme.com' },
        ],
        LE,
      ),
    ).toEqual({ verdict: 'unavailable' });
  });

  it('an unavailable level above the relevant set does not matter', () => {
    expect(
      caaVerdictFromAnswers(
        [
          { answer: answer([issue(LE)]), zone: 'app.acme.com' },
          { answer: unavailable, zone: 'acme.com' },
        ],
        LE,
      ),
    ).toEqual({ verdict: 'permitted' });
  });
});

describe('observeCaa', () => {
  it('asks resolveCaa at every level of the chain and returns the verdict', async () => {
    const dns = new FakeDns().set('acme.com', 'CAA', [issue('sectigo.com')]);

    expect(await observeCaa(dns, 'shop.app.acme.com', LE)).toEqual(blockedAt('acme.com'));
    expect(dns.queries).toEqual([
      { name: 'shop.app.acme.com', type: 'CAA' },
      { name: 'app.acme.com', type: 'CAA' },
      { name: 'acme.com', type: 'CAA' },
    ]);
  });

  it('is unavailable when a level that decides it is unreachable', async () => {
    const dns = new FakeDns().unavailable('acme.com');
    expect(await observeCaa(dns, 'app.acme.com', LE)).toEqual({ verdict: 'unavailable' });
  });

  it('with nothing published → permitted', async () => {
    expect(await observeCaa(new FakeDns(), 'app.acme.com', LE)).toEqual({ verdict: 'permitted' });
  });
});
