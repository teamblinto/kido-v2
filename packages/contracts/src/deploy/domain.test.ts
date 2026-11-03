import { describe, expect, it } from 'vitest';

import {
  DOMAIN_CONFLICT_REASONS,
  DOMAIN_FAILURE_REASONS,
  DOMAIN_STATES,
  addDomainRequestSchema,
  domainCheckSchema,
  domainListResponseSchema,
  domainResponseSchema,
  domainSchema,
  removeDomainResponseSchema,
} from './domain';

const UUID = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';
const AT = '2026-09-23T10:00:00.000Z';

const ownership = {
  purpose: 'ownership',
  type: 'TXT',
  name: '_forge-challenge.app.acme.com',
  value: 'forge-verify=abc',
  status: 'missing',
} as const;

const routing = {
  purpose: 'routing',
  type: 'CNAME',
  name: 'app.acme.com',
  value: 'edge.example.test',
  status: 'unchecked',
} as const;

const check = {
  at: AT,
  conclusive: true,
  hostnameActive: null,
  certificateActive: null,
  caa: { verdict: 'permitted' },
  message: null,
} as const;

const pending = {
  id: UUID,
  hostname: 'app.acme.com',
  displayHostname: 'app.acme.com',
  state: 'pending',
  failureReason: null,
  records: [ownership, routing],
  check: null,
  windowEndsAt: AT,
  addedBy: UUID,
  createdAt: AT,
  activatedAt: null,
  driftedAt: null,
  releaseAt: null,
  checkAvailableAt: null,
} as const;

describe('catalogues', () => {
  it('never lists removed as a returned state', () => {
    expect(DOMAIN_STATES).toEqual(['pending', 'active', 'drifted', 'removing', 'failed']);
    expect(DOMAIN_FAILURE_REASONS).toContain('caa-blocked');
  });

  it('names every 409 reason of contracts/domains.md § Refusals, once', () => {
    expect([...DOMAIN_CONFLICT_REASONS].sort()).toEqual([
      'apex-not-supported',
      'domain-limit',
      'domains-unavailable',
      'hostname-unavailable',
      'invalid-hostname',
      'not-deployable',
      'not-retryable',
      'project-archived',
      'reserved-hostname',
    ]);
  });
});

describe('addDomainRequestSchema', () => {
  it('accepts a hostname and trims it', () => {
    const parsed = addDomainRequestSchema.safeParse({ hostname: '  app.acme.com ' });
    expect(parsed.success && parsed.data.hostname).toBe('app.acme.com');
  });

  it('refuses an unknown key, an empty and an over-long hostname', () => {
    expect(
      addDomainRequestSchema.safeParse({ hostname: 'app.acme.com', force: true }).success,
    ).toBe(false);
    expect(addDomainRequestSchema.safeParse({ hostname: '   ' }).success).toBe(false);
    expect(addDomainRequestSchema.safeParse({ hostname: 'a'.repeat(301) }).success).toBe(false);
  });
});

describe('domainSchema', () => {
  it('accepts a pending domain and a checked failed one', () => {
    expect(domainSchema.safeParse(pending).success).toBe(true);
    expect(
      domainSchema.safeParse({
        ...pending,
        state: 'failed',
        failureReason: 'caa-blocked',
        check: {
          ...check,
          caa: { verdict: 'blocked', zone: 'acme.com', record: '0 issue "other.ca"' },
        },
      }).success,
    ).toBe(true);
  });

  it("refuses state 'removed'", () => {
    expect(domainSchema.safeParse({ ...pending, state: 'removed' }).success).toBe(false);
  });

  it('refuses an undeclared key and an unknown failure reason', () => {
    expect(domainSchema.safeParse({ ...pending, ownershipToken: 'abc' }).success).toBe(false);
    expect(domainSchema.safeParse({ ...pending, failureReason: 'dns-broken' }).success).toBe(false);
  });

  it('is wrapped as { domain }', () => {
    expect(domainResponseSchema.safeParse({ domain: pending }).success).toBe(true);
    expect(domainResponseSchema.safeParse({ domain: pending, x: 1 }).success).toBe(false);
  });
});

describe('domainCheckSchema.caa', () => {
  it('accepts a bare permitted verdict', () => {
    expect(domainCheckSchema.safeParse(check).success).toBe(true);
  });

  it('requires zone and record when blocked', () => {
    expect(domainCheckSchema.safeParse({ ...check, caa: { verdict: 'blocked' } }).success).toBe(
      false,
    );
    expect(
      domainCheckSchema.safeParse({
        ...check,
        caa: { verdict: 'blocked', zone: 'acme.com', record: '0 issue "other.ca"' },
      }).success,
    ).toBe(true);
  });

  it('refuses zone on a permitted verdict and an unknown verdict', () => {
    expect(
      domainCheckSchema.safeParse({ ...check, caa: { verdict: 'permitted', zone: 'acme.com' } })
        .success,
    ).toBe(false);
    expect(domainCheckSchema.safeParse({ ...check, caa: { verdict: 'maybe' } }).success).toBe(
      false,
    );
  });
});

describe('domainListResponseSchema', () => {
  it('accepts items with canManage', () => {
    expect(domainListResponseSchema.safeParse({ items: [pending], canManage: true }).success).toBe(
      true,
    );
  });

  it('requires canManage', () => {
    expect(domainListResponseSchema.safeParse({ items: [pending] }).success).toBe(false);
  });
});

describe('removeDomainResponseSchema', () => {
  const removing = { ...pending, state: 'removing' } as const;
  const deletable = { name: routing.name, type: routing.type, value: routing.value };

  it('accepts deletable records of name, type and value', () => {
    expect(
      removeDomainResponseSchema.safeParse({ domain: removing, deletableRecords: [deletable] })
        .success,
    ).toBe(true);
  });

  it('refuses a status or purpose on a deletable record', () => {
    expect(
      removeDomainResponseSchema.safeParse({
        domain: removing,
        deletableRecords: [{ ...deletable, status: 'found' }],
      }).success,
    ).toBe(false);
    expect(
      removeDomainResponseSchema.safeParse({
        domain: removing,
        deletableRecords: [{ ...deletable, purpose: 'routing' }],
      }).success,
    ).toBe(false);
  });
});
