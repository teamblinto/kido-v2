import { Writable } from 'node:stream';

import { REDACTION_CENSOR } from './redaction';

/**
 * The value-shaped scrubber, applied at the transport rather than at the call site.
 *
 * The path list in `./redaction.ts` catches secrets in fields somebody predicted. This catches the
 * ones nobody did, by looking at what a value *is* rather than where it sits: a string that starts
 * `sk-` is a provider key wherever it turns up, including inside a message someone interpolated,
 * an error stack a library threw, or an object five levels down that no path could name.
 *
 * Two families run here:
 *
 * 1. **Value shapes** — formats that identify themselves. Provider keys, GitHub tokens, JWTs, PEM
 *    blocks, password hashes, `__Host-` cookies, connection-string credentials, TOTP seeds.
 * 2. **Key names** — a password is just a string and has no shape at all, so those are caught by
 *    the name of the field holding them, at any depth, under any parent.
 *
 * Placing this at the transport is the whole point. A call-site helper protects the calls that
 * remember to use it; a transport stream protects every byte that leaves the process, including
 * the logging a dependency does on its own behalf. §05: assume anything which *can* be logged
 * eventually will be.
 */

export interface SecretShape {
  /** Names the rule that fired; it is written into the censored output to keep logs debuggable. */
  readonly name: string;
  readonly pattern: RegExp;
  /** May reference capture groups, which is how a cookie keeps its name and loses its value. */
  readonly replacement: string;
}

function censor(name: string): string {
  return `[Redacted:${name}]`;
}

/**
 * Order matters. The full PEM block runs before the truncated-header rule so a complete key is
 * matched as one unit, and the cookie rule runs before the formats a cookie value might itself
 * have so the cookie's name survives in the log.
 *
 * Every threshold is deliberately below the real length of the credential it matches. Matching
 * too much costs a line of readability; matching too little costs a key.
 */
