import {
  connectionSchema,
  type SupabaseCompleteRequest,
  supabaseCompleteRequestSchema,
} from '@repo/contracts';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';

import { AuthHeading } from '@/features/auth/components/auth-heading';
import { AuthLayout } from '@/features/auth/components/auth-layout';
import { SUPABASE_RETURN_KEY } from '@/features/project/hooks/use-integrations';
import { safeReturnPath } from '@/features/project/lib/github-sync';
import { useOrgs } from '@/features/workspace/hooks/use-orgs';
import { apiRequest } from '@/lib/api/client';
import { messageFor } from '@/lib/api/problem';
import { routes } from '@/lib/routes';

/**
 * Supabase's OAuth redirect (spec 030 research R1): Supabase lands here with `code` and `state`,
 * or with `error` when the user declined. The page echoes both to `POST connectors/supabase/
 * complete` once — the API holds the PKCE verifier — and returns to the project panel that began
 * the connect (only a same-origin path), else the settings page.
 */
export function SupabaseCallbackPage(): React.JSX.Element {
  const [params] = useSearchParams();
  const { activeOrg, isLoading } = useOrgs();
  const orgId = activeOrg?.id;
  const declined = params.get('error');
  const [returnTo] = useState(() =>
    safeReturnPath(window.sessionStorage.getItem(SUPABASE_RETURN_KEY)),
  );

  const parsed = supabaseCompleteRequestSchema.safeParse({
    code: params.get('code') ?? '',
    state: params.get('state') ?? '',
  });
  const body: SupabaseCompleteRequest | undefined =
    declined === null && parsed.success ? parsed.data : undefined;

  const complete = useMutation({
    mutationFn: (input: SupabaseCompleteRequest) =>
      apiRequest('POST', `/orgs/${encodeURIComponent(orgId ?? '')}/connectors/supabase/complete`, {
        body: input,
        schema: connectionSchema,
      }),
    onSuccess: () => {
      window.sessionStorage.removeItem(SUPABASE_RETURN_KEY);
    },
  });

  // Once: the state is single-use, and React's development double-invoke would spend it twice.
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
          title="We could not connect Supabase"
          description={
            declined !== null
              ? 'Supabase did not authorise the connection. Please start again from settings.'
              : body === undefined
                ? 'Supabase sent us back without an authorisation. Please start again from settings.'
                : messageFor(complete.error, 'The connection could not be completed.')
          }
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthHeading title="Connecting Supabase" />
      <div className="mt-6 flex items-center gap-2.5" role="status" aria-live="polite">
        <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
        <span className="text-body-sm text-subdued">
          {isLoading ? 'Checking your account…' : 'Finishing the connection…'}
        </span>
      </div>
    </AuthLayout>
  );
}
