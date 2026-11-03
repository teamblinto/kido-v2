import type { DomainFailureReason } from '@repo/contracts';
import type { Domain } from '@repo/db';
import { describe, expect, it } from 'vitest';

import type { EdgeStatus } from './custom-hostname.port';
import { type CheckObservations, evaluateCheck } from './evaluate-check';

const MINUTE = 60 * 1000;
const HOSTNAME = 'app.acme.com';
const TARGET = 'edge.forge-saas.net';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz234567';
const OTHER_TOKEN = '234567abcdefghijklmnopqrstuvwxyz';
const WINDOW_START = new Date('2026-09-01T12:00:00.000Z');
/** Five minutes into the window, where the pending cadence is 1 minute (R7). */
const NOW = new Date(WINDOW_START.getTime() + 5 * MINUTE);

/** A freshly added `pending` row, as `DomainService.add` inserts it. */
function pendingDomain(overrides: Partial<Domain> = {}): Domain {
  return {
    activatedAt: null,
    addedBy: null,
    certificateActiveAt: null,
    checkRequestedAt: null,
    claimedAt: null,
    createdAt: WINDOW_START,
    driftedAt: null,
    edgeId: null,
    failureCount: 0,
    failureReason: null,
    hostname: HOSTNAME,
    id: '00000000-0000-4000-8000-000000000001',
    lastCheck: null,
    nextCheckAt: NOW,
    orgId: '00000000-0000-4000-8000-000000000002',
    ownershipToken: TOKEN,
    ownershipVerifiedAt: null,
    projectId: '00000000-0000-4000-8000-000000000003',
    releaseWarnedAt: null,
    removalRequestedAt: null,
    state: 'pending',
    updatedAt: WINDOW_START,
    windowStartedAt: WINDOW_START,
    ...overrides,
  };
}

/** A domain whose ownership was proved and which is registered at the edge. */
function registeredDomain(overrides: Partial<Domain> = {}): Domain {
  return pendingDomain({
    edgeId: 'edge-1',
    ownershipVerifiedAt: new Date(WINDOW_START.getTime() + MINUTE),
    ...overrides,
  });
}

function edge(
  hostname: EdgeStatus['hostname'],
  certificate: EdgeStatus['certificate'],
  validationRecords: EdgeStatus['validationRecords'] = [],
): CheckObservations['edge'] {
  return { certificate, errors: [], hostname, kind: 'status', validationRecords };
}

/** Nothing published yet: no TXT, no CNAME, not an apex, no CAA, not registered. */
function observations(overrides: Partial<CheckObservations> = {}): CheckObservations {
  return {
    caa: { verdict: 'permitted' },
    challengeTxt: { kind: 'empty' },
    cnameChain: { kind: 'empty' },
    routingTarget: TARGET,
    soaOwner: { kind: 'empty' },
    ...overrides,
  };
}

const TXT_FOUND: CheckObservations['challengeTxt'] = {
  kind: 'answer',
  records: ['v=spf1 -all', `forge-verify=${TOKEN}`],
};
const CNAME_FOUND: CheckObservations['cnameChain'] = { chain: [TARGET], kind: 'answer' };

