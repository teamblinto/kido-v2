import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { fingerprintRequest } from './idempotency.fingerprint';

const TARGET = '/api/v1/orgs/9d8c/invitations';

describe('fingerprintRequest', () => {
  it('produces a sha-256 hex digest, so the stored record is a fixed width', () => {
    expect(fingerprintRequest({ body: { a: 1 }, method: 'POST', target: TARGET })).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  /**
   * The comparison is "is this the same request?", and two JSON objects that differ only in the
   * order their keys were serialised are the same request. Hashing the raw bytes would answer 409
   * to a client whose HTTP library reordered a map between the first attempt and the retry — which
   * is the exact case the interceptor exists to make safe.
   */
  it('is insensitive to the order of object keys, at every depth', () => {
    const one = fingerprintRequest({
      body: { email: 'a@example.com', role: { grants: ['read'], name: 'member' } },
      method: 'POST',
      target: TARGET,
    });
    const other = fingerprintRequest({
      body: { role: { name: 'member', grants: ['read'] }, email: 'a@example.com' },
      method: 'POST',
      target: TARGET,
    });

    expect(one).toBe(other);
  });

  /** Arrays are ordered by definition: `[a, b]` and `[b, a]` are two different request bodies. */
  it('is sensitive to the order of array elements', () => {
    const one = fingerprintRequest({ body: { ids: ['a', 'b'] }, method: 'POST', target: TARGET });
    const other = fingerprintRequest({ body: { ids: ['b', 'a'] }, method: 'POST', target: TARGET });

    expect(one).not.toBe(other);
  });

  it('changes when any value in the body changes', () => {
    const one = fingerprintRequest({ body: { seats: 1 }, method: 'POST', target: TARGET });
    const other = fingerprintRequest({ body: { seats: 2 }, method: 'POST', target: TARGET });

    expect(one).not.toBe(other);
  });

  /**
   * A key reused across two endpoints is a client bug of the same kind as a key reused with a
   * different body, and has to reach the same 409 rather than open a second slot that executes.
   */
  it('changes when the method or the target changes, so one key cannot span two endpoints', () => {
    const post = fingerprintRequest({ body: {}, method: 'POST', target: TARGET });

    expect(fingerprintRequest({ body: {}, method: 'PUT', target: TARGET })).not.toBe(post);
    expect(fingerprintRequest({ body: {}, method: 'POST', target: '/api/v1/orgs' })).not.toBe(post);
  });

  /**
   * A body-less `DELETE` retried is the commonest replay of all, and Express hands the interceptor
   * `{}` or `undefined` for it depending on whether a parser matched the content type. The two must
   * not be two different requests.
   */
  it('treats an absent body and an empty one as the same request', () => {
    const absent = fingerprintRequest({ method: 'DELETE', target: TARGET });
    const empty = fingerprintRequest({ body: {}, method: 'DELETE', target: TARGET });

    expect(absent).toBe(empty);
  });

  it('separates a null body from an absent one, because null is a value the handler sees', () => {
    expect(fingerprintRequest({ body: null, method: 'POST', target: TARGET })).not.toBe(
      fingerprintRequest({ method: 'POST', target: TARGET }),
    );
  });

  /**
   * The canonical form is spelled out here rather than obtained from the function, so the test
   * fails if the serialisation changes shape — an assertion that only compared two calls to
   * `fingerprintRequest` would still pass if the digest were a constant.
   */
  it('hashes a canonical serialisation this test spells out in full', () => {
    const expected = createHash('sha256').update('POST\n/t\n{"a":1,"b":2}').digest('hex');

    expect(fingerprintRequest({ body: { b: 2, a: 1 }, method: 'POST', target: '/t' })).toBe(
      expected,
    );
  });
});