export const SECRET_SHAPES: readonly SecretShape[] = [
  {
    name: 'pem',
    pattern: /-----BEGIN [A-Z0-9 ]{0,40}-----[\s\S]*?-----END [A-Z0-9 ]{0,40}-----/g,
    replacement: censor('pem'),
  },
  {
    // A key whose footer was cut off by a truncating log pipeline is still a key.
    name: 'pem',
    pattern: /-----BEGIN [A-Z0-9 ]{0,40}-----(?:\\n|\s)*[A-Za-z0-9+/=]{16,}/g,
    replacement: censor('pem'),
  },
  {
    name: 'cookie',
    pattern: /(__(?:Host|Secure)-[A-Za-z0-9_.-]+=)[^;,\s"\\]+/g,
    replacement: `$1${censor('cookie')}`,
  },
  {
    name: 'bearer',
    pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: `$1 ${censor('bearer')}`,
  },
  {
    name: 'url-credential',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/"\\]+:)[^\s@/"\\]+@/gi,
    replacement: `$1${censor('url-credential')}@`,
  },
  {
    /**
     * Credentials that travel in a URL: verification and reset links, OAuth `code` and
     * `access_token`, TOTP seeds in an `otpauth://` URI.
     *
     * `req.query` is redacted by path, but pino-http logs `req.url` too and the raw query string
     * is still in it — which is how a reset link reaches a log file with the path list working
     * exactly as designed. Redacting the whole URL would cost the route and the status every log
     * is read for, so the parameter name decides and the rest of the line survives.
     */
    name: 'query-credential',
    pattern:
      /([?&#][a-z0-9_.-]*(?:token|secret|code|password|passwd|key|credential|session|otp|seed)[a-z0-9_.-]*=)[^&\s"'\\]+/gi,
    replacement: `$1${censor('query-credential')}`,
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
    replacement: censor('jwt'),
  },
  {
    name: 'password-hash',
    pattern:
      /\$(?:argon2(?:id|i|d)?|2[abxy]?|scrypt|pbkdf2(?:-sha\d+)?)\$[A-Za-z0-9+/=$,.:_-]{8,}/g,
    replacement: censor('password-hash'),
  },
  {
    name: 'provider-key',
    pattern: /\bsk-[A-Za-z0-9_-]{8,}|\bsk_(?:live|test)_[A-Za-z0-9]{8,}/g,
    replacement: censor('provider-key'),
  },
  {
    name: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    replacement: censor('github-token'),
  },
  {
    name: 'aws-key',
    pattern: /\b(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{12,}/g,
    replacement: censor('aws-key'),
  },
  {
    name: 'slack-token',
    pattern: /\bxox[abporsu]-[A-Za-z0-9-]{8,}/g,
    replacement: censor('slack-token'),
  },
  {
    // Daytona API keys (spec 010): `dtn_` + 64 hex. The adapter never logs it; this is the net
    // under a dependency that does.
    name: 'daytona-key',
    pattern: /\bdtn_[A-Za-z0-9]{16,}/g,
    replacement: censor('daytona-key'),
  },
  // Spec 030 R16: the connector providers' credentials, the net under an adapter that never logs
  // them. Postgres URIs with a password are `url-credential`'s already.
  {
    name: 'resend-key',
    pattern: /\bre_[A-Za-z0-9_]{16,}/g,
    replacement: censor('resend-key'),
  },
  {
    name: 'supabase-key',
    pattern: /\bsb_(?:publishable|secret)_[A-Za-z0-9_-]{16,}/g,
    replacement: censor('supabase-key'),
  },
  {
    // verify (R16): the `nfp_` prefix on a real personal access token.
    name: 'netlify-token',
    pattern: /\bnfp_[A-Za-z0-9]{20,}/g,
    replacement: censor('netlify-token'),
  },
  {
    // Spec 040: a paired companion's device token, `bld_` + 43 base64url characters.
    name: 'local-agent-token',
    pattern: /\bbld_[A-Za-z0-9_-]{16,}/g,
    replacement: censor('local-agent-token'),
  },
  {
    // Spec 040: a pairing code approves a device for ten minutes, and the preview route carries it
    // in its path (`/me/local-agents/pairings/:userCode`), which pino-http logs as `req.url` — out
    // of reach of `query-credential`. The two fixed siblings (`approve`, `deny`) are not codes.
    name: 'local-agent-pairing-code',
    pattern: /(\/local-agents\/pairings\/)(?!approve\b|deny\b|\[)[^/?#\s"'\\]+/gi,
    replacement: `$1${censor('local-agent-pairing-code')}`,
  },
  {
    // verify (R16): Neon documents no prefix; current keys carry `napi_`. An unprefixed key in an
    // `apiKey` / `token` field is still caught by the key-name rule.
    name: 'neon-key',
    pattern: /\bnapi_[A-Za-z0-9]{16,}/g,
    replacement: censor('neon-key'),
  },
];

/**
 * Field names whose value is a secret regardless of what it looks like.
 *
 * Matched as a substring of the key, case-insensitively, so `newPassword`, `session_token` and
 * `totpSecret` are all covered without enumerating them. `dek` and `kek` are anchored because
 * three letters that short appear inside ordinary words.
 *
 * This is the rule that covers §11's "never log a password, session token, DEK, MFA seed or reset
 * token, even at trace" for fields nobody added to the path list. Spec 032 R15 adds the OAuth
 * link-flow fields: `code` (anchored — `statusCode` is not a secret — and not when its value
 * is an error code, see `ERROR_CODE_VALUE`), `codeVerifier` and `deviceCode`; `accessToken`, `refreshToken` and `idToken` were already `token`'s. Spec 040 adds
 * `userCode`, a pairing code (`params.userCode`, the approve and deny bodies). Only string values are censored:
 * a `tokenCount` of 512 is a number, and blanking it would cost a metric to protect nothing.
 */
const SECRET_KEY_NAME =
  /pass(?:word|phrase|wd)|secret|token|api[_-]?key|private[_-]?key|credential|authoriz|cookie|session|seed|recovery[_-]?code|otp|mfa|^[dk]ek$|^code$|code[_-]?verifier|device[_-]?code|user[_-]?code/i;

/** Every value shape, applied to one string. Safe to run twice: the censored output matches nothing. */
export function scrubSecrets(text: string): string {
  let scrubbed = text;

  for (const shape of SECRET_SHAPES) {
    scrubbed = scrubbed.replace(shape.pattern, shape.replacement);
  }

  return scrubbed;
}

/**
 * The values a bare `code` field holds when it is an error code rather than an OAuth credential:
 * a Postgres SQLSTATE (`23505`, `40P01`), a Node errno (`ECONNREFUSED`, `EAI_AGAIN`), a Node
 * internal code (`ERR_INVALID_ARG_TYPE`) or a short number. Spec 032 R15 made `code` a secret key
 * name, which on its own also blanked `err.code` on every pg and socket error and cost the one
 * field an operator reads first. An authorisation code has none of these shapes — it is long and
 * mixed-case or carries punctuation — so exempting them keeps every credential censored.
 */
const ERROR_CODE_VALUE = /^(?:[0-9A-Z]{5}|E[A-Z_]{3,24}|ERR_[A-Z0-9_]{1,60}|\d{1,5})$/;

function isSecretKey(key: string, item: unknown): boolean {
  if (!SECRET_KEY_NAME.test(key)) return false;
  return !(/^code$/i.test(key) && typeof item === 'string' && ERROR_CODE_VALUE.test(item));
}

/**
 * Spec 040: Express 5's `*splat` param — `req.params.splat` on every pino-http record — is the path
 * split into segments, so `local-agent-pairing-code` never sees `pairings/<code>` in one string.
 * The segment after `local-agents`, `pairings` is the code, bar the two fixed routes.
 */
function isPairingCodeSegment(items: readonly unknown[], index: number): boolean {
  const item = items[index];

  return (
    typeof item === 'string' &&
    index >= 2 &&
    /^local-agents$/i.test(String(items[index - 2])) &&
    /^pairings$/i.test(String(items[index - 1])) &&
    !/^(?:approve|deny)$/i.test(item)
  );
}

function scrubValue(value: unknown, inheritedSecret: boolean): unknown {
  if (typeof value === 'string') {
    return inheritedSecret ? REDACTION_CENSOR : scrubSecrets(value);
  }

  if (Array.isArray(value)) {
    const items = value as unknown[];

    return items.map((item, index) =>
      isPairingCodeSegment(items, index)
        ? censor('local-agent-pairing-code')
        : scrubValue(item, inheritedSecret),
    );
  }

  if (typeof value === 'object' && value !== null) {
    const scrubbed: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(value)) {
      scrubbed[key] = scrubValue(item, inheritedSecret || isSecretKey(key, item));
    }

    return scrubbed;
  }

  return value;
}

/**
 * One serialised log record, scrubbed by both families.
 *
 * The line is parsed so key names are visible as keys rather than as text that happens to sit
 * before a colon, which is what lets the name rules reach arbitrary depth and handle arrays of
 * recovery codes correctly. The parse-and-restringify costs a few microseconds per record; a
 * cheaper pre-scan was considered and rejected, because a fast path that disagrees with the slow
 * path in one case is a leak, and this is a security control before it is a formatter.
 *
 * Anything that is not JSON — a pretty-printed line, a half-written record from a serialiser that
 * threw — falls back to the string rules rather than throwing. A logger that crashes is a logger
 * somebody switches off.
 */
export function scrubLogLine(line: string): string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return scrubSecrets(line);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return scrubSecrets(line);
  }

  return JSON.stringify(scrubValue(parsed, false));
}

/**
 * A destination that scrubs whole records on their way to `inner`.
 *
 * A `Writable` may be handed a chunk that ends mid-record, so the stream buffers to the newline
 * pino terminates every record with. Scrubbing each chunk as it arrives would let the two halves
 * of a key through separately and rejoin them in the file.
 */
export function createScrubbingDestination(
  inner: NodeJS.WritableStream = process.stdout,
): Writable {
  let pending = '';

  const forward = (line: string): void => {
    inner.write(`${scrubLogLine(line)}\n`);
  };

  return new Writable({
    decodeStrings: false,
    final(callback) {
      if (pending.length > 0) {
        forward(pending);
        pending = '';
      }

      callback();
    },
    write(chunk: unknown, _encoding, callback) {
      pending += typeof chunk === 'string' ? chunk : String(chunk);

      for (let newline = pending.indexOf('\n'); newline !== -1; newline = pending.indexOf('\n')) {
        forward(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }

      callback();
    },
  });
}

/**
 * The API's log destination: the scrubber, wrapping whatever finally renders the line.
 *
 * pino refuses a `transport` and a stream together, so development pretty-printing is obtained as
 * a stream and placed *behind* the scrubber — the scrubber sees raw NDJSON, which is the form its
 * rules are written for, and pretty-printing only ever renders text that is already clean. The
 * import stays dynamic so `pino-pretty`, a devDependency, is loaded only on the branch that needs
 * it and a production install never looks for it.
 */
export async function createLogDestination(options: {
  /** Where the rendered line finally lands. Defaults to stdout; a file or a test sink also works. */
  readonly sink?: NodeJS.WritableStream;
  readonly pretty: boolean;
}): Promise<Writable> {
  const sink = options.sink ?? process.stdout;

  if (!options.pretty) {
    return createScrubbingDestination(sink);
  }

  const { default: pretty } = await import('pino-pretty');

  return createScrubbingDestination(
    pretty({ colorize: true, destination: sink, singleLine: true }),
  );
}