describe('evaluateCheck, pending (research R6)', () => {
  it('stays pending and does not register while the ownership TXT is missing', () => {
    const outcome = evaluateCheck(pendingDomain(), observations({ cnameChain: CNAME_FOUND }), NOW);

    expect(outcome.conclusive).toBe(true);
    expect(outcome.transition).toBeNull();
    expect(outcome.register).toBe(false);
    expect(outcome.changes).toEqual({});
    expect(outcome.recordStatuses).toEqual({
      certificate: null,
      ownership: 'missing',
      routing: 'found',
    });
    expect(outcome.nextCheckAt).toEqual(new Date(NOW.getTime() + MINUTE));
  });

  it('never verifies a TXT carrying another token, only exactly forge-verify=<token>', () => {
    for (const records of [
      [`forge-verify=${OTHER_TOKEN}`],
      [`forge-verify=${TOKEN} `],
      [`forge-verify=${TOKEN.toUpperCase()}`],
      [TOKEN],
    ]) {
      const outcome = evaluateCheck(
        pendingDomain(),
        observations({ challengeTxt: { kind: 'answer', records } }),
        NOW,
      );
      expect(outcome.register).toBe(false);
      expect(outcome.changes.ownershipVerifiedAt).toBeUndefined();
      expect(outcome.recordStatuses.ownership).toBe('mismatch');
    }
  });

  it('asks to register once the ownership TXT is found and there is no edge_id (R3)', () => {
    const outcome = evaluateCheck(pendingDomain(), observations({ challengeTxt: TXT_FOUND }), NOW);

    expect(outcome.conclusive).toBe(true);
    expect(outcome.transition).toBeNull();
    expect(outcome.register).toBe(true);
    expect(outcome.changes).toEqual({ ownershipVerifiedAt: NOW });
    expect(outcome.recordStatuses.ownership).toBe('found');
  });

  it('asks to register again when ownership was proved earlier but registration has not happened', () => {
    const verifiedAt = new Date(WINDOW_START.getTime() + MINUTE);
    const outcome = evaluateCheck(
      pendingDomain({ ownershipVerifiedAt: verifiedAt }),
      observations(),
      NOW,
    );

    expect(outcome.register).toBe(true);
    // Proved once is proved (R3): the TXT need not stay, and the first time is kept.
    expect(outcome.changes).toEqual({});
    expect(outcome.recordStatuses.ownership).toBe('found');
  });

  it('does not register again once edge_id is set', () => {
    const outcome = evaluateCheck(
      registeredDomain(),
      observations({ challengeTxt: TXT_FOUND, edge: edge('pending', 'pending') }),
      NOW,
    );

    expect(outcome.register).toBe(false);
    expect(outcome.transition).toBeNull();
  });

  it('stays pending while the edge hostname is pending', () => {
    const outcome = evaluateCheck(
      registeredDomain(),
      observations({ cnameChain: CNAME_FOUND, edge: edge('pending', 'active') }),
      NOW,
    );

    expect(outcome.transition).toBeNull();
    expect(outcome.lastCheck.edge).toEqual({ certificate: 'active', hostname: 'pending' });
  });

  it('stays pending while the certificate is pending, however active the hostname (FR-009)', () => {
    const outcome = evaluateCheck(
      registeredDomain(),
      observations({ cnameChain: CNAME_FOUND, edge: edge('active', 'pending') }),
      NOW,
    );

    expect(outcome.transition).toBeNull();
    expect(outcome.changes).toEqual({});
  });

  it('never activates on the edge alone, without ownership proved (FR-009)', () => {
    const outcome = evaluateCheck(
      registeredDomain({ ownershipVerifiedAt: null }),
      observations({ cnameChain: CNAME_FOUND, edge: edge('active', 'active') }),
      NOW,
    );

    expect(outcome.transition).toBeNull();
    expect(outcome.changes.activatedAt).toBeUndefined();
  });

  it('activates when ownership, the edge hostname and the certificate are all active', () => {
    const outcome = evaluateCheck(
      registeredDomain(),
      observations({ cnameChain: CNAME_FOUND, edge: edge('active', 'active') }),
      NOW,
    );

    expect(outcome.conclusive).toBe(true);
    expect(outcome.transition).toEqual({ failureReason: null, from: 'pending', to: 'active' });
    expect(outcome.register).toBe(false);
    expect(outcome.changes).toEqual({ activatedAt: NOW, certificateActiveAt: NOW });
    expect(outcome.recordStatuses).toEqual({
      certificate: null,
      ownership: 'found',
      routing: 'found',
    });
  });

  it('activates when ownership is proved on the same check as the edge turns active', () => {
    const outcome = evaluateCheck(
      registeredDomain({ ownershipVerifiedAt: null }),
      observations({ challengeTxt: TXT_FOUND, edge: edge('active', 'active') }),
      NOW,
    );

    expect(outcome.transition?.to).toBe('active');
    expect(outcome.changes).toEqual({
      activatedAt: NOW,
      certificateActiveAt: NOW,
      ownershipVerifiedAt: NOW,
    });
  });

  it('keeps the first certificate_active_at', () => {
    const first = new Date(WINDOW_START.getTime() + 2 * MINUTE);
    const outcome = evaluateCheck(
      registeredDomain({ certificateActiveAt: first }),
      observations({ edge: edge('active', 'active') }),
      NOW,
    );

    expect(outcome.changes).toEqual({ activatedAt: NOW });
  });

  it('records certificate_active_at the first time the certificate is active, before activation', () => {
    const outcome = evaluateCheck(
      registeredDomain(),
      observations({ edge: edge('pending', 'active') }),
      NOW,
    );

    expect(outcome.transition).toBeNull();
    expect(outcome.changes).toEqual({ certificateActiveAt: NOW });
  });

  describe('inconclusive checks (FR-021)', () => {
    const cases: [string, Domain, Partial<CheckObservations>][] = [
      ['the challenge TXT', pendingDomain(), { challengeTxt: { kind: 'unavailable' } }],
      [
        'the CNAME chain',
        pendingDomain(),
        { challengeTxt: TXT_FOUND, cnameChain: { kind: 'unavailable' } },
      ],
      ['the SOA', pendingDomain(), { challengeTxt: TXT_FOUND, soaOwner: { kind: 'unavailable' } }],
      [
        'the CAA chain',
        pendingDomain(),
        { challengeTxt: TXT_FOUND, caa: { verdict: 'unavailable' } },
      ],
      ['the edge', registeredDomain(), { cnameChain: CNAME_FOUND, edge: { kind: 'unavailable' } }],
    ];

    it.each(cases)('changes nothing when %s is unavailable', (_what, domain, overrides) => {
      const outcome = evaluateCheck(domain, observations(overrides), NOW);

      expect(outcome.conclusive).toBe(false);
      expect(outcome.transition).toBeNull();
      expect(outcome.register).toBe(false);
      expect(outcome.changes).toEqual({});
      expect(outcome.nextCheckAt).toEqual(new Date(NOW.getTime() + 5 * MINUTE));
      expect(outcome.lastCheck.conclusive).toBe(false);
    });

    it('does not activate on an edge that is active when a resolver is unavailable', () => {
      const outcome = evaluateCheck(
        registeredDomain(),
        observations({ cnameChain: { kind: 'unavailable' }, edge: edge('active', 'active') }),
        NOW,
      );

      expect(outcome.conclusive).toBe(false);
      expect(outcome.transition).toBeNull();
      expect(outcome.changes).toEqual({});
    });

    it('marks what it could not see as unchecked', () => {
      const outcome = evaluateCheck(
        pendingDomain(),
        observations({
          challengeTxt: { kind: 'unavailable' },
          cnameChain: { kind: 'unavailable' },
        }),
        NOW,
      );

      expect(outcome.recordStatuses).toEqual({
        certificate: null,
        ownership: 'unchecked',
        routing: 'unchecked',
      });
    });
  });

  it('reports an unproved ownership whose TXT was not asked as unchecked', () => {
    const asked: CheckObservations = {
      caa: { verdict: 'permitted' },
      cnameChain: { kind: 'empty' },
      routingTarget: TARGET,
      soaOwner: { kind: 'empty' },
    };
    const outcome = evaluateCheck(pendingDomain(), asked, NOW);

    expect(outcome.recordStatuses.ownership).toBe('unchecked');
    expect(outcome.register).toBe(false);
  });

  describe('routing', () => {
    it('is found when the CNAME chain reaches the target through several hops', () => {
      const outcome = evaluateCheck(
        pendingDomain(),
        observations({
          cnameChain: { chain: ['app.acme-cdn.net', 'x.acme-cdn.net', TARGET], kind: 'answer' },
        }),
        NOW,
      );

      expect(outcome.recordStatuses.routing).toBe('found');
    });

    it('compares the target without regard to case', () => {
      const outcome = evaluateCheck(
        pendingDomain(),
        observations({ cnameChain: CNAME_FOUND, routingTarget: 'Edge.Forge-SaaS.net' }),
        NOW,
      );

      expect(outcome.recordStatuses.routing).toBe('found');
    });

    it('is a mismatch when the chain ends elsewhere', () => {
      const outcome = evaluateCheck(
        pendingDomain(),
        observations({ cnameChain: { chain: ['old-host.example.net'], kind: 'answer' } }),
        NOW,
      );

      expect(outcome.recordStatuses.routing).toBe('mismatch');
    });

    it('is missing when there is no CNAME', () => {
      expect(evaluateCheck(pendingDomain(), observations(), NOW).recordStatuses.routing).toBe(
        'missing',
      );
    });

    it('is found when the edge reports the hostname active, with no CNAME visible', () => {
      const outcome = evaluateCheck(
        registeredDomain(),
        observations({ edge: edge('active', 'pending') }),
        NOW,
      );

      expect(outcome.recordStatuses.routing).toBe('found');
    });

    it('is apex when the SOA is owned by the hostname itself', () => {
      const outcome = evaluateCheck(
        pendingDomain(),
        observations({ soaOwner: { kind: 'answer', owner: HOSTNAME } }),
        NOW,
      );

      expect(outcome.recordStatuses.routing).toBe('apex');
      expect(outcome.lastCheck.records).toContainEqual({ purpose: 'routing', status: 'apex' });
    });

    it('is not apex when the SOA belongs to a parent zone', () => {
      const outcome = evaluateCheck(
        pendingDomain(),
        observations({ soaOwner: { kind: 'answer', owner: 'acme.com' } }),
        NOW,
      );

      expect(outcome.recordStatuses.routing).toBe('missing');
    });
  });

  describe('lastCheck', () => {
    it('records the check for the panel', () => {
      const outcome = evaluateCheck(
        registeredDomain(),
        observations({
          caa: { record: '0 issue "letsencrypt.org"', verdict: 'blocked', zone: 'acme.com' },
          cnameChain: CNAME_FOUND,
          edge: edge('active', 'pending', [
            { name: '_acme-challenge.app.acme.com', value: 'validation-value' },
          ]),
        }),
        NOW,
      );

      expect(outcome.lastCheck).toEqual({
        at: NOW.toISOString(),
        caa: { record: '0 issue "letsencrypt.org"', verdict: 'blocked', zone: 'acme.com' },
        certificateRecords: [{ name: '_acme-challenge.app.acme.com', value: 'validation-value' }],
        conclusive: true,
        edge: { certificate: 'pending', hostname: 'active' },
        edgeMessage: null,
        records: [
          { purpose: 'ownership', status: 'found' },
          { purpose: 'routing', status: 'found' },
          { purpose: 'certificate', status: 'missing' },
        ],
      });
      expect(outcome.recordStatuses.certificate).toBe('missing');
    });

    it('has no edge and no certificate record before registration', () => {
      const { lastCheck } = evaluateCheck(pendingDomain(), observations(), NOW);

      expect(lastCheck.edge).toBeNull();
      expect(lastCheck.certificateRecords).toEqual([]);
      expect(lastCheck.records.map((record) => record.purpose)).toEqual(['ownership', 'routing']);
    });

    it('shows the certificate record found once the certificate is active', () => {
      const outcome = evaluateCheck(
        registeredDomain(),
        observations({
          edge: edge('pending', 'active', [{ name: '_acme-challenge.app.acme.com', value: 'v' }]),
        }),
        NOW,
      );

      expect(outcome.recordStatuses.certificate).toBe('found');
    });

    it('records CAA as permitted when the observe step did not gather it', () => {
      const { caa, ...rest } = observations();
      void caa;
      expect(evaluateCheck(pendingDomain(), rest, NOW).lastCheck.caa).toEqual({
        verdict: 'permitted',
      });
    });
  });
});

