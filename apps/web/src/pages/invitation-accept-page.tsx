import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, UserPlus } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { AuthHeading } from '@/features/auth/components/auth-heading';
import { AuthLayout } from '@/features/auth/components/auth-layout';
import { useSession } from '@/features/auth/session/session-context';
import { acceptInvitation } from '@/features/workspace/api';
import { ORGS_QUERY_KEY, useOrgs } from '@/features/workspace/hooks/use-orgs';
import { routes } from '@/lib/routes';

/** The one sentence a dead link gets — unknown, expired, used or someone else's. */
const DEAD_LINK = 'This invitation link no longer works.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/invitations/accept?token=…&org=…` — where an organisation invitation mail lands (T29, built by
 * `invitationUrl` in the API's mail links). The organisation-level twin of
 * `ProjectInvitationAcceptPage`, and it behaves the same way: signed out, the visitor goes to
 * sign-in with this page as `state.from` (sign-up carries it on as `next`); signed in, the link is
 * spent, the organisation becomes the active one and the workspace opens. Every refusal is the same
 * sentence and names nothing.
 */
export function InvitationAcceptPage(): React.JSX.Element {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isResolving, user } = useSession();
  const { selectOrg } = useOrgs();

  const orgId = params.get('org') ?? '';
  const token = params.get('token') ?? '';
  const addressed = UUID.test(orgId) && token.length > 0;

  const exchange = useMutation({
    mutationFn: () => acceptInvitation(orgId, token),
    onSuccess: async (accepted) => {
      selectOrg(accepted.orgId);
      await queryClient.invalidateQueries({ queryKey: ORGS_QUERY_KEY });
      await navigate(routes.home, { replace: true });
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
          description="Ask whoever invited you to send a new invitation."
        />
      </AuthLayout>
    );
  }

  if (!isResolving && user === undefined) {
    return <Navigate to={routes.signIn} state={{ from: location }} replace />;
  }

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
