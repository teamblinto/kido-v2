import {
  cursorSchema,
  type Deployment,
  type DeploymentState,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
} from '@repo/contracts';
import { z } from 'zod';

import { type McpToolKit, type ToolCall, ToolError } from '../tool-kit';
import { idempotencyKey, projectId, waitSeconds } from './inputs';

const deploymentId = z
  .uuid()
  .describe('The deployment id, from deploy_project or list_deployments.');

/** Enough of a build log to show the error without flooding the model's context. */
const LOG_TAIL_CHARS = 8_000;

const FINISHED: ReadonlySet<DeploymentState> = new Set(['cancelled', 'failed', 'succeeded']);

const NEXT_STEP: Readonly<Record<DeploymentState, string>> = {
  building: 'Building. Call get_deployment with waitSeconds to follow it.',
  cancelled: 'The deployment was cancelled. Start a new one with deploy_project if needed.',
  failed:
    'The build failed: read failureReason and buildLog, fix the cause (e.g. with start_agent_run, quoting the error), then deploy_project again.',
  queued: 'Waiting for a builder. Call get_deployment with waitSeconds to follow it.',
  succeeded: 'Live. The site URL is in site.url; share it with the person.',
  uploading: 'Uploading the built files. Call get_deployment with waitSeconds to follow it.',
};

