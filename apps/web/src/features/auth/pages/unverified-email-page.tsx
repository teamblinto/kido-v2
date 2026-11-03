import { emailSchema } from '@repo/contracts';
import { useMutation } from '@tanstack/react-query';
import { ArrowRight, Mail } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { GoogleIcon } from '@/components/icons/brand-icons';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { routes } from '@/lib/routes';
import { oauthStartUrl, resendVerification } from '../api';
import { AuthHeading } from '../components/auth-heading';
import { AuthLayout } from '../components/auth-layout';
import { OrDivider } from '../components/or-divider';
import { ResendButton } from '../components/resend-button';
import { WaitingNotice } from '../components/waiting-notice';
import { useAccountEmail } from '../hooks/use-account-email';

/**
 * Where a signed-in user with an unconfirmed address lands.
 *
 * Not a wall, and the wording reflects that. §11 makes an unverified account usable and stops it
 * only at creating sandboxes, so the session behind this page is real — which is why there is a way
 * on from here rather than only a way back.
 */
export function UnverifiedEmailPage(): React.JSX.Element {
  const navigate = useNavigate();
  const email = useAccountEmail('this address');

  const resend = useMutation({ mutationFn: resendVerification });
  const address = emailSchema.safeParse(email);

  return (
    <AuthLayout>
      <AuthHeading
        badge={{ icon: Mail }}
        title="Confirm your email address"
        description={`${email} has not been confirmed yet. You can carry on looking around — you'll need it confirmed before you can create anything.`}
      />

      <div className="mt-6">
        <WaitingNotice>Waiting for confirmation — open the link in your inbox</WaitingNotice>
      </div>

      {resend.isSuccess ? (
        <Alert className="mt-[22px]">
          <Mail />
          <AlertDescription>
            If that address is waiting to be confirmed, another link is on its way.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-[22px] flex flex-col gap-2.5">
        <ResendButton
          seconds={0}
          idleLabel="Resend verification link"
          isPending={resend.isPending}
          pendingLabel={(time) => `Resend link in ${time}`}
          onResend={
            address.success
              ? () => {
                  resend.mutate({ email: address.data });
                }
              : undefined
          }
        />
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => {
            void navigate(routes.home);
          }}
        >
          Continue to your dashboard
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>

      <OrDivider />

      <Button
        type="button"
        variant="outline"
        className="w-full gap-2.5"
        onClick={() => {
          window.location.assign(oauthStartUrl('google'));
        }}
      >
        <GoogleIcon className="size-[18px]" />
        Continue with Google instead
      </Button>
      <p className="text-caption text-faint mt-2">
        Same email, no waiting — Google accounts arrive verified.
      </p>
    </AuthLayout>
  );
}
