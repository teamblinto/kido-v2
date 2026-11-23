import type { Deployment, DeploymentState } from '@repo/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLinkIcon, Loader2 } from 'lucide-react';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useSession } from '@/features/auth/session/session-context';
import { ApiProblem, messageFor } from '@/lib/api/problem';
import { useCheckpoints } from '../hooks/use-checkpoints';
import {
  isInFlight,
  useDeploy,
  useDeploymentLog,
  useDeployments,
  useSite,
  useUpdateSite,
} from '../hooks/use-deployments';
import { useBindings, useNetlifyPublish, useNetlifyPublishes } from '../hooks/use-integrations';
import { REASON_COPY } from '../lib/deploy-reasons';
import { PUBLISH_REASON } from '../lib/netlify-publish';
import { DeployConfirmDialog } from './deploy-confirm-dialog';
import { NetlifyDeploy } from './netlify-deploy';

const STATE: Record<
  DeploymentState,
  { readonly label: string; readonly variant: 'danger' | 'info' | 'muted' | 'success' }
> = {
  building: { label: 'Building', variant: 'info' },
  cancelled: { label: 'Cancelled', variant: 'muted' },
  failed: { label: 'Failed', variant: 'danger' },
  queued: { label: 'Queued', variant: 'muted' },
  succeeded: { label: 'Succeeded', variant: 'success' },
  uploading: { label: 'Uploading', variant: 'info' },
};

function isReason(value: unknown): value is keyof typeof REASON_COPY {
  return typeof value === 'string' && Object.hasOwn(REASON_COPY, value);
}

/** A refusal's `reason` extension beats the generic slug copy. */
function errorCopy(error: unknown): string {
  const reason = ApiProblem.is(error) ? error.detail?.reason : undefined;

  return isReason(reason) ? REASON_COPY[reason] : messageFor(error);
}

interface DeployPanelProps {
  readonly orgId: string | undefined;
  /** The caller's own permissions on this project, from the project read. */
  readonly permissions: readonly string[];
  readonly projectId: string | undefined;
}

/**
 * The project's site (spec 027 US6): its address, the deploy in progress, the history with its
 * reasons and logs, and — for a member holding `project:deploy` — deploy, roll back and take
 * offline. A member without it sees the same address and history and no action at all: no
 * trigger is rendered rather than a disabled one advertising something they cannot do.
 */
