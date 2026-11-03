import { ArrowRight, Check, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { routes } from '@/lib/routes';
import { AuthHeading } from '../components/auth-heading';
import { AuthLayout } from '../components/auth-layout';
import { AuthLink } from '../components/auth-link';
import { useAccountEmail } from '../hooks/use-account-email';
import { fromOf, safeNext } from '../session/route-guards';
import { useSession } from '../session/session-context';

const handoffDurationMs = 6000;
const tickMs = 100;

/**
 * The screen after a confirmation succeeds — reached only from {@link ConfirmEmailPage}.
 *
 * Where it hands off depends on whether this browser is the one holding the session, and it often
 * is not: mail is frequently opened somewhere else entirely, which is exactly why `/auth/verify` is
 * `@Public()`. A signed-in visitor is walked to the dashboard; a signed-out one is offered the
 * sign-in screen, because sending them to a guarded route would only bounce them there anyway.
 */
export function EmailVerifiedPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const email = useAccountEmail('Your email');
  const { user } = useSession();
  const [progress, setProgress] = useState(0);

  // Spec 031 (R7): a carried return address wins over home; signed out, sign-in returns to it.
  const next = safeNext(searchParams.get('next'));
  const destination = user === undefined ? routes.signIn : (next ?? routes.home);
  const destinationState = useMemo(
    () => (user === undefined && next !== undefined ? { from: fromOf(next) } : undefined),
    [next, user],
  );

  useEffect(() => {
    const step = (100 * tickMs) / handoffDurationMs;
    const timer = window.setInterval(() => {
      setProgress((current) => Math.min(100, current + step));
    }, tickMs);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (progress >= 100) {
      void navigate(destination, { replace: true, state: destinationState });
    }
  }, [destination, destinationState, navigate, progress]);

  return (
    <AuthLayout>
      <AuthHeading
        badge={{ icon: Check, tone: 'success' }}
        title="Email verified"
        description={`${email} is confirmed. Everything's ready — let's build something.`}
      />

      <div className="bg-subtle border-line-subtle mt-6 rounded-lg border px-[13px] py-3">
        <p className="text-body-sm text-subdued flex items-center gap-[9px]">
          <Sparkles className="text-brand size-[15px] shrink-0" aria-hidden="true" />
          {user === undefined ? 'Taking you to sign in…' : 'Taking you to your dashboard…'}
        </p>
        <Progress
          value={progress}
          className="mt-2.5"
          aria-label={
            user === undefined ? 'Redirecting to sign in' : 'Redirecting to your dashboard'
          }
        />
      </div>

      <Button
        type="button"
        className="mt-[22px] w-full"
        onClick={() => {
          void navigate(destination, { replace: true, state: destinationState });
        }}
      >
        {user === undefined ? 'Go to sign in' : 'Go to dashboard'}
        <ArrowRight aria-hidden="true" />
      </Button>

      {user === undefined ? (
        <p className="text-caption text-faint mt-4">
          Opened this from a different device? Your account is confirmed — just{' '}
          <AuthLink to={routes.signIn}>sign in</AuthLink> wherever you like.
        </p>
      ) : (
        <p className="text-caption text-faint mt-4">
          You can close the tab you started in — this one is signed in.
        </p>
      )}
    </AuthLayout>
  );
}
