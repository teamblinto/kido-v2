import { ConflictError } from '../../common/errors/domain-error';

/** The `409 conflict` reasons of contracts/deployments.md, one vocabulary for request and site. */
export type DeployConflictReason =
  'deploy-active' | 'never-deployed' | 'not-deployable' | 'not-releasable' | 'project-archived';

const DETAIL: Record<DeployConflictReason, string> = {
  'deploy-active': 'A deployment of this project is already in progress.',
  'never-deployed': 'This project has never been deployed.',
  'not-deployable': "This project's template does not declare a build.",
  'not-releasable': 'Only a succeeded deployment can be released.',
  'project-archived': 'This project is archived.',
};

/**
 * A refusal before anything is written — a 409 whose `reason` the web panel maps to copy.
 * `deploy-active` carries the in-flight `deploymentId` so the client can follow it.
 */
export function deployConflict(
  reason: DeployConflictReason,
  extensions: { deploymentId?: string } = {},
): ConflictError {
  return new ConflictError(DETAIL[reason], { ...extensions, reason });
}
