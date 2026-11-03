import { describe, expect, it } from 'vitest';

import { signPayload } from './signature';

/** The contract's test vector (contracts/webhook-delivery.md § Signature), pinned here. */
const VECTOR = {
  body: '{"id":"00000000-0000-0000-0000-000000000000","type":"ping"}',
  secret: 'whsec_dGVzdC1zZWNyZXQtZm9yLWRvY3M',
  t: 1790000000,
  v1: 'f2e4f1f25d93fe6ef14e719bdfba115887323d2217a282dadcb8dfc158463d27',
} as const;

const OTHER_SECRET = 'whsec_b3RoZXItc2VjcmV0LWZvci10ZXN0cw';

describe('signPayload', () => {
  it('matches the pinned contract test vector', () => {
    expect(signPayload([VECTOR.secret], VECTOR.t, VECTOR.body)).toBe(
      `t=${VECTOR.t},v1=${VECTOR.v1}`,
    );
  });

  it('two secrets produce two v1 values, newest first', () => {
    const header = signPayload([OTHER_SECRET, VECTOR.secret], VECTOR.t, VECTOR.body);
    const values = header.split(',').slice(1);
    expect(values).toHaveLength(2);
    expect(values[0]).toBe(signPayload([OTHER_SECRET], VECTOR.t, VECTOR.body).split(',')[1]);
    expect(values[1]).toBe(`v1=${VECTOR.v1}`);
  });

  it('changing one byte of the body changes the signature', () => {
    const changed = VECTOR.body.replace('ping', 'pinG');
    expect(signPayload([VECTOR.secret], VECTOR.t, changed)).not.toBe(
      signPayload([VECTOR.secret], VECTOR.t, VECTOR.body),
    );
  });

  it('changing the timestamp changes the signature', () => {
    expect(signPayload([VECTOR.secret], VECTOR.t + 1, VECTOR.body).split(',')[1]).not.toBe(
      `v1=${VECTOR.v1}`,
    );
  });

  it('the header matches t=<digits>(,v1=<64 hex>)+', () => {
    expect(signPayload([OTHER_SECRET, VECTOR.secret], VECTOR.t, VECTOR.body)).toMatch(
      /^t=\d+(,v1=[0-9a-f]{64})+$/,
    );
  });

  it('refuses to sign with no secret', () => {
    expect(() => signPayload([], VECTOR.t, VECTOR.body)).toThrow();
  });
});
