import { createHash } from 'node:crypto';

export interface FingerprintInput {
  /** The parsed request body. `undefined` — no body, or no parser matched — reads as `{}`. */
  readonly body?: unknown;
  readonly method: string;
  /** The request target, path and query, because both decide which request this is. */
  readonly target: string;
}

/**
 * The "hash of the body" half of §14's `Idempotency-Key` rule, widened to the whole request.
 *
 * It covers the method and the target as well as the body, so that one key cannot address two
 * endpoints. A key reused across routes is the same class of client bug as a key reused with a
 * different body, and it has to reach the same 409 — keying only on the body would instead open a
 * second slot per route, and the second route would execute.
 *
 * The body is hashed through a **canonical** serialisation rather than through its raw bytes.
 * Object keys are sorted at every depth, so a client whose JSON encoder reorders a map between the
 * first attempt and the retry still replays instead of being told its key was reused. Array order
 * is preserved, because `[a, b]` and `[b, a]` are two different requests.
 */
export function fingerprintRequest(input: FingerprintInput): string {
  const body = input.body === undefined ? {} : input.body;

  return createHash('sha256')
    .update(`${input.method}\n${input.target}\n${canonicalJson(body)}`)
    .digest('hex');
}

/**
 * `JSON.stringify` with a deterministic key order. Written out rather than passed as a replacer
 * because a replacer cannot reorder keys — it only sees them in the order the object already has.
 *
 * A parsed JSON body is a finite tree of objects, arrays and primitives, so there is no cycle to
 * guard against and no `Date`, `Map` or `BigInt` to serialise: whatever reaches this function came
 * out of `JSON.parse`.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      // Code-unit order, not `localeCompare`: the digest must not depend on the node's locale.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }

  // `undefined` only reaches here from an array hole, which JSON renders as `null` too.
  return JSON.stringify(value) ?? 'null';
}