describe('evaluateCheck, the end of the window (research R6, US4)', () => {
  const HOUR = 60 * MINUTE;
  const WINDOW_END = new Date(WINDOW_START.getTime() + 72 * HOUR);
  const BLOCKED: CheckObservations['caa'] = {
    record: '0 issue "letsencrypt.org"',
    verdict: 'blocked',
    zone: 'acme.com',
  };
  const TXT_MISMATCH: CheckObservations['challengeTxt'] = {
    kind: 'answer',
    records: [`forge-verify=${OTHER_TOKEN}`],
  };
  const CNAME_ELSEWHERE: CheckObservations['cnameChain'] = {
    chain: ['acme.herokudns.com'],
    kind: 'answer',
  };

  it('stays pending a millisecond before 72 h, and schedules no check past the end', () => {
    const now = new Date(WINDOW_END.getTime() - 30 * MINUTE);
    const outcome = evaluateCheck(pendingDomain(), observations(), now);

    expect(outcome.transition).toBeNull();
    // Past 24 h the cadence is hourly (T028); the last check falls on the window's end, not after.
    expect(outcome.nextCheckAt).toEqual(WINDOW_END);

    const justBefore = evaluateCheck(
      pendingDomain(),
      observations(),
      new Date(WINDOW_END.getTime() - 1),
    );
    expect(justBefore.transition).toBeNull();
  });

  it('keeps the cadence where the end is further than the next check', () => {
    const now = new Date(WINDOW_END.getTime() - 2 * HOUR);
    expect(evaluateCheck(pendingDomain(), observations(), now).nextCheckAt).toEqual(
      new Date(now.getTime() + HOUR),
    );
  });

  it('ends an unregistered domain failed directly at 72 h, with nothing to register', () => {
    const outcome = evaluateCheck(pendingDomain(), observations(), WINDOW_END);

    expect(outcome.conclusive).toBe(true);
    expect(outcome.transition).toEqual({
      failureReason: 'verification-timeout',
      from: 'pending',
      to: 'failed',
    });
    expect(outcome.register).toBe(false);
    expect(outcome.changes).toEqual({});
    // An ended row is never due again; `next_check_at` stays a plain timestamp.
    expect(outcome.nextCheckAt).toEqual(WINDOW_END);
    expect(outcome.lastCheck.at).toBe(WINDOW_END.toISOString());
  });

  it('does not register a hostname whose ownership is proved only on the window-end check', () => {
    const outcome = evaluateCheck(
      pendingDomain(),
      observations({ challengeTxt: TXT_FOUND, cnameChain: CNAME_ELSEWHERE }),
      new Date(WINDOW_END.getTime() + 5 * MINUTE),
    );

    expect(outcome.register).toBe(false);
    expect(outcome.transition).toEqual({
      failureReason: 'routing-not-found',
      from: 'pending',
      to: 'failed',
    });
  });

  it('sends a registered domain to removing with the reason set, due at once', () => {
    const outcome = evaluateCheck(
      registeredDomain(),
      observations({ cnameChain: CNAME_FOUND, edge: edge('active', 'pending') }),
      WINDOW_END,
    );

    expect(outcome.transition).toEqual({
      failureReason: 'certificate-failed',
      from: 'pending',
      to: 'removing',
    });
    expect(outcome.register).toBe(false);
    expect(outcome.changes).toEqual({ removalRequestedAt: WINDOW_END });
    expect(outcome.nextCheckAt).toEqual(WINDOW_END);
  });

  it('activates rather than ends when the check at 72 h finds everything active', () => {
    const outcome = evaluateCheck(
      registeredDomain(),
      observations({ cnameChain: CNAME_FOUND, edge: edge('active', 'active') }),
      WINDOW_END,
    );

    expect(outcome.transition).toEqual({ failureReason: null, from: 'pending', to: 'active' });
  });

  it('does not end the window on an inconclusive check (FR-021)', () => {
    const outcome = evaluateCheck(
      registeredDomain(),
      observations({ cnameChain: CNAME_FOUND, edge: { kind: 'unavailable' } }),
      WINDOW_END,
    );

    expect(outcome.conclusive).toBe(false);
    expect(outcome.transition).toBeNull();
    expect(outcome.nextCheckAt).toEqual(new Date(WINDOW_END.getTime() + 5 * MINUTE));
  });

  it('does not end the window early on an edge certificate that failed', () => {
    const outcome = evaluateCheck(
      registeredDomain(),
      observations({ cnameChain: CNAME_FOUND, edge: edge('active', 'failed') }),
      NOW,
    );

    expect(outcome.transition).toBeNull();
    expect(outcome.changes).toEqual({});
  });

  describe('the most specific reason, in the order of R6', () => {
    const cases: [string, Domain, Partial<CheckObservations>, DomainFailureReason, string][] = [
      [
        'CAA blocks the pinned CA, before a missing TXT and CNAME',
        pendingDomain(),
        { caa: BLOCKED, challengeTxt: TXT_MISMATCH },
        'caa-blocked',
        'failed',
      ],
      [
        'CAA blocks a registered domain whose certificate failed',
        registeredDomain(),
        { caa: BLOCKED, cnameChain: CNAME_FOUND, edge: edge('active', 'failed') },
        'caa-blocked',
        'removing',
      ],
      [
        'a TXT with another value, before routing',
        pendingDomain(),
        { challengeTxt: TXT_MISMATCH },
        'ownership-not-found',
        'failed',
      ],
      [
        'no TXT, with the CNAME in place',
        pendingDomain(),
        { cnameChain: CNAME_FOUND },
        'ownership-not-found',
        'failed',
      ],
      [
        'ownership proved, the CNAME elsewhere',
        registeredDomain(),
        { cnameChain: CNAME_ELSEWHERE, edge: edge('pending', 'pending') },
        'routing-not-found',
        'removing',
      ],
      [
        'an apex (FR-003), where no CNAME can sit',
        pendingDomain(),
        { soaOwner: { kind: 'answer', owner: HOSTNAME } },
        'routing-not-found',
        'failed',
      ],
      [
        'registered and routed, the certificate never issued',
        registeredDomain(),
        { cnameChain: CNAME_FOUND, edge: edge('active', 'failed') },
        'certificate-failed',
        'removing',
      ],
      ['nothing published at all (SC-008)', pendingDomain(), {}, 'verification-timeout', 'failed'],
      [
        'only a CNAME that was there before, pointing elsewhere',
        pendingDomain(),
        { cnameChain: CNAME_ELSEWHERE },
        'verification-timeout',
        'failed',
      ],
      [
        'registered with the certificate active and the hostname never active',
        registeredDomain({ certificateActiveAt: NOW }),
        { cnameChain: CNAME_FOUND, edge: edge('pending', 'active') },
        'verification-timeout',
        'removing',
      ],
    ];

    it.each(cases)('%s', (_what, domain, overrides, reason, to) => {
      const outcome = evaluateCheck(domain, observations(overrides), WINDOW_END);

      expect(outcome.transition).toEqual({ failureReason: reason, from: 'pending', to });
    });

    it('never ends the window provider-refused, which only a refused registration is', () => {
      for (const [, domain, overrides] of cases) {
        const outcome = evaluateCheck(domain, observations(overrides), WINDOW_END);
        expect(outcome.transition?.failureReason).not.toBe('provider-refused');
      }
    });
  });
});

