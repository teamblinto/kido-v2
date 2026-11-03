import { emailSchema } from '@repo/contracts';
import { useMutation } from '@tanstack/react-query';
import { LogOut, Mail } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { GoogleIcon } from '@/components/icons/brand-icons';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { routes } from '@/lib/routes';
import { oauthStartUrl, resendVerification } from '../api';
import { AuthHeading } from '../components/auth-heading';
import { AuthLayout } from '../components/auth-layout';
import { AuthLink } from '../components/auth-link';
import { OrDivider } from '../components/or-divider';
import { ResendButton } from '../components/resend-button';
import { WaitingNotice } from '../components/waiting-notice';
import { useAccountEmail } from '../hooks/use-account-email';

export function VerifyEmailPage(): React.JSX.Element {
  const navigate = useNavigate();
  const email = useAccountEmail();

  const resend = useMutation({ mutationFn: resendVerification });

  // Only an address the contract accepts can be resent to. The page is reachable directly, where
  // `useAccountEmail` falls back to a description rather than an address, and posting that would
  // earn a 422 for a mistake the user did not make.
  const address = emailSchema.safeParse(email);

  return (
    <AuthLayout>
      <AuthHeading
        badge={{ icon: Mail }}
        title="Verify your email to continue"
        description={`We sent a link to ${email}. Open it and you're straight in. The link works once and expires in 24 hours.`}
      />

      <div className="mt-6">
        <WaitingNotice>Waiting for confirmation — open the link in your inbox</WaitingNotice>
      </div>

      {/*
        `202` whether or not the address has an account awaiting verification (ADR 007), so this
        confirms only that the request was accepted. Claiming a mail was sent would be a claim the
        server deliberately declined to make.
      */}
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
          idleLabel="Resend link"
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
            void navigate(routes.signUp);
          }}
        >
          Change email address
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
        Google accounts are already verified — you&apos;d go straight in.
      </p>

      <p className="text-body-sm text-subdued mt-[22px] flex items-center gap-2">
        <LogOut className="size-3.5 shrink-0" aria-hidden="true" />
        Not you? <AuthLink to={routes.signIn}>Sign in as someone else</AuthLink>
      </p>
    </AuthLayout>
  );
}
