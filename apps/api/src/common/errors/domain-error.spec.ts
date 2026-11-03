import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
} from './domain-error';

describe('DomainError', () => {
  it('derives status and title from the catalogue slug', () => {
    const error = new DomainError('conflict', 'That email address is already registered.');

    expect(error).toBeInstanceOf(Error);
    expect(error.detail).toBe('That email address is already registered.');
    expect(error.message).toBe('That email address is already registered.');
    expect(error.name).toBe('DomainError');
    expect(error.status).toBe(409);
    expect(error.title).toBe('Conflict');
    expect(error.type).toBe('conflict');
  });

  it('names itself after the concrete subclass so logs identify the failure', () => {
    class EmailAlreadyVerifiedError extends ConflictError {}

    expect(new EmailAlreadyVerifiedError('Already verified.').name).toBe(
      'EmailAlreadyVerifiedError',
    );
  });

  it('freezes extension members so a caller cannot mutate them after the throw', () => {
    const error = new DomainError('conflict', 'Taken.', { field: 'email' });

    expect(error.extensions).toStrictEqual({ field: 'email' });
    expect(Object.isFrozen(error.extensions)).toBe(true);
  });

  it('makes an uncatalogued slug a compile-time error rather than a runtime surprise', () => {
    class MisfiledError extends DomainError {
      constructor() {
        // @ts-expect-error 'invented-slug' is not a member of the frozen problem type catalogue.
        super('invented-slug', 'Nothing maps this.');
      }
    }

    expect(MisfiledError.name).toBe('MisfiledError');
  });
});

describe('domain error subclasses', () => {
  it('maps NotFoundError to 404 without a per-error filter', () => {
    const error = new NotFoundError('No such workspace.');

    expect(error).toBeInstanceOf(DomainError);
    expect(error.status).toBe(404);
    expect(error.type).toBe('not-found');
  });

  it('maps ConflictError to 409', () => {
    const error = new ConflictError('Already exists.');

    expect(error.status).toBe(409);
    expect(error.type).toBe('conflict');
  });

  it('maps ForbiddenError to 403', () => {
    const error = new ForbiddenError('Not permitted.');

    expect(error.status).toBe(403);
    expect(error.type).toBe('forbidden');
  });

  it('maps RateLimitedError to 429 and carries Retry-After', () => {
    const error = new RateLimitedError('Slow down.', 30);

    expect(error.extensions).toStrictEqual({ retryAfter: 30 });
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.status).toBe(429);
    expect(error.type).toBe('rate-limited');
  });

  it('rounds a fractional Retry-After up to whole seconds', () => {
    expect(new RateLimitedError('Slow down.', 0.4).retryAfterSeconds).toBe(1);
    expect(new RateLimitedError('Slow down.', 12.1).retryAfterSeconds).toBe(13);
  });
});
