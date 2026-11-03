import { describe, expect, it } from 'vitest';

import {
  SESSION_REVOKED,
  revokeSessionResponseSchema,
  sessionListResponseSchema,
  sessionSummarySchema,
} from './session';

const SUMMARY = {
  createdAt: '2026-08-16T10:00:00.000Z',
  fingerprint: 'a2f1c4d7e8b90312a2f1c4d7e8b90312',
  id: '3f1d1f6e-2a1f-4d3c-9a4e-9c2e0d5b7a11',
  ip: '203.0.113.7',
  lastSeenAt: '2026-08-17T09:30:00.000Z',
  userAgent: 'Mozilla/5.0 (Macintosh)',
};

describe('sessionSummarySchema', () => {
  it('accepts the four fields criterion 6 lists, and the id that addresses them', () => {
    expect(sessionSummarySchema.parse(SUMMARY)).toEqual(SUMMARY);
  });

  /**
   * The guarantee this file exists for, written as a contract rather than a review comment.
   *
   * The listing is the one response that enumerates sessions, so it is the one place a token or the
   * hash a session is keyed by could plausibly be added by somebody wiring up a revoke button. It is
   * `strictObject`, so any of these fails to parse here — in a test — rather than turning up in a
   * browser history entry, a client log or a bug report attachment.
   */
  it.each(['token', 'tokenHash', 'sessionId', 'hash', 'secret'])(
    'refuses a %s member outright',
    (member) => {
      expect(sessionSummarySchema.safeParse({ ...SUMMARY, [member]: 'x' }).success).toBe(false);
    },
  );

  /**
   * A uuid, not the session's Redis key. The hash is a server-side identifier — it names the key a
   * session lives under — and handing it to a client makes it a value some later handler is tempted
   * to look a session up by directly.
   */
  it('addresses a session by a uuid rather than by anything derived from its token', () => {
    expect(sessionSummarySchema.safeParse({ ...SUMMARY, id: 'a'.repeat(64) }).success).toBe(false);
  });

  it('requires both timestamps to be instants a client can sort by', () => {
    expect(sessionSummarySchema.safeParse({ ...SUMMARY, createdAt: 'yesterday' }).success).toBe(
      false,
    );
    expect(sessionSummarySchema.safeParse({ ...SUMMARY, lastSeenAt: '' }).success).toBe(false);
  });

  /** `deviceFingerprintOf` answers `unknown` rather than nothing, so no field is ever empty. */
  it.each(['fingerprint', 'ip', 'userAgent'])('requires a non-empty %s', (member) => {
    expect(sessionSummarySchema.safeParse({ ...SUMMARY, [member]: '' }).success).toBe(false);
  });
});

describe('sessionListResponseSchema', () => {
  it('carries the caller’s sessions under one member', () => {
    expect(sessionListResponseSchema.parse({ sessions: [SUMMARY] })).toEqual({
      sessions: [SUMMARY],
    });
  });

  /** A caller whose only session is the one asking still gets a list, never a 404. */
  it('accepts an empty list', () => {
    expect(sessionListResponseSchema.parse({ sessions: [] })).toEqual({ sessions: [] });
  });

  /**
   * No `total`, no `userId`. The list is the caller's own by construction — the endpoint reads the
   * user from the session cookie — and a `userId` member would invite a client to send one back.
   */
  it.each(['total', 'userId', 'currentSessionId'])('refuses a %s member', (member) => {
    expect(sessionListResponseSchema.safeParse({ [member]: 'x', sessions: [] }).success).toBe(
      false,
    );
  });

  it('refuses an entry that is not a summary', () => {
    expect(sessionListResponseSchema.safeParse({ sessions: [{ id: SUMMARY.id }] }).success).toBe(
      false,
    );
  });
});

describe('revokeSessionResponseSchema', () => {
  it('says only that the session is gone', () => {
    expect(revokeSessionResponseSchema.parse({ status: SESSION_REVOKED })).toEqual({
      status: SESSION_REVOKED,
    });
  });

  /**
   * Deliberately no count and no echo of the id. A revoke that reported "0 sessions removed" for an
   * id that is not the caller's would be the existence oracle the 404 exists to avoid, arriving
   * through the success body instead of the status line.
   */
  it.each(['revoked', 'id', 'remaining'])('refuses a %s member', (member) => {
    expect(
      revokeSessionResponseSchema.safeParse({ [member]: 1, status: SESSION_REVOKED }).success,
    ).toBe(false);
  });
});
