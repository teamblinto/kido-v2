import { Loader2 } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { messageFor } from '@/lib/api/problem';
import { useMcpGrants, useRevokeMcpGrant } from './use-mcp-grants';

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

function formatted(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** The AI agents the caller has let into this organisation, each revocable (spec 046). */
export function McpGrantsSection({ orgId }: { readonly orgId: string }): React.JSX.Element {
  const grants = useMcpGrants(orgId);
  const revoke = useRevokeMcpGrant(orgId);

  return (
    <section className="mt-8">
      <h2 className="text-heading-sm font-semibold">Connected agents</h2>

      {grants.isLoading ? (
        <div className="mt-4 flex items-center gap-2.5" role="status" aria-live="polite">
          <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
          <span className="text-body-sm text-subdued">Loading agents…</span>
        </div>
      ) : null}

      {grants.error === null ? null : (
        <Alert variant="danger" className="mt-4">
          {messageFor(grants.error, 'The connected agents could not be loaded.')}
        </Alert>
      )}

      {revoke.error === null ? null : (
        <Alert variant="danger" className="mt-4">
          {messageFor(revoke.error, 'Access could not be revoked.')}
        </Alert>
      )}

      {grants.isSuccess && grants.data.length === 0 ? (
        <p className="text-body-sm text-subdued mt-4">
          No AI agents are connected to this organization yet.
        </p>
      ) : null}

      {grants.isSuccess && grants.data.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-3">
          {grants.data.map((grant) => (
            <li key={grant.id} className="border-line rounded-lg border p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate font-medium">{grant.clientName}</p>
                  {grant.clientUri === null ? null : (
                    <p className="text-caption text-subdued">{hostOf(grant.clientUri)}</p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={revoke.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Revoke access for ${grant.clientName}? It will need to sign in again.`,
                      )
                    ) {
                      revoke.mutate(grant.id);
                    }
                  }}
                >
                  Revoke
                </Button>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {grant.scopes.map((scope) => (
                  <Badge key={scope} variant="outline">
                    {scope}
                  </Badge>
                ))}
              </div>
              <p className="text-caption text-subdued mt-2">
                {`Connected ${formatted(grant.createdAt)} · `}
                {grant.lastUsedAt === null
                  ? 'Never used'
                  : `Last used ${formatted(grant.lastUsedAt)}`}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
