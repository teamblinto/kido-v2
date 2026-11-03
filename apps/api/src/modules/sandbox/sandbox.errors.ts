import { DomainError } from '../../common/errors/domain-error';
import type { ProblemTypeSlug } from '../../common/errors/problem-types';

/**
 * Every §04 refusal the port can make (spec 010, data-model.md). `sandbox-not-ready` (spec 014) is
 * the row existing but its sandbox still coming up — a conflict to retry, not a missing thing.
 */
export type SandboxGuardKind =
  | 'path-escape'
  | 'path-not-found'
  | 'not-a-file'
  | 'file-too-large'
  | 'bundle-too-large'
  | 'path-outside-git'
  | 'anchor-not-found'
  | 'anchor-ambiguous'
  | 'command-not-allowed'
  | 'missing-mutation-context'
  | 'no-sandbox'
  | 'sandbox-not-ready';

/**
 * No route throws these, so the slug never reaches HTTP in this spec; it is here because
 * `DomainError` needs one and because a later route would want the obvious mapping rather than
 * a new catalogue entry.
 */
const GUARD_SLUGS: Readonly<Record<SandboxGuardKind, ProblemTypeSlug>> = {
  'anchor-ambiguous': 'bad-request',
  'anchor-not-found': 'bad-request',
  'bundle-too-large': 'payload-too-large',
  'command-not-allowed': 'bad-request',
  'file-too-large': 'payload-too-large',
  'missing-mutation-context': 'bad-request',
  'no-sandbox': 'not-found',
  'not-a-file': 'bad-request',
  'path-escape': 'bad-request',
  'path-not-found': 'not-found',
  'path-outside-git': 'bad-request',
  'sandbox-not-ready': 'conflict',
};

/** A guard said no before any mutating request was built. `kind` is what 011's broker reports. */
export class SandboxGuardError extends DomainError {
  readonly kind: SandboxGuardKind;

  constructor(kind: SandboxGuardKind, detail: string, extensions?: Record<string, unknown>) {
    super(GUARD_SLUGS[kind], detail, { ...extensions, kind });
    this.kind = kind;
  }
}

/**
 * The seven failure classes of research R3 (spec 010), plus the two snapshot answers of spec 015
 * (contract § 6): `snapshot-busy` is a `409` on `DELETE /api/snapshots/{name}` — in use or already
 * removing, try again on the next pass; `snapshot-forbidden` is the `403` that means the key was
 * minted without `delete:snapshots`, which no retry fixes.
 */
export type DaytonaErrorKind =
  | 'not-configured'
  | 'unreachable'
  | 'unauthorised'
  | 'sandbox-not-found'
  | 'sandbox-not-running'
  | 'snapshot-busy'
  | 'snapshot-forbidden'
  | 'upstream'
  | 'malformed';

/** Only a network failure, a 5xx and a busy snapshot are worth trying again; the rest needs a person. */
const RETRYABLE: ReadonlySet<DaytonaErrorKind> = new Set([
  'snapshot-busy',
  'unreachable',
  'upstream',
]);

/**
 * The wire failed. Not a `DomainError`: it is never a caller's fault and never an HTTP answer
 * here — 011 turns it into a `tool.end` error payload and reads `retryable` to decide whether to
 * try again. `message` carries no key, no URL with the key, and no body.
 */
export class DaytonaError extends Error {
  readonly kind: DaytonaErrorKind;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(kind: DaytonaErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'DaytonaError';
    this.kind = kind;
    this.retryable = RETRYABLE.has(kind);
    this.status = status;
  }
}
