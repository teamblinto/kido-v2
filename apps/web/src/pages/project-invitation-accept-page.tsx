import { acceptProjectInvitationResponseSchema } from '@repo/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, UserPlus } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { AuthHeading } from '@/features/auth/components/auth-heading';
import { AuthLayout } from '@/features/auth/components/auth-layout';
import { useSession } from '@/features/auth/session/session-context';
import { ORGS_QUERY_KEY, useOrgs } from '@/features/workspace/hooks/use-orgs';
import { apiRequest } from '@/lib/api/client';
import { projectPath, routes } from '@/lib/routes';

const ORG_PARAM = 'org';

/** The one sentence a dead link gets — unknown, expired, used, withdrawn or someone else's (R7). */
const DEAD_LINK = 'This invitation link no longer works.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function accept(orgId: string, token: string): Promise<string> {
  const { projectId } = await apiRequest(
    'POST',
    `/orgs/${encodeURIComponent(orgId)}/project-invitations/accept`,
    { body: { token }, schema: acceptProjectInvitationResponseSchema },
  );

  return projectId;
}

/**
 * `/project-invitations/accept/:token?org=…` — where a project invitation mail lands (spec 031,
 * research R7, contracts/sharing.md § 8).
 *
 * Signed out, the visitor goes to sign-in with this page as `state.from`; sign-in's "create an
 * account" link carries that on, and sign-up puts it on the verification mail as `next`, so a
 * newcomer lands back here either way. Signed in, the link is spent, the organisation becomes the
 * active one (it is now in `GET /orgs` as a guest) and the project opens.
 *
 * Every refusal is the same sentence and names nothing — not the project, not the organisation:
 * the person holding the link may not be the person it was sent to.
 */
export function ProjectInvitationAcceptPage(): React.JSX.Element {
  const { token = '' } = useParams();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isResolving, user } = useSession();
  const { selectOrg } = useOrgs();

  const orgId = params.get(ORG_PARAM) ?? '';
  const addressed = UUID.test(orgId) && token.length >= 32;

  const exchange = useMutation({
    mutationFn: () => accept(orgId, token),
    onSuccess: async (projectId) => {
      selectOrg(orgId);
      await queryClient.invalidateQueries({ queryKey: ORGS_QUERY_KEY });
      await navigate(projectPath(projectId), { replace: true });
    },
  });

  const sent = useRef(false);

  useEffect(() => {
    if (addressed && user !== undefined && !sent.current) {
      sent.current = true;
      exchange.mutate();
    }
  }, [addressed, exchange, user]);

  if (!addressed || exchange.isError) {
    return (
      <AuthLayout>
        <AuthHeading
          badge={{ icon: AlertTriangle, tone: 'danger' }}
          title={DEAD_LINK}
          description="Ask whoever shared it to send you a new invitation."
        />
      </AuthLayout>
    );
  }

  if (isResolving) {
    return <Opening />;
  }

  if (user === undefined) {
    return <Navigate to={routes.signIn} state={{ from: location }} replace />;
  }

  return <Opening />;
}

function Opening(): React.JSX.Element {
  return (
    <AuthLayout>
      <AuthHeading badge={{ icon: UserPlus }} title="Opening your invitation" />
      <div className="mt-6 flex items-center gap-2.5" role="status" aria-live="polite">
        <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
        <span className="text-body-sm text-subdued">Checking your account…</span>
      </div>
    </AuthLayout>
  );
}
