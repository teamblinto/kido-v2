import { authorizePreviewResponseSchema } from '@repo/contracts';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router-dom';

import { AuthHeading } from '@/features/auth/components/auth-heading';
import { AuthLayout } from '@/features/auth/components/auth-layout';
import { useSession } from '@/features/auth/session/session-context';
import { apiRequest } from '@/lib/api/client';
import { ApiProblem, messageFor } from '@/lib/api/problem';
import { routes } from '@/lib/routes';

/** § 4's bounce: `<PRODUCT_ORIGIN>/preview-authorize?label=…&return=…`, `return` being the Host authority (may carry `:port`), passed through verbatim. */
const LABEL_PARAM = 'label';
const RETURN_PARAM = 'return';

/** § 4's label shape, so a malformed address is refused here without a round trip. */
const LABEL_SHAPE = /^[0-9a-f]{20,64}$/;

/**
 * One sentence for an unknown label and for a project the visitor is not a member of. The API
 * answers both with the same `not-found`, so the page could not tell them apart even if it wanted
 * to — and it must not want to, or the message would confirm that the preview exists.
 */
const NOT_FOUND_TITLE = 'There is no preview here';

/**
 * Exchange a label for a grant: `POST preview/authorize` answers `{ url }`, the
 * `https://<returnHost>/?code=…` the browser must reach by a top-level navigation — the gateway's
 * `__Host-preview_grant` is `SameSite=Lax`, which a cross-site `fetch` response could not set.
 */
async function authorize(body: { label: string; returnHost: string }): Promise<string> {
  const { url } = await apiRequest('POST', '/preview/authorize', {
    body,
    schema: authorizePreviewResponseSchema,
  });

  return url;
}

/**
 * Where the preview gateway sends a browser that reached a non-public preview without a grant
 * (research R16, contracts/preview.md § 2 and § 4).
 *
 * Ungated in the router because the visitor may hold no session: that case is handed to the
 * sign-in screen with this address as `state.from`, and `destinationAfterSignIn` brings them back
 * — query included — to finish the same exchange.
 */
export function PreviewAuthorizePage(): React.JSX.Element {
  const [params] = useSearchParams();
  const location = useLocation();
  const { isResolving, user } = useSession();

  const label = params.get(LABEL_PARAM) ?? '';
  const returnHost = params.get(RETURN_PARAM) ?? '';
  const addressed = LABEL_SHAPE.test(label) && returnHost.length > 0;

  const exchange = useMutation({
    mutationFn: authorize,
    onSuccess: (target) => {
      window.location.assign(target);
    },
  });

  // Once, on arrival — the visitor already acted by opening the preview. The ref guards React's
  // development double-invoke, as `ConfirmEmailPage` does for the same reason.
  const sent = useRef(false);

  useEffect(() => {
    if (addressed && user !== undefined && !sent.current) {
      sent.current = true;
      exchange.mutate({ label, returnHost });
    }
  }, [addressed, exchange, label, returnHost, user]);

  if (!addressed || ApiProblem.is(exchange.error, 'not-found')) {
    return (
      <AuthLayout>
        <AuthHeading
          badge={{ icon: AlertTriangle, tone: 'danger' }}
          title={NOT_FOUND_TITLE}
          description="The address may be wrong, or the preview may have been rotated. Ask whoever shared it for a fresh link."
        />
      </AuthLayout>
    );
  }

  if (isResolving) {
    return (
      <AuthLayout>
        <AuthHeading badge={{ icon: ShieldCheck }} title="Opening your preview" />
        <div className="mt-6 flex items-center gap-2.5" role="status" aria-live="polite">
          <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
          <span className="text-body-sm text-subdued">Checking your account…</span>
        </div>
      </AuthLayout>
    );
  }

  if (user === undefined) {
    return <Navigate to={routes.signIn} state={{ from: location }} replace />;
  }

  if (exchange.isError) {
    return (
      <AuthLayout>
        <AuthHeading
          badge={{ icon: AlertTriangle, tone: 'danger' }}
          title="We could not open that preview"
          description={messageFor(exchange.error, 'The preview could not be opened.')}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthHeading badge={{ icon: ShieldCheck }} title="Opening your preview" />
      <div className="mt-6 flex items-center gap-2.5" role="status" aria-live="polite">
        <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
        <span className="text-body-sm text-subdued">Taking you there…</span>
      </div>
    </AuthLayout>
  );
}
