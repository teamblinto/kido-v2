import { DomainError } from '../../common/errors/domain-error';
import type { ProblemTypeSlug } from '../../common/errors/problem-types';

/**
 * The preview module's refusals (spec 017). No new problem slug (plan § Constitution Check): each
 * kind maps onto an existing catalogue entry, the way `SandboxGuardError` does, and the `kind`
 * rides in the problem's extensions so a client can tell them apart without a new `type`.
 * `project-not-found` is the id naming nothing live in this tenant — archived included.
 */
export type PreviewErrorKind = 'project-not-found';

const SLUGS: Readonly<Record<PreviewErrorKind, ProblemTypeSlug>> = {
  'project-not-found': 'not-found',
};

export class PreviewError extends DomainError {
  readonly kind: PreviewErrorKind;

  constructor(kind: PreviewErrorKind, detail: string, extensions?: Record<string, unknown>) {
    super(SLUGS[kind], detail, { ...extensions, kind });
    this.kind = kind;
  }
}
