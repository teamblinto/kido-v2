import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Mail } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ApiProblem, messageFor } from '@/lib/api/problem';
import { routes } from '@/lib/routes';
import { verifyEmail } from '../api';
import { AuthHeading } from '../components/auth-heading';
import { AuthLayout } from '../components/auth-layout';
import { AuthLink } from '../components/auth-link';
import { useLinkToken } from '../hooks/use-link-token';
import { safeNext } from '../session/route-guards';
import { useSession } from '../session/session-context';

/**
 * Where a verification mail lands: `/auth/verify?token=…`.
 *
 * The token is read from this page's own URL and sent in a request body, which is the arrangement
 * `auth.controller.ts` describes — *"the web app reads it from its own URL and posts it, so the
 * token reaches this API in a body no access log records."*
 *
 * `@Public()` on the API side, because the browser holding the mail is usually not the one holding
 * the session. So this page makes no assumption about being signed in, and confirming works either
 * way.
 */
export function ConfirmEmailPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = useLinkToken();
  const { refresh, user } = useSession();
  // Spec 031 (R7): the return address the verification link carries, forwarded to the next page.
  const next = safeNext(searchParams.get('next'));
  const verified =
    next === undefined
      ? routes.emailVerified
      : `${routes.emailVerified}?${new URLSearchParams({ next }).toString()}`;

  const confirm = useMutation({
    mutationFn: verifyEmail,
    onSuccess: async () => {
      // A session already open in this browser is now holding a stale `emailVerified: false`, and
      // §11 gates real capability on it. Re-asking is cheap and is the only thing that clears the
      // "verify your email" detour without a manual reload.
      if (user !== undefined) {
        await refresh();
      }

      await navigate(verified, { replace: true });
    },
  });

  // Sent once on arrival rather than behind a button: the user already acted by clicking the link
  // in their mail, and asking them to confirm the confirmation is a step with no meaning. The ref
  // guards React's development double-invoke, which would otherwise spend the single-use token on
  // the first render and meet `token-already-used` on the second.
  const sent = useRef(false);

  useEffect(() => {
    if (token !== null && !sent.current) {
      sent.current = true;
      confirm.mutate({ token });
    }
  }, [confirm, token]);

  if (token === null) {
    return (
      <AuthLayout>
        <AuthHeading
          badge={{ icon: AlertTriangle, tone: 'danger' }}
          title="That link is incomplete"
          description="The address is missing its confirmation token. Some mail clients shorten long links — try copying the whole address, or ask for a new one."
        />
        <div className="mt-[22px]">
          <Button
            type="button"
            className="w-full"
            onClick={() => {
              void navigate(routes.verifyEmail);
            }}
          >
            Send a new link
          </Button>
        </div>
      </AuthLayout>
    );
  }

  if (confirm.isSuccess) {
    return <Navigate to={verified} replace />;
  }

  if (confirm.isError) {
    return (
      <AuthLayout>
        <AuthHeading
          badge={{ icon: AlertTriangle, tone: 'danger' }}
          title="We could not confirm that link"
          description={messageFor(confirm.error, 'The link could not be used.')}
        />

        {/*
          `token-already-used` is the one failure with a happy explanation: the address is confirmed
          and this is a second click, or a mail scanner that followed the link first. Saying "ask
          for a new one" there would send somebody to request a link they no longer need.
        */}
        {ApiProblem.is(confirm.error, 'token-already-used') ? (
          <Alert className="mt-6">
            <Mail />
            <AlertTitle>This may already be done</AlertTitle>
            <AlertDescription>
              If you have confirmed this address once, you can simply sign in.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="mt-[22px] flex flex-col gap-2.5">
          <Button
            type="button"
            className="w-full"
            onClick={() => {
              void navigate(routes.verifyEmail);
            }}
          >
            Send a new link
          </Button>
          <p className="text-body-sm text-subdued">
            Already confirmed? <AuthLink to={routes.signIn}>Sign in</AuthLink>
          </p>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthHeading
        badge={{ icon: Mail }}
        title="Confirming your email"
        description="This only takes a moment."
      />
      <div className="mt-6 flex items-center gap-2.5" role="status" aria-live="polite">
        <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
        <span className="text-body-sm text-subdued">Checking your link…</span>
      </div>
    </AuthLayout>
  );
}
