import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Equality for values where losing the comparison must not tell the caller *how close* it was.
 *
 * Recovery codes, session tokens, verification tokens and MFA codes are all guessed one candidate
 * at a time, and `===` on a string returns as soon as two bytes differ. That difference is small,
 * but it is measurable across enough samples, and it turns a search of the whole key space into a
 * search of one character at a time.
 *
 * Both sides are hashed before the comparison rather than compared directly. `timingSafeEqual`
 * requires equal lengths and throws a `RangeError` otherwise, so a direct comparison would answer
 * "wrong length" by crashing — earlier, and far louder, than the `false` a wrong value earns.
 * Digesting first makes every comparison 32 bytes wide whatever went in, so neither the length nor
 * the position of the first difference is observable.
 */
export function bytesMatch(a: Buffer, b: Buffer): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** {@link bytesMatch} for text. Compared as UTF-8 bytes, so two spellings of one glyph differ. */
export function secretsMatch(a: string, b: string): boolean {
  return bytesMatch(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function digest(value: Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}