/** Deploying: building a checkpoint into a static site and choosing which build is live. */
export function registerDeployTools(kit: McpToolKit): void {
  kit.tool(
    'deploy_project',
    {
      description:
        'Build the project and publish it to its live site URL. Deploys the latest checkpoint unless you name one. Pass waitSeconds (e.g. 50) to wait for the build: a success answers with the live URL, a failure with the end of the build log so you can fix the error and deploy again. If it is still building when the wait ends, follow it with get_deployment.',
      input: z.object({
        checkpointId: z
          .uuid()
          .optional()
          .describe(
            'Optional. The checkpoint to deploy, from list_checkpoints; defaults to the latest.',
          ),
        // Required, as on the HTTP route: a keyless retry would queue a second build.
        idempotencyKey: idempotencyKey
          .unwrap()
          .describe(
            'Any unique string (8–100 of A-Z a-z 0-9 . _ ~ -). Retrying with the same key returns the first deployment instead of building twice.',
          ),
        projectId,
        waitSeconds,
      }),
      scope: 'projects:deploy',
      title: 'Deploy project',
    },
    async (args, call) => {
      // Only the request is replayed; the wait reads the deployment afresh on every call.
      const { deployment } = await call.once(args.idempotencyKey, args, async () => ({
        deployment: await call.inProject(args.projectId, 'project:deploy', (tx, ref) =>
          call.platform.deployments.request(tx, ref, call.principal.userId, {
            ...(args.checkpointId === undefined ? {} : { checkpointId: args.checkpointId }),
          }),
        ),
      }));

      return settle(call, args.projectId, deployment.id, args.waitSeconds ?? 0, false);
    },
  );

  kit.tool(
    'get_deployment',
    {
      description:
        'One deployment’s state: queued, building, uploading, succeeded, failed or cancelled. Pass waitSeconds to wait for it to finish. A succeeded deployment answers with the live site; a failed one with failureReason and the end of the build log. includeLog adds the log tail whatever the state.',
      input: z.object({
        deploymentId,
        includeLog: z.boolean().optional().describe('Optional. Include the end of the build log.'),
        projectId,
        waitSeconds,
      }),
      scope: 'projects:read',
      title: 'Get deployment',
    },
    async (args, call) =>
      settle(
        call,
        args.projectId,
        args.deploymentId,
        args.waitSeconds ?? 0,
        args.includeLog === true,
      ),
  );

  kit.tool(
    'list_deployments',
    {
      description:
        'The project’s deployments, newest first; `current` marks the one the site serves. Use it to find a succeeded deployment to roll back to with set_site_release or to publish with publish_to_netlify. Pass nextCursor back as cursor for the next page.',
      input: z.object({
        cursor: cursorSchema.optional().describe('Optional. nextCursor from the previous page.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(PAGE_SIZE_MAX)
          .optional()
          .describe(`Optional. Page size, default ${String(PAGE_SIZE_DEFAULT)}.`),
        projectId,
      }),
      scope: 'projects:read',
      title: 'List deployments',
    },
    async ({ cursor, limit, projectId: id }, call) =>
      call.inProject(id, 'project:read', (tx, ref) =>
        call.platform.deployments.list(tx, ref, { cursor, limit: limit ?? PAGE_SIZE_DEFAULT }),
      ),
  );

  kit.tool(
    'get_site',
    {
      description:
        'The project’s live site: its URL (null before the first successful deploy), which deployment it serves, whether it is offline, and whether the template can be deployed at all.',
      input: z.object({ projectId }),
      scope: 'projects:read',
      title: 'Get site',
    },
    async ({ projectId: id }, call) =>
      call.inProject(id, 'project:read', async (tx, ref) => ({
        site: await call.platform.sites.read(tx, ref),
      })),
  );

  kit.tool(
    'set_site_release',
    {
      description:
        'Change what the live site serves, with no new build. action "release" with a deploymentId makes that succeeded deployment live (a rollback or roll-forward; find one with list_deployments). action "offline" takes the site down until the next release or deploy — only when the person asked for it.',
      destructive: true,
      idempotent: true,
      input: z.object({
        action: z
          .enum(['offline', 'release'])
          .describe('"release" a deployment, or take the site "offline".'),
        deploymentId: deploymentId
          .optional()
          .describe('Required with "release": a succeeded deployment of this project.'),
        projectId,
      }),
      scope: 'projects:deploy',
      title: 'Set site release',
    },
    async ({ action, deploymentId: target, projectId: id }, call) => {
      if (action === 'release' && target === undefined) {
        throw new ToolError(
          'action "release" needs a deploymentId.',
          'Find a succeeded deployment with list_deployments and pass its id.',
          'validation-failed',
        );
      }

      const { userId } = call.principal;

      return call.inProject(id, 'project:deploy', async (tx, ref) => ({
        site:
          target !== undefined && action === 'release'
            ? await call.platform.sites.release(tx, ref, userId, target)
            : await call.platform.sites.offline(tx, ref, userId),
      }));
    },
  );

  kit.tool(
    'publish_to_netlify',
    {
      description:
        'Publish the project to the Netlify site it is bound to (see list_integrations; bind one with bind_integration). Without deploymentId the latest checkpoint is built first (or the build in progress is joined) and published once it succeeds; with one, that deployment is published. Runs in the background: the netlify binding’s latestOperation in list_integrations shows when it lands.',
      input: z.object({
        deploymentId: deploymentId
          .optional()
          .describe(
            'Optional. A succeeded or still-building deployment of this project, from list_deployments.',
          ),
        projectId,
      }),
      openWorld: true,
      scope: 'projects:deploy',
      title: 'Publish to Netlify',
    },
    async ({ deploymentId: target, projectId: id }, call) =>
      call.inProject(id, 'project:deploy', async (tx, ref) => ({
        operation: await call.platform.bindings.requestNetlifyPublish(
          tx,
          ref,
          call.principal.userId,
          target,
        ),
      })),
  );
}

/**
 * Read a deployment, waiting up to `seconds` for it to finish, and attach what the agent needs next:
 * the site on success, the log tail on failure. Each poll opens its own transaction, so no tenant
 * transaction is held across the sleeps.
 */
async function settle(
  call: ToolCall,
  id: string,
  target: string,
  seconds: number,
  includeLog: boolean,
): Promise<object> {
  const read = (): Promise<Deployment> =>
    call.inProject(id, 'project:read', (tx, ref) => call.platform.deployments.get(tx, ref, target));
  const finished = await call.waitFor<Deployment>(seconds, async (elapsed) => {
    const now = await read();

    return FINISHED.has(now.state)
      ? { done: true, value: now }
      : { done: false, note: `Deployment ${now.state} (${String(elapsed)}s)` };
  });
  const deployment = finished ?? (await read());

  return call.inProject(id, 'project:read', async (tx, ref) => {
    const withLog = includeLog || deployment.state === 'failed';
    const log = withLog ? await call.platform.deployments.log(tx, ref, target) : undefined;

    return {
      deployment,
      next: NEXT_STEP[deployment.state],
      ...(log === undefined
        ? {}
        : {
            buildLog: log.log.slice(-LOG_TAIL_CHARS),
            buildLogTruncated: log.truncated || log.log.length > LOG_TAIL_CHARS,
          }),
      ...(deployment.state === 'succeeded'
        ? { site: await call.platform.sites.read(tx, ref) }
        : {}),
    };
  });
}
