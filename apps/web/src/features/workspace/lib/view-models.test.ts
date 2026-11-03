import { describe, expect, it } from 'vitest';

import { describeAge, toWorkspaceSummary } from './view-models';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');

function iso(offsetMs: number): string {
  return new Date(NOW - offsetMs).toISOString();
}

describe('describeAge', () => {
  it.each([
    [30_000, 'Created 1 minute ago'],
    [5 * 60_000, 'Created 5 minutes ago'],
    [60 * 60_000, 'Created 1 hour ago'],
    [5 * 60 * 60_000, 'Created 5 hours ago'],
    [24 * 60 * 60_000, 'Created yesterday'],
    [3 * 24 * 60 * 60_000, 'Created 3 days ago'],
  ])('describes %dms ago as "%s"', (offset, expected) => {
    expect(describeAge(iso(offset), NOW)).toBe(expected);
  });

  it('never says a project was created in the future', () => {
    // Clock skew between the server that stamped the row and the browser reading it is ordinary,
    // and "Created -1 minutes ago" is the kind of thing that reaches production.
    expect(describeAge(iso(-60_000), NOW)).toBe('Created recently');
  });

  it('degrades rather than throwing on a timestamp it cannot read', () => {
    expect(describeAge('not a date', NOW)).toBe('Created recently');
  });
});

describe('toWorkspaceSummary', () => {
  const org = {
    access: 'member',
    createdAt: iso(0),
    id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    name: 'Blinto',
    plan: 'free',
    role: 'owner',
    slug: 'blinto',
  } as const;

  it('shows a seat count when the caller may read the member list', () => {
    expect(toWorkspaceSummary(org, 3).seats).toBe('3 members');
  });

  it('singularises a one-person organisation', () => {
    expect(toWorkspaceSummary(org, 1).seats).toBe('1 member');
  });

  it('falls back to the role when members are not readable', () => {
    // `org:members.read` is not a permission every role holds. A member who simply cannot see the
    // list should read as restricted, not as broken.
    expect(toWorkspaceSummary(org, undefined).seats).toBe('You are an owner');
  });

  it('picks the article from the role, not from a guess', () => {
    expect(toWorkspaceSummary({ ...org, role: 'member' }, undefined).seats).toBe(
      'You are a member',
    );
  });
});
