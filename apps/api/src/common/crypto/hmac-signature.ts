import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The header shape this verifies: the algorithm, `=`, and the MAC as lower-case hex.
 *
 * The width is deliberately **not** pinned here. Pinning it would fold the length check into the
 * parse, and the length check has to be its own step so that a candidate of the wrong size earns
 * exactly the `false` a candidate of the wrong value earns — see the comment on the check below.
 * Upper-case hex and a leading or trailing space are refused rather than normalised: a sender that
 * cannot spell the header it computed is not a sender worth guessing on behalf of.
 */
const SIGNATURE = /^sha256=([0-9a-f]+)$/;

/**
 * Was `header` computed over exactly `raw` with `secret`? (spec 026 research R10.)
 *
 * This is a primitive, not a provider integration. It takes bytes, a header value and a secret,
 * and knows nothing about who sent them — the next provider brings a header *name* and its own
 * prefix, not a second copy of this function. It lives under `src/common/crypto/**` so the
 * constitution's 100% statement/branch/function/line floor binds it, and it was written test-first.
 *
 * `raw` must be the bytes as received (`request.rawBody`), never a re-serialisation of the parsed
 * body: a JSON round trip changes whitespace and key order, and an HMAC over the result fails with
 * no signal beyond a refusal. The factory flag that keeps those bytes is `rawBody: true` in
 * `main.ts` (ADR 049).
 *
 * **Every failure is the same `false`.** Absent, malformed, wrong length, wrong value, wrong
 * secret: the caller learns only that it did not verify. Which check refused is a measure of how
 * close a forgery got, and the sender is not entitled to it.
 */
export function verifyHmacSignature(
  raw: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (header === undefined) return false;

  const digest = SIGNATURE.exec(header)?.[1];

  if (digest === undefined) return false;

  // An unset secret must not become a verifier that agrees with whoever computed over `''`.
  // `createHmac` accepts an empty key perfectly happily, which is exactly the problem.
  if (secret.length === 0) return false;

  // `Buffer.from(…, 'hex')` truncates at the first pair it cannot read instead of throwing, so an
  // odd digit count silently yields a short buffer — one more reason the length is checked and not
  // assumed.
  const candidate = Buffer.from(digest, 'hex');
  const expected = createHmac('sha256', secret).update(raw).digest();

  // Before `timingSafeEqual`, which throws a `RangeError` on unequal lengths. If that throw were
  // allowed to happen, "wrong length" would answer with an exception — earlier, louder and
  // distinguishable from the plain `false` a wrong value earns, which makes the length of a forged
  // signature observable. Same answer, both ways.
  if (candidate.length !== expected.length) return false;

  return timingSafeEqual(candidate, expected);
}