export function DeployPanel({
  orgId,
  permissions,
  projectId,
}: DeployPanelProps): React.JSX.Element {
  const project = { orgId, projectId };
  const canDeploy = permissions.includes('project:deploy');
  const { user } = useSession();
  const queryClient = useQueryClient();

  const site = useSite(project);
  const deployments = useDeployments(project);
  const checkpoints = useCheckpoints(project);
  const deploy = useDeploy(project);
  const updateSite = useUpdateSite(project);

  const [confirming, setConfirming] = useState(false);
  const [openLog, setOpenLog] = useState<string | undefined>(undefined);

  const head = checkpoints.data?.checkpoints[0];
  const labels = new Map(checkpoints.data?.checkpoints.map((c) => [c.id, c.label]));
  const rows = deployments.data?.items ?? [];
  const inFlight = rows.find(isInFlight);
  const deployable = site.data?.deployable ?? false;

  const labelOf = (deployment: Deployment): string =>
    labels.get(deployment.checkpointId) ?? `Checkpoint ${deployment.checkpointId.slice(0, 8)}`;

  const error = updateSite.error ?? site.error ?? deployments.error;

  return (
    <section className="flex flex-col gap-4 p-4" aria-labelledby="deploy-panel-heading">
      <h2 id="deploy-panel-heading" className="text-heading-sm font-semibold">
        Site
      </h2>

      {site.isLoading ? (
        <div className="flex items-center gap-2.5" role="status" aria-live="polite">
          <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
          <span className="text-body-sm text-subdued">Loading…</span>
        </div>
      ) : null}

      {site.data === undefined ? null : (
        <div className="flex flex-col gap-1">
          {site.data.url === null ? (
            <p className="text-body-sm text-subdued">Not deployed yet.</p>
          ) : (
            <p className="text-body-sm flex flex-wrap items-center gap-2">
              <a
                href={site.data.url}
                target="_blank"
                rel="noreferrer"
                className="text-foreground truncate font-medium underline-offset-2 hover:underline"
              >
                {site.data.url}
              </a>
              <ExternalLinkIcon className="text-subdued size-3.5" aria-hidden="true" />
              {site.data.offline ? <Badge variant="warning">Offline</Badge> : null}
            </p>
          )}
        </div>
      )}

      {site.data !== undefined && !deployable ? (
        <p className="text-body-sm text-subdued" data-testid="not-deployable">
          {REASON_COPY['not-deployable']} Link the project to GitHub and export it to host it
          elsewhere.
        </p>
      ) : null}

      {canDeploy && deployable ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={head === undefined || inFlight !== undefined}
            onClick={() => {
              deploy.reset();
              setConfirming(true);
            }}
          >
            Deploy
          </Button>
          {site.data?.url != null && !site.data.offline ? (
            <Button
              size="sm"
              variant="outline"
              disabled={updateSite.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    'Take the site offline? Its address stops serving until the next deploy or rollback.',
                  )
                ) {
                  updateSite.mutate({ action: 'offline' });
                }
              }}
            >
              Take offline
            </Button>
          ) : null}
          {head === undefined && checkpoints.isSuccess ? (
            <span className="text-body-sm text-subdued">Nothing to deploy yet.</span>
          ) : null}
        </div>
      ) : null}

      {inFlight === undefined ? null : (
        <p className="text-body-sm text-subdued" role="status" aria-live="polite">
          Deploying “{labelOf(inFlight)}”…
        </p>
      )}

      {error === null ? null : <Alert variant="danger">{errorCopy(error)}</Alert>}

      {head === undefined ? null : (
        <DeployConfirmDialog
          checkpoint={head}
          error={deploy.error === null ? undefined : errorCopy(deploy.error)}
          isPending={deploy.isPending}
          onConfirm={() => {
            deploy.mutate(head.id, {
              onError: () => {
                // `deploy-active` names a row this list may not show yet.
                void queryClient.invalidateQueries({
                  queryKey: ['deployments', orgId, projectId],
                });
              },
              onSuccess: () => {
                setConfirming(false);
              },
            });
          }}
          onOpenChange={setConfirming}
          open={confirming}
        />
      )}

      {deployable && orgId !== undefined && projectId !== undefined ? (
        <NetlifyDeploy
          canDeploy={canDeploy}
          headRelease={
            rows.find((row) => row.checkpointId === head?.id && row.state === 'succeeded')?.id
          }
          orgId={orgId}
          projectId={projectId}
        />
      ) : null}

      <h3 className="text-body-md border-line-subtle border-t pt-4 font-semibold">History</h3>

      {deployments.isSuccess && rows.length === 0 ? (
        <p className="text-body-sm text-subdued">No deploys yet.</p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="flex flex-col gap-3" aria-label="Deploy history">
          {rows.map((deployment) => (
            <DeploymentRow
              key={deployment.id}
              canDeploy={canDeploy}
              deployment={deployment}
              isLogOpen={openLog === deployment.id}
              label={labelOf(deployment)}
              onRelease={() => {
                updateSite.mutate({ action: 'release', deploymentId: deployment.id });
              }}
              onToggleLog={() => {
                setOpenLog((open) => (open === deployment.id ? undefined : deployment.id));
              }}
              orgId={orgId}
              projectId={projectId}
              releasing={updateSite.isPending}
              requester={deployment.requestedBy === user?.id ? 'you' : 'a teammate'}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function DeploymentRow({
  canDeploy,
  deployment,
  isLogOpen,
  label,
  onRelease,
  onToggleLog,
  orgId,
  projectId,
  releasing,
  requester,
}: {
  readonly canDeploy: boolean;
  readonly deployment: Deployment;
  readonly isLogOpen: boolean;
  readonly label: string;
  readonly onRelease: () => void;
  readonly onToggleLog: () => void;
  readonly orgId: string | undefined;
  readonly projectId: string | undefined;
  readonly releasing: boolean;
  readonly requester: string;
}): React.JSX.Element {
  const state = STATE[deployment.state];
  const failed = deployment.state === 'failed';

  return (
    <li className="border-line-subtle flex flex-col gap-1.5 border-b pb-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-body-sm min-w-0 flex-1 truncate font-medium">{label}</span>
        <Badge variant={state.variant}>{state.label}</Badge>
        {deployment.current ? <Badge variant="brand">Live</Badge> : null}
      </div>
      <p className="text-body-sm text-subdued">
        Requested by {requester} · {new Date(deployment.createdAt).toLocaleString()}
      </p>
      {deployment.failureReason === null ? null : (
        <p className="text-body-sm text-danger">{REASON_COPY[deployment.failureReason]}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {failed ? (
          <Button size="sm" variant="outline" aria-expanded={isLogOpen} onClick={onToggleLog}>
            {isLogOpen ? 'Hide log' : 'View log'}
          </Button>
        ) : null}
        {canDeploy && deployment.state === 'succeeded' && !deployment.current ? (
          <Button
            size="sm"
            variant="outline"
            disabled={releasing}
            aria-label={`Roll back to “${label}”`}
            onClick={onRelease}
          >
            Roll back
          </Button>
        ) : null}
      </div>
      {deployment.state === 'succeeded' && orgId !== undefined && projectId !== undefined ? (
        <NetlifyPublish
          canDeploy={canDeploy}
          deploymentId={deployment.id}
          orgId={orgId}
          projectId={projectId}
        />
      ) : null}
      {isLogOpen ? (
        <DeploymentLog deploymentId={deployment.id} orgId={orgId} projectId={projectId} />
      ) : null}
    </li>
  );
}

function DeploymentLog({
  deploymentId,
  orgId,
  projectId,
}: {
  readonly deploymentId: string;
  readonly orgId: string | undefined;
  readonly projectId: string | undefined;
}): React.JSX.Element {
  const log = useDeploymentLog({ orgId, projectId }, deploymentId);

  if (log.error !== null) {
    return <p className="text-body-sm text-danger">{messageFor(log.error)}</p>;
  }

  if (log.data === undefined) {
    return <p className="text-body-sm text-subdued">Loading the log…</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      {log.data.truncated ? (
        <p className="text-body-sm text-subdued">Only the end of the log is kept.</p>
      ) : null}
      <pre className="bg-muted text-body-sm max-h-[320px] overflow-auto rounded-md p-3 font-mono whitespace-pre-wrap">
        {log.data.log === '' ? 'The log is empty.' : log.data.log}
      </pre>
    </div>
  );
}

/**
 * Spec 030 US4: "Publish to Netlify" on a succeeded release, when the project is bound to a site —
 * how an older release goes back out to Netlify. The publish's progress shows once, in the Netlify
 * section above (`NetlifyDeploy`); any publish in flight holds the button.
 */
function NetlifyPublish({
  canDeploy,
  deploymentId,
  orgId,
  projectId,
}: {
  readonly canDeploy: boolean;
  readonly deploymentId: string;
  readonly orgId: string;
  readonly projectId: string;
}): React.JSX.Element | null {
  const bindings = useBindings(orgId, projectId);
  const binding = bindings.data?.items.find((row) => row.provider === 'netlify');
  const publishes = useNetlifyPublishes(orgId, projectId, binding !== undefined);
  const publish = useNetlifyPublish(orgId, projectId);

  if (binding?.state !== 'bound' || !canDeploy) return null;

  const inFlight = (publishes.data?.items ?? []).some(
    (row) => row.state === 'queued' || row.state === 'running',
  );
  const refusal = ApiProblem.is(publish.error) ? publish.error.detail?.reason : undefined;

  return (
    <div className="flex flex-col gap-1">
      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={publish.isPending || inFlight}
          onClick={() => {
            publish.mutate(deploymentId);
          }}
        >
          Publish to Netlify
        </Button>
      </div>
      {publish.error === null ? null : (
        <p className="text-body-sm text-danger" role="alert">
          {typeof refusal === 'string' && refusal in PUBLISH_REASON
            ? PUBLISH_REASON[refusal]
            : messageFor(publish.error)}
        </p>
      )}
    </div>
  );
}
