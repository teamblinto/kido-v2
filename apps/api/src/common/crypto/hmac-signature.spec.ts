import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { verifyHmacSignature } from './hmac-signature';

/** Vitest runs with `apps/api` as its working directory; this is the module under test. */
const SOURCE = join(process.cwd(), 'src/common/crypto/hmac-signature.ts');

const SECRET = 'the-apps-webhook-secret';
const RAW = Buffer.from('{"zen":"Design for failure.","hook_id":1}', 'utf8');

/** What the sender computes: `sha256=` and the lower-case hex of the MAC over the exact bytes. */
function sign(raw: Buffer | string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

/**
 * The verifier (spec 026 R10, contracts/webhook.md § 3). TDD is mandatory here: this file lives
 * beside `src/common/crypto/**`, which the constitution holds at 100% statements, branches,
 * functions and lines — so every refusal below is a branch somebody has to have written a test
 * for before the branch exists.
 *
 * The property under test is not "does HMAC work" — `node:crypto` answers that. It is that **every
 * way of being wrong produces the same `false`**: a caller is not entitled to learn whether their
 * signature was absent, misspelled, the wrong length or simply wrong, because each of those is a
 * different amount of progress towards forging one.
 */
describe('verifyHmacSignature', () => {
  it('accepts a signature computed over exactly these bytes with this secret', () => {
    expect(verifyHmacSignature(RAW, sign(RAW), SECRET)).toBe(true);
  });

  it('accepts bytes that a JSON round trip would have changed', () => {
    // The `rawBody` regression in miniature (R8): whitespace and key order survive on the wire and
    // do not survive `JSON.parse` → `JSON.stringify`. The verifier is over bytes, so it must accept
    // the bytes as sent and would refuse the re-serialisation.
    const wire = Buffer.from('{\n  "zed" : 1,\n  "note" : "≠"\n}\n', 'utf8');
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(wire.toString('utf8'))), 'utf8');

    expect(wire.equals(reserialised)).toBe(false);
    expect(verifyHmacSignature(wire, sign(wire), SECRET)).toBe(true);
    expect(verifyHmacSignature(reserialised, sign(wire), SECRET)).toBe(false);
  });

  it('refuses a signature of the right shape over a body changed by one byte', () => {
    // The last byte inside the JSON, changed: same length, same shape, different bytes.
    const tampered = Buffer.concat([RAW.subarray(0, RAW.length - 2), Buffer.from('2}', 'utf8')]);

    expect(tampered).toHaveLength(RAW.length);
    expect(tampered.equals(RAW)).toBe(false);

    expect(verifyHmacSignature(tampered, sign(RAW), SECRET)).toBe(false);
  });

  it('refuses a correct signature computed with a different secret', () => {
    expect(verifyHmacSignature(RAW, sign(RAW, 'someone-elses-secret'), SECRET)).toBe(false);
  });

  /**
   * The `timingSafeEqual` throw path. Node raises a `RangeError` when the two buffers differ in
   * length, so the length check has to come **first** and has to produce the same answer as a
   * mismatch — otherwise a 500 (or a distinguishable refusal) tells the sender their candidate was
   * the wrong size, which is the first thing a forger would like to stop guessing.
   */
  it('answers false rather than throwing when the digest is the wrong length', () => {
    const correct = sign(RAW).slice('sha256='.length);

    expect(correct).toHaveLength(64);
    expect(() =>
      timingSafeEqual(Buffer.from(correct, 'hex'), Buffer.from(correct.slice(0, -2), 'hex')),
    ).toThrow(RangeError);

    expect(verifyHmacSignature(RAW, `sha256=${correct.slice(0, -2)}`, SECRET)).toBe(false);
    expect(verifyHmacSignature(RAW, `sha256=${correct}00`, SECRET)).toBe(false);
    expect(verifyHmacSignature(RAW, 'sha256=', SECRET)).toBe(false);
  });

  it('refuses an equal-length digest that differs in one nibble', () => {
    // Same length, so the length check passes it through to `timingSafeEqual` — this is the case
    // that proves the comparison itself is doing the work, not the length guard standing in for it.
    const correct = sign(RAW).slice('sha256='.length);
    const last = correct.at(-1) ?? '0';
    const flipped = `${correct.slice(0, -1)}${last === '0' ? '1' : '0'}`;

    expect(flipped).toHaveLength(correct.length);
    expect(flipped).not.toBe(correct);
    expect(verifyHmacSignature(RAW, `sha256=${flipped}`, SECRET)).toBe(false);
  });

  it('refuses an absent header', () => {
    expect(verifyHmacSignature(RAW, undefined, SECRET)).toBe(false);
    expect(verifyHmacSignature(RAW, '', SECRET)).toBe(false);
  });

  it.each([
    ['no prefix at all', createHmac('sha256', SECRET).update(RAW).digest('hex')],
    ['the wrong algorithm named', sign(RAW).replace('sha256=', 'sha1=')],
    ['the prefix upper-cased', sign(RAW).replace('sha256=', 'SHA256=')],
    ['a leading space', ` ${sign(RAW)}`],
    ['two signatures joined', `${sign(RAW)},${sign(RAW)}`],
    ['the prefix repeated', `sha256=sha256=${sign(RAW).slice('sha256='.length)}`],
  ])('refuses a malformed header: %s', (_case, header) => {
    expect(verifyHmacSignature(RAW, header, SECRET)).toBe(false);
  });

  it.each([
    ['non-hex characters', `sha256=${'z'.repeat(64)}`],
    ['an odd number of hex digits', `sha256=${'a'.repeat(63)}`],
    ['upper-case hex', sign(RAW).toUpperCase().replace('SHA256=', 'sha256=')],
  ])('refuses a digest that is not lower-case hex of the right width: %s', (_case, header) => {
    // `Buffer.from(…, 'hex')` silently truncates at the first invalid pair rather than throwing,
    // which would turn `'zz…'` into a zero-length buffer and — without the length check — into a
    // `RangeError` from `timingSafeEqual`. Each of these is refused, not raised.
    expect(verifyHmacSignature(RAW, header, SECRET)).toBe(false);
  });

  it('refuses every candidate when the secret is empty, rather than accepting one', () => {
    // An unset secret must not become a verifier that agrees with whoever computed over `''`.
    expect(verifyHmacSignature(RAW, sign(RAW, ''), '')).toBe(false);
    expect(verifyHmacSignature(RAW, sign(RAW), '')).toBe(false);
  });

  it('accepts an empty body signed as an empty body', () => {
    const empty = Buffer.alloc(0);

    expect(verifyHmacSignature(empty, sign(empty), SECRET)).toBe(true);
    expect(verifyHmacSignature(empty, sign(RAW), SECRET)).toBe(false);
  });

  it('knows nothing about GitHub', () => {
    // R10: the next provider brings a header name and a prefix, not a second verifier. The module
    // takes bytes, a header value and a secret — so the word "github" has no business in its source.
    const source = readFileSync(SOURCE, 'utf8').toLowerCase();

    expect(source).not.toContain('github');
    expect(source).not.toContain('x-hub-signature');
  });
});
