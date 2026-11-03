import {
  type CompleteLinkRequest,
  completeLinkRequestSchema,
  llmProviderSchema,
} from '@repo/contracts';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';

import { AuthHeading } from '@/features/auth/components/auth-heading';
import { AuthLayout } from '@/features/auth/components/auth-layout';
import { linkErrorCopy } from '@/features/settings/linked-account-copy';
import { completeLink } from '@/features/settings/linked-accounts-api';
import { routes } from '@/lib/routes';

/**
 * A subscription provider's OAuth redirect (spec 032 US2). The provider lands here with `code`
 * and `state`, or with `error`. Either way the page echoes it to `complete` once — an `error`
 * still spends the state (contracts § 1) — and returns to the account settings page.
 */
export function ConnectedAccountCallbackPage(): React.JSX.Element {
  const [params] = useSearchParams();
  const provider = llmProviderSchema.safeParse(useParams().provider);
  const error = params.get('error');

  const parsed = completeLinkRequestSchema.safeParse(
    error === null
      ? { code: params.get('code') ?? '', state: params.get('state') ?? '' }
      : {
          error: error === 'access_denied' ? 'access_denied' : 'other',
          state: params.get('state') ?? '',
        },
  );
  const body: CompleteLinkRequest | undefined =
    provider.success && parsed.success ? parsed.data : undefined;
  const name = provider.data === 'openai' ? 'OpenAI' : 'Claude';

  // Local state rather than `useMutation`: the post goes out during the first effect, and a
  // StrictMode remount would detach a mutation observer from the result it is waiting on.
  const [outcome, setOutcome] = useState<{ readonly error: unknown } | 'done'>();

  // Once: the state is single-use, and React's development double-invoke would spend it twice.
  const sent = useRef(false);

  useEffect(() => {
    if (body !== undefined && provider.success && !sent.current) {
      sent.current = true;
      completeLink(provider.data, body).then(
        () => {
          setOutcome('done');
        },
        (error: unknown) => {
          setOutcome({ error });
        },
      );
    }
  }, [body, provider]);

  if (outcome === 'done') {
    return <Navigate to={routes.accountSettings} replace />;
  }

  if (body === undefined || outcome !== undefined) {
    return (
      <AuthLayout>
        <AuthHeading
          badge={{ icon: AlertTriangle, tone: 'danger' }}
          title={`We could not connect ${name}`}
          description={
            body === undefined
              ? `${name} sent us back without an authorisation. Please start again from settings.`
              : linkErrorCopy(typeof outcome === 'object' ? outcome.error : undefined, name)
          }
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthHeading title={`Connecting ${name}`} />
      <div className="mt-6 flex items-center gap-2.5" role="status" aria-live="polite">
        <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
        <span className="text-body-sm text-subdued">Finishing the connection…</span>
      </div>
    </AuthLayout>
  );
}
