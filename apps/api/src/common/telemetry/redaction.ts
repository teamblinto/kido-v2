/**
 * The pino path list — the first and cheapest of the three layers that keep secrets out of logs.
 *
 * A path list only catches what someone predicted. It is exact, it costs almost nothing, and it
 * runs before the record is ever serialised, which makes it the right tool for the handful of
 * fields we know by name and position: the request and response headers that carry credentials by
 * definition. It is the wrong tool for everything else, because the field that leaks is the field
 * nobody thought to list.
 *
 * The other two layers live in `./scrubber.ts` and run at the transport, after serialisation:
 * secret-*shaped* values wherever they appear, and secret-*named* keys at any depth under any
 * parent. Those cover the request body, which pino-http's default serialiser does not even put on
 * the record, and every application log the path list was never told about.
 */

/** The single censor string, shared by the path list and the key-name rules so output is uniform. */
export const REDACTION_CENSOR = '[Redacted]';

/**
 * Bracketed entries are pino's syntax for a key that is not a valid identifier; hyphenated header
 * names all need it. pino parses this list when the logger is constructed and throws on a
 * malformed entry, so a typo here fails the process at boot rather than logging in the clear —
 * loud in the right direction, and asserted in the spec against the real parser.
 */
export const REDACTED_PATHS: readonly string[] = [
  // Inbound credential-bearing headers.
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["proxy-authorization"]',
  'req.headers["x-api-key"]',
  'req.headers["x-csrf-token"]',

  // The session cookie on the way back out. `set-cookie` is the one response header that carries a
  // credential, and it is the header a response log would otherwise print in full.
  'res.headers["set-cookie"]',

  // Query strings are serialised by pino-http, so a token that arrives in a verification or reset
  // link is on the record before any application code runs.
  // Spec 041: the one-time Claude sign-in code (`POST /me/subscriptions/claude/code`). pino-http
  // does not serialise bodies, and the scrubber's `code` key rule is the second net; this is the
  // first, by position, should a body ever reach a record.
  'req.body.code',

  'req.query.code',
  'req.query.token',
];
