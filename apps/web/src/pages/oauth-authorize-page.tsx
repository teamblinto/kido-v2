import {
  MCP_SCOPE_DESCRIPTIONS,
  type McpAuthorizationRequest,
  mcpAuthorizationRequestSchema,
} from '@repo/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { AuthHeading } from '@/features/auth/components/auth-heading';
import { AuthLayout } from '@/features/auth/components/auth-layout';
import { useSession } from '@/features/auth/session/session-context';
import { decideMcpAuthorization, previewMcpAuthorization } from '@/features/settings/mcp/mcp-api';
import { useOrgs } from '@/features/workspace/hooks/use-orgs';
import { messageFor } from '@/lib/api/problem';
import { routes } from '@/lib/routes';

/** RFC 6749 §4.1.1's wire names, and the camelCase key the contract gives each. */
const PARAMS: Readonly<Record<string, keyof McpAuthorizationRequest>> = {
  client_id: 'clientId',
  code_challenge: 'codeChallenge',
  code_challenge_method: 'codeChallengeMethod',
  redirect_uri: 'redirectUri',
  resource: 'resource',
  response_type: 'responseType',
  scope: 'scope',
  state: 'state',
};

const SELECT_CLASS =
  'border-line bg-raised text-body-sm h-8 w-full rounded-md border px-2 focus-visible:outline-none';

/** Only the known parameters, and only those present, so an absent optional one stays absent. */
function requestFrom(params: URLSearchParams): McpAuthorizationRequest | null {
  const raw: Record<string, string> = {};

  for (const [wire, key] of Object.entries(PARAMS)) {
    const value = params.get(wire);

    if (value !== null) raw[key] = value;
  }
  const parsed = mcpAuthorizationRequestSchema.safeParse(raw);

  return parsed.success ? parsed.data : null;
}

function Waiting({
  status,
  title,
}: {
  readonly status: string;
  readonly title: string;
}): React.JSX.Element {
  return (
    <AuthLayout>
      <AuthHeading badge={{ icon: ShieldCheck }} title={title} />
      <div className="mt-6 flex items-center gap-2.5" role="status" aria-live="polite">
        <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
        <span className="text-body-sm text-subdued">{status}</span>
      </div>
    </AuthLayout>
  );
}

function Refused({ description }: { readonly description: string }): React.JSX.Element {
  return (
    <AuthLayout>
      <AuthHeading
        badge={{ icon: AlertTriangle, tone: 'danger' }}
        title="This authorization request cannot be used"
        description={description}
      />
    </AuthLayout>
  );
}

/**
 * The OAuth `authorization_endpoint` an MCP client sends the browser to (spec 046).
 *
 * Ungated in the router, as `PreviewAuthorizePage` is: a signed-out visitor is sent to sign in with
 * this address as `state.from`, so the whole query survives the round trip. Nothing is decided on
 * arrival — the person presses Allow or Deny.
 */
export function OauthAuthorizePage(): React.JSX.Element {
  const [params] = useSearchParams();
  const location = useLocation();
  const { isResolving, user } = useSession();
  const { activeOrg, isEmpty, orgs } = useOrgs();
  const [pickedOrgId, setPickedOrgId] = useState<string | undefined>(undefined);

  const request = requestFrom(params);
  const orgId = pickedOrgId ?? activeOrg?.id;

  const preview = useQuery({
    enabled: request !== null && user !== undefined,
    queryFn: ({ signal }) => previewMcpAuthorization(request!, signal),
    queryKey: ['mcp', 'authorize-preview', request],
  });

  const decide = useMutation({
    mutationFn: decideMcpAuthorization,
    onSuccess: (redirectUrl) => {
      window.location.assign(redirectUrl);
    },
  });

  if (request === null) {
    return (
      <Refused description="The app that sent you here built an incomplete or malformed request. Try connecting again from the app." />
    );
  }

  if (isResolving) {
    return <Waiting title="Authorize access" status="Checking your account…" />;
  }

  if (user === undefined) {
    return <Navigate to={routes.signIn} state={{ from: location }} replace />;
  }

  if (preview.isError) {
    return <Refused description={messageFor(preview.error, 'The request could not be checked.')} />;
  }

  if (!preview.isSuccess) {
    return <Waiting title="Authorize access" status="Checking the request…" />;
  }

  const { clientName, redirectHost, scopes } = preview.data;
  const busy = decide.isPending || decide.isSuccess;

  return (
    <AuthLayout>
      <AuthHeading
        badge={{ icon: ShieldCheck }}
        title={`${clientName} wants to access your account`}
        description={
          <>
            After you decide, you will be sent to <strong>{redirectHost}</strong>.
          </>
        }
      />

      <ul className="mt-6 flex flex-col gap-2">
        {scopes.map((scope) => (
          <li key={scope} className="text-body-sm">
            {MCP_SCOPE_DESCRIPTIONS[scope]}
          </li>
        ))}
      </ul>

      <div className="mt-6">
        {isEmpty ? (
          <Alert variant="warning">
            You need to belong to an organization before an AI agent can work for you. Create one or
            ask to be invited, then connect again.
          </Alert>
        ) : orgs.length === 1 ? (
          <p className="text-body-sm">
            Organization: <strong>{orgs[0]?.name}</strong>
          </p>
        ) : (
          <label className="text-body-sm flex flex-col gap-1.5">
            Organization
            <select
              className={SELECT_CLASS}
              value={orgId ?? ''}
              onChange={(event) => {
                setPickedOrgId(event.target.value);
              }}
            >
              {orgs.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {decide.isError ? (
        <Alert variant="danger" className="mt-4">
          {messageFor(decide.error, 'Your decision could not be saved.')}
        </Alert>
      ) : null}

      <div className="mt-6 flex gap-3">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            decide.mutate({ decision: 'deny', request });
          }}
        >
          Deny
        </Button>
        <Button
          disabled={busy || orgId === undefined}
          onClick={() => {
            decide.mutate({ decision: 'allow', orgId, request });
          }}
        >
          Allow
        </Button>
      </div>

      <p className="text-caption text-subdued mt-4">
        You can revoke access anytime in Settings → AI agents.
      </p>
    </AuthLayout>
  );
}
