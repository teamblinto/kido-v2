import {
  type CompleteInstallRequest,
  completeInstallRequestSchema,
  connectionSchema,
} from '@repo/contracts';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';

import { AuthHeading } from '@/features/auth/components/auth-heading';
import { AuthLayout } from '@/features/auth/components/auth-layout';
import { GITHUB_RETURN_KEY, safeReturnPath } from '@/features/project/lib/github-sync';
import { useOrgs } from '@/features/workspace/hooks/use-orgs';
import { apiRequest } from '@/lib/api/client';
import { messageFor } from '@/lib/api/problem';
import { routes } from '@/lib/routes';

/**
 * The GitHub App's Setup URL (018 research R8): GitHub lands here with `installation_id` and
 * `state`. The page hands both to `POST connectors/github/complete` once and returns to the
 * project that began the install (spec 044), else the settings page; a state the API refuses
 * (`oauth-state-invalid`) shows the catalogue's message.
 */
export function GithubCallbackPage(): React.JSX.Element {
  const [params] = useSearchParams();
  const { activeOrg, isLoading } = useOrgs();
  const orgId = activeOrg?.id;
  const [returnTo] = useState(() =>
    safeReturnPath(window.sessionStorage.getItem(GITHUB_RETURN_KEY)),
  );

  const parsed = completeInstallRequestSchema.safeParse({
    installationId: Number(params.get('installation_id')),
    state: params.get('state') ?? '',
  });
  const body: CompleteInstallRequest | undefined = parsed.success ? parsed.data : undefined;

  const complete = useMutation({
    mutationFn: (input: CompleteInstallRequest) =>
      apiRequest('POST', `/orgs/${encodeURIComponent(orgId ?? '')}/connectors/github/complete`, {
        body: input,
        schema: connectionSchema,
      }),
    onSuccess: () => {
      window.sessionStorage.removeItem(GITHUB_RETURN_KEY);
    },
  });

  // Once — the state is single-use, and React's development double-invoke would spend it twice.
  const sent = useRef(false);

  useEffect(() => {
    if (body !== undefined && orgId !== undefined && !sent.current) {
      sent.current = true;
      complete.mutate(body);
    }
  }, [body, complete, orgId]);

  if (complete.isSuccess) {
    return <Navigate to={returnTo ?? routes.connectorsSettings} replace />;
  }

  if (body === undefined || complete.isError) {
    return (
      <AuthLayout>
        <AuthHeading
          badge={{ icon: AlertTriangle, tone: 'danger' }}
          title="We could not connect GitHub"
          description={
            body === undefined
              ? 'GitHub sent us back without an installation. Please start again from settings.'
              : messageFor(complete.error, 'The connection could not be completed.')
          }
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthHeading title="Connecting GitHub" />
      <div className="mt-6 flex items-center gap-2.5" role="status" aria-live="polite">
        <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
        <span className="text-body-sm text-subdued">
          {isLoading ? 'Checking your account…' : 'Finishing the connection…'}
        </span>
      </div>
    </AuthLayout>
  );
}