describe('evaluateCheck, active and drifted (research R6, US3)', () => {
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const ACTIVATED = new Date(WINDOW_START.getTime() + 10 * MINUTE);
  const LATER = new Date(WINDOW_START.getTime() + 10 * DAY);

  /** An `active` row as the pending → active settle leaves it. */
  function activeDomain(overrides: Partial<Domain> = {}): Domain {
    return registeredDomain({
      activatedAt: ACTIVATED,
      certificateActiveAt: ACTIVATED,
      state: 'active',
      ...overrides,
    });
  }

  /** A row `drifted` for `ageMs` at `LATER`, its count held at 3. */
  function driftedDomain(ageMs: number, overrides: Partial<Domain> = {}): Domain {
    return activeDomain({
      driftedAt: new Date(LATER.getTime() - ageMs),
      failureCount: 3,
      state: 'drifted',
      ...overrides,
    });
  }

  /** What an active/drifted check observes: the CNAME chain, the CAA chain and the edge, no TXT. */
  function liveObservations(overrides: Partial<CheckObservations> = {}): CheckObservations {
    return {
      caa: { verdict: 'permitted' },
      cnameChain: CNAME_FOUND,
      edge: edge('active', 'active'),
      routingTarget: TARGET,
      ...overrides,
    };
  }

  /** The CNAME gone and the edge reporting the hostname moved (vendor `moved` → `blocked`). */
  const BROKEN: Partial<CheckObservations> = {
    cnameChain: { kind: 'empty' },
    edge: edge('blocked', 'active'),
  };

  describe('active', () => {
    it('passes with the CNAME, the edge hostname and certificate active and CAA permitted', () => {
      const outcome = evaluateCheck(activeDomain(), liveObservations(), LATER);

      expect(outcome.conclusive).toBe(true);
      expect(outcome.transition).toBeNull();
      expect(outcome.register).toBe(false);
      expect(outcome.releaseWarning).toBe(false);
      expect(outcome.changes).toEqual({});
      expect(outcome.recordStatuses).toEqual({
        certificate: null,
        ownership: 'found',
        routing: 'found',
      });
      expect(outcome.nextCheckAt).toEqual(new Date(LATER.getTime() + DAY));
    });

    it('resets failure_count on a pass', () => {
      const outcome = evaluateCheck(activeDomain({ failureCount: 2 }), liveObservations(), LATER);

      expect(outcome.transition).toBeNull();
      expect(outcome.changes).toEqual({ failureCount: 0 });
    });

    it('stays active on failures 1 and 2, counting them, an hour apart', () => {
      for (const failureCount of [0, 1]) {
        const outcome = evaluateCheck(
          activeDomain({ failureCount }),
          liveObservations(BROKEN),
          LATER,
        );

        expect(outcome.conclusive).toBe(true);
        expect(outcome.transition).toBeNull();
        expect(outcome.changes).toEqual({ failureCount: failureCount + 1 });
        expect(outcome.nextCheckAt).toEqual(new Date(LATER.getTime() + HOUR));
      }
    });

    it('becomes drifted on the third consecutive failure, with drifted_at set', () => {
      const outcome = evaluateCheck(
        activeDomain({ failureCount: 2 }),
        liveObservations(BROKEN),
        LATER,
      );

      expect(outcome.transition).toEqual({ failureReason: null, from: 'active', to: 'drifted' });
      expect(outcome.changes).toEqual({ driftedAt: LATER, failureCount: 3 });
      expect(outcome.nextCheckAt).toEqual(new Date(LATER.getTime() + HOUR));
    });

    it.each<[string, Partial<CheckObservations>]>([
      ['the edge hostname is not active', { edge: edge('pending', 'active') }],
      ['the certificate is not active', { edge: edge('active', 'failed') }],
      [
        'CAA blocks the pinned CA',
        {
          caa: { record: '0 issue "letsencrypt.org"', verdict: 'blocked', zone: 'acme.com' },
        },
      ],
      ['routing is not found', BROKEN],
    ])('counts a failure when %s', (_what, overrides) => {
      const outcome = evaluateCheck(activeDomain(), liveObservations(overrides), LATER);

      expect(outcome.conclusive).toBe(true);
      expect(outcome.changes).toEqual({ failureCount: 1 });
    });

    it('finds routing through the edge when a proxy hides the CNAME (R6)', () => {
      const outcome = evaluateCheck(
        activeDomain({ failureCount: 1 }),
        liveObservations({ cnameChain: { kind: 'empty' } }),
        LATER,
      );

      expect(outcome.recordStatuses.routing).toBe('found');
      expect(outcome.changes).toEqual({ failureCount: 0 });
    });

    it.each<[string, Partial<CheckObservations>]>([
      ['the CNAME chain', { cnameChain: { kind: 'unavailable' } }],
      ['the CAA chain', { caa: { verdict: 'unavailable' } }],
      ['the edge', { edge: { kind: 'unavailable' } }],
    ])('leaves the count alone when %s is unavailable (FR-021)', (_what, overrides) => {
      const outcome = evaluateCheck(
        activeDomain({ failureCount: 2 }),
        liveObservations({ ...BROKEN, ...overrides }),
        LATER,
      );

      expect(outcome.conclusive).toBe(false);
      expect(outcome.transition).toBeNull();
      expect(outcome.changes).toEqual({});
      expect(outcome.nextCheckAt).toEqual(new Date(LATER.getTime() + 5 * MINUTE));
    });

    it('never asks for a release warning', () => {
      expect(
        evaluateCheck(activeDomain({ failureCount: 2 }), liveObservations(BROKEN), LATER)
          .releaseWarning,
      ).toBe(false);
    });
  });

  describe('drifted', () => {
    it('counts a drift with no drifted_at (never stored: the data-model CHECK) as just begun', () => {
      const outcome = evaluateCheck(
        driftedDomain(0, { driftedAt: null }),
        liveObservations(BROKEN),
        LATER,
      );

      expect(outcome.transition).toBeNull();
      expect(outcome.releaseWarning).toBe(false);
      expect(outcome.changes).toEqual({});
      expect(outcome.nextCheckAt).toEqual(new Date(LATER.getTime() + HOUR));
    });

    it('keeps failure_count at 3 on further failures, never above (the data-model CHECK)', () => {
      const outcome = evaluateCheck(driftedDomain(DAY), liveObservations(BROKEN), LATER);

      expect(outcome.conclusive).toBe(true);
      expect(outcome.transition).toBeNull();
      expect(outcome.changes).toEqual({});
      expect(outcome.changes.failureCount ?? 3).toBeLessThanOrEqual(3);
      expect(outcome.nextCheckAt).toEqual(new Date(LATER.getTime() + HOUR));
    });

    it('recovers to active on one pass, with the count reset and drifted_at cleared (domain.recovered)', () => {
      const outcome = evaluateCheck(driftedDomain(DAY), liveObservations(), LATER);

      expect(outcome.transition).toEqual({ failureReason: null, from: 'drifted', to: 'active' });
      expect(outcome.changes).toEqual({
        driftedAt: null,
        failureCount: 0,
        releaseWarnedAt: null,
      });
      expect(outcome.releaseWarning).toBe(false);
    });

    it('asks for the release warning at a drift age of 23 days with none sent yet', () => {
      const outcome = evaluateCheck(driftedDomain(23 * DAY), liveObservations(BROKEN), LATER);

      expect(outcome.transition).toBeNull();
      expect(outcome.releaseWarning).toBe(true);
      expect(outcome.changes).toEqual({ releaseWarnedAt: LATER });
    });

    it('does not ask for it before 23 days, or again once sent', () => {
      const early = evaluateCheck(driftedDomain(23 * DAY - 1), liveObservations(BROKEN), LATER);
      expect(early.releaseWarning).toBe(false);
      expect(early.changes).toEqual({});

      const warnedAt = new Date(LATER.getTime() - DAY);
      const again = evaluateCheck(
        driftedDomain(24 * DAY, { releaseWarnedAt: warnedAt }),
        liveObservations(BROKEN),
        LATER,
      );
      expect(again.releaseWarning).toBe(false);
      expect(again.changes).toEqual({});
    });

    it('releases at a drift age of 30 days: removing, with no reason, due at once', () => {
      const warnedAt = new Date(LATER.getTime() - 7 * DAY);
      const outcome = evaluateCheck(
        driftedDomain(30 * DAY, { releaseWarnedAt: warnedAt }),
        liveObservations(BROKEN),
        LATER,
      );

      expect(outcome.transition).toEqual({ failureReason: null, from: 'drifted', to: 'removing' });
      expect(outcome.releaseWarning).toBe(false);
      expect(outcome.changes).toEqual({
        driftedAt: null,
        releaseWarnedAt: warnedAt,
        removalRequestedAt: LATER,
      });
      expect(outcome.nextCheckAt).toEqual(LATER);
    });

    it('marks a release that no warning preceded, so its end still sends domain-released', () => {
      const outcome = evaluateCheck(driftedDomain(31 * DAY), liveObservations(BROKEN), LATER);

      expect(outcome.transition?.to).toBe('removing');
      expect(outcome.changes.releaseWarnedAt).toEqual(LATER);
    });

    it('recovers rather than releases when the check at 30 days passes', () => {
      const outcome = evaluateCheck(driftedDomain(30 * DAY), liveObservations(), LATER);

      expect(outcome.transition?.to).toBe('active');
    });

    it('neither warns nor releases on an inconclusive check (FR-021)', () => {
      const outcome = evaluateCheck(
        driftedDomain(30 * DAY),
        liveObservations({ ...BROKEN, edge: { kind: 'unavailable' } }),
        LATER,
      );

      expect(outcome.conclusive).toBe(false);
      expect(outcome.transition).toBeNull();
      expect(outcome.releaseWarning).toBe(false);
      expect(outcome.changes).toEqual({});
    });
  });
});

describe('evaluateCheck, states never evaluated', () => {
  it('refuses removing, which the checker deregisters rather than evaluates (R10)', () => {
    expect(() =>
      evaluateCheck(registeredDomain({ state: 'removing' }), observations(), NOW),
    ).toThrow(/never evaluated/);
  });

  it.each(['failed', 'removed'] as const)('refuses %s, which is never checked', (state) => {
    expect(() => evaluateCheck(pendingDomain({ state }), observations(), NOW)).toThrow(
      /never checked/,
    );
  });
});
