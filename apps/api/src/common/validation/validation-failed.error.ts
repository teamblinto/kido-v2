import type { ValidationIssue } from '@repo/contracts';

import { DomainError } from '../errors/domain-error';

/** The `ArgumentMetadata.type` values Nest hands a pipe. */
export type ValidationSource = 'body' | 'custom' | 'param' | 'query';

const SOURCE_LABELS: Readonly<Record<ValidationSource, string>> = {
  body: 'body',
  custom: 'input',
  param: 'path parameters',
  query: 'query parameters',
};

/**
 * A rejected request, as a domain error. It exists so the pipe never builds a response body: it
 * throws this, `ProblemDetailsFilter` maps it through the frozen catalogue, and the `errors`
 * extension carries one entry per rejected field.
 *
 * The catalogue puts `validation-failed` at 422 rather than 400 — see ADR 006. The short version is
 * that 400 already belongs to `bad-request`, and `problemTypeForStatus` is only unambiguous because
 * no two slugs share a status.
 */
export class ValidationFailedError extends DomainError {
  readonly issues: readonly ValidationIssue[];

  constructor(source: ValidationSource, issues: readonly ValidationIssue[]) {
    super('validation-failed', `The request ${SOURCE_LABELS[source]} failed validation.`, {
      errors: [...issues],
    });
    this.issues = Object.freeze([...issues]);
  }
}
