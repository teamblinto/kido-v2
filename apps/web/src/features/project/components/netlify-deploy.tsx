import type { Operation } from '@repo/contracts';
import { ExternalLinkIcon, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useOrgs } from '@/features/workspace/hooks/use-orgs';
import { ApiProblem, messageFor } from '@/lib/api/problem';
import {
  useBindings,
  useNetlifyPublish,
  useNetlifyPublishes,
  useOrgConnections,
} from '../hooks/use-integrations';
import { PUBLISH_REASON } from '../lib/netlify-publish';
import { NetlifySection } from './integrations-panel';

/** Netlify's own words for a publish (FR-017), with ours for before it starts. */
const PUBLISH_STATE: Readonly<Record<string, string>> = {
  building: 'Building on Kido…',
  error: 'Netlify: error',
  failed: 'Publish failed',
  new: 'Netlify: preparing',
  prepared: 'Uploading to Netlify…',
  preparing: 'Netlify: preparing',
  processing: 'Netlify is processing the deploy…',
  queued: 'Publish queued',
  ready: 'Published to Netlify',
  running: 'Publishing…',
  succeeded: 'Published to Netlify',
  uploading: 'Uploading to Netlify…',
};

/** What a publish says now: its state, or Netlify's word for it while it runs. */
function publishWord(operation: Operation): string {
  return operation.state === 'running' && operation.providerState !== null
    ? operation.providerState
    : operation.state;
}

function isSettling(operation: Operation | undefined): boolean {
  return operation?.state === 'queued' || operation?.state === 'running';
}

/** The site's deploy list on Netlify, by the site name the binding records. */
function netlifyDeploysUrl(siteName: string): string {
  return `https://app.netlify.com/sites/${encodeURIComponent(siteName)}/deploys`;
}

function ExternalLink({
  children,
  href,
}: {
  readonly children: React.ReactNode;
  readonly href: string;
}): React.JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-body-sm text-foreground inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline"
    >
      {children}
      <ExternalLinkIcon className="text-subdued size-3.5" aria-hidden="true" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

interface NetlifyDeployProps {
  /** `project:deploy`: may start a deploy to Netlify. */
  readonly canDeploy: boolean;
  /** A succeeded release of the head checkpoint, published as it is rather than rebuilt. */
  readonly headRelease: string | undefined;
  readonly orgId: string;
  readonly projectId: string;
}

/**
 * "Deploy to Netlify" on the project's Deploy panel: the Netlify site choice (the same section the
 * Integrations panel shows — connect state, bind to an existing site or create one), then one
 * button that builds the head with the project's own build and publishes its output to the bound
 * site, and the latest publish's progress, outcome and links. The site choice is stored on the
 * binding, so every later deploy reuses it.
 */
export function NetlifyDeploy({
  canDeploy,
  headRelease,
  orgId,
  projectId,
}: NetlifyDeployProps): React.JSX.Element {
  const connections = useOrgConnections(orgId);
  const bindings = useBindings(orgId, projectId);
  const orgs = useOrgs();
  const role = orgs.orgs.find((row) => row.id === orgId)?.role;
  const canManage = role === 'owner' || role === 'admin';

  const connection = connections.data?.connections.find((row) => row.provider === 'netlify');
  const binding = bindings.data?.items.find((row) => row.provider === 'netlify');
  const site = binding?.provider === 'netlify' ? binding.config : undefined;

  const publishes = useNetlifyPublishes(orgId, projectId, binding !== undefined);
  const publish = useNetlifyPublish(orgId, projectId);
  const latest = publishes.data?.items[0];
  const settling = isSettling(latest);

  if (connections.isLoading || bindings.isLoading || orgs.isLoading) {
    return (
      <div className="flex items-center gap-2.5" role="status" aria-live="polite">
        <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
        <span className="text-body-sm text-subdued">Loading Netlify…</span>
      </div>
    );
  }

  if (connections.isError || bindings.isError) {
    return (
      <p className="text-body-sm text-danger" role="alert">
        {messageFor(connections.error ?? bindings.error, 'Netlify could not be loaded.')}
      </p>
    );
  }

  const ready =
    binding?.state === 'bound' && connection !== undefined && connection.health !== 'needs_reauth';
  const refusal = ApiProblem.is(publish.error) ? publish.error.detail?.reason : undefined;

  return (
    <div
      className="border-line-subtle flex flex-col gap-3 border-t pt-4"
      data-testid="netlify-deploy"
    >
      <NetlifySection
        binding={binding}
        canManage={canManage}
        connection={connection}
        orgId={orgId}
        projectId={projectId}
      />

      {site !== undefined && canDeploy ? (
        <div className="flex flex-col gap-1.5">
          <div>
            <Button
              size="sm"
              disabled={!ready || publish.isPending || settling}
              onClick={() => {
                publish.mutate(headRelease);
              }}
            >
              {publish.isPending || settling ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              Deploy to Netlify
            </Button>
          </div>
          <p className="text-body-sm text-subdued">
            {headRelease === undefined
              ? `Builds the latest checkpoint with this project's build settings, then publishes the output to ${site.siteName}.`
              : `Publishes the latest checkpoint's build to ${site.siteName}.`}
          </p>
        </div>
      ) : null}

      {publish.error === null ? null : (
        <p className="text-body-sm text-danger" role="alert">
          {typeof refusal === 'string' && refusal in PUBLISH_REASON
            ? PUBLISH_REASON[refusal]
            : messageFor(publish.error)}
        </p>
      )}

      {site === undefined || latest === undefined ? null : (
        <PublishStatus operation={latest} siteName={site.siteName} siteUrl={site.siteUrl} />
      )}
    </div>
  );
}

function PublishStatus({
  operation,
  siteName,
  siteUrl,
}: {
  readonly operation: Operation;
  readonly siteName: string;
  readonly siteUrl: string;
}): React.JSX.Element {
  const word = publishWord(operation);
  const settling = isSettling(operation);
  const variant =
    operation.state === 'succeeded' ? 'success' : operation.state === 'failed' ? 'danger' : 'info';
  const when = operation.finishedAt ?? operation.createdAt;

  return (
    <div className="flex flex-col gap-1.5" data-testid="netlify-publish-status">
      <div className="flex flex-wrap items-center gap-2" role="status" aria-live="polite">
        <Badge variant={variant}>
          {settling ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          {PUBLISH_STATE[word] ?? `Netlify: ${word}`}
        </Badge>
        <span className="text-body-sm text-subdued">{new Date(when).toLocaleString()}</span>
      </div>
      {operation.state === 'failed' ? (
        <p className="text-body-sm text-danger">
          {(operation.reason === null ? undefined : PUBLISH_REASON[operation.reason]) ??
            'The publish failed.'}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {operation.state === 'succeeded' ? (
          <ExternalLink href={siteUrl}>Open live site</ExternalLink>
        ) : null}
        <ExternalLink href={netlifyDeploysUrl(siteName)}>Deploys on Netlify</ExternalLink>
      </div>
    </div>
  );
}
