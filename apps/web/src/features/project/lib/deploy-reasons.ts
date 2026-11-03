import type { DeploymentFailureReason } from '@repo/contracts';

/** The `reason` a `409 conflict` carries on the deploy and site routes (contracts/deployments.md). */
export type DeployRefusalReason =
  'deploy-active' | 'never-deployed' | 'not-deployable' | 'not-releasable' | 'project-archived';

/**
 * Every reason the contract names, as copy: the five refusal reasons and the seven ways a build
 * can fail. Local to the deploy panel on purpose, the `github-panel.tsx` pattern: no slug is
 * added, so no `MESSAGES` entry is either. It sits in its own module only so that the panel's
 * file exports components alone.
 */
export const REASON_COPY: Record<DeploymentFailureReason | DeployRefusalReason, string> = {
  'build-failed': 'The build command failed. Open the log to see why.',
  'deploy-active': 'A deploy is already in progress. Wait for it to finish.',
  'install-failed': 'Installing the project’s dependencies failed. Open the log to see why.',
  'never-deployed': 'This project has never been deployed, so there is no site to take offline.',
  'no-output': 'The build finished but produced no files to publish.',
  'not-authorised':
    'The build finished, but whoever asked for it may no longer deploy, so it was not made live. Someone who can deploy may roll back to it.',
  'not-deployable': 'This project’s template has no static build, so it cannot be deployed here.',
  'not-releasable': 'Only a deploy that succeeded can be made live.',
  'output-too-large': 'The build produced more than a site may publish.',
  platform: 'Something went wrong on our side. Try deploying again.',
  'project-archived': 'This project is archived. Restore it to deploy.',
  timeout: 'The build took longer than it is allowed to and was stopped.',
};
