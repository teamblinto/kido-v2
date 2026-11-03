import { PROBLEM_TYPES, type ProblemTypeSlug } from './problem-types';

/**
 * The base every thrown domain failure extends. It carries a catalogue slug rather than an HTTP
 * status, so `ProblemDetailsFilter` maps any subclass without a per-error filter and an invented
 * slug fails to compile.
 */
export class DomainError extends Error {
  readonly detail: string;
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly type: ProblemTypeSlug;

  constructor(type: ProblemTypeSlug, detail: string, extensions: Record<string, unknown> = {}) {
    super(detail);
    this.detail = detail;
    this.extensions = Object.freeze({ ...extensions });
    this.name = new.target.name;
    this.type = type;
  }

  get status(): number {
    return PROBLEM_TYPES[this.type].status;
  }

  get title(): string {
    return PROBLEM_TYPES[this.type].title;
  }
}

export class ConflictError extends DomainError {
  constructor(detail: string, extensions?: Record<string, unknown>) {
    super('conflict', detail, extensions);
  }
}

export class ForbiddenError extends DomainError {
  constructor(detail: string, extensions?: Record<string, unknown>) {
    super('forbidden', detail, extensions);
  }
}

export class NotFoundError extends DomainError {
  constructor(detail: string, extensions?: Record<string, unknown>) {
    super('not-found', detail, extensions);
  }
}

export class RateLimitedError extends DomainError {
  readonly retryAfterSeconds: number;

  constructor(detail: string, retryAfterSeconds: number, extensions?: Record<string, unknown>) {
    const seconds = Math.max(0, Math.ceil(retryAfterSeconds));

    super('rate-limited', detail, { ...extensions, retryAfter: seconds });
    this.retryAfterSeconds = seconds;
  }
}

/** The dependency is waking (spec 016 R7: a sandbox resume has been requested); `Retry-After` says when to ask again. */
export class ServiceUnavailableError extends DomainError {
  readonly retryAfterSeconds: number;

  constructor(detail: string, retryAfterSeconds: number, extensions?: Record<string, unknown>) {
    const seconds = Math.max(1, Math.ceil(retryAfterSeconds));

    super('service-unavailable', detail, { ...extensions, retryAfter: seconds });
    this.retryAfterSeconds = seconds;
  }
}
