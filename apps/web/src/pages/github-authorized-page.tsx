import { type CompleteRepoCreateRequest, completeRepoCreateRequestSchema } from '@repo/contracts';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';

import { AuthHeading } from '@/features/auth/components/auth-heading';
import { AuthLayout } from '@/features/auth/components/auth-layout';
import { errorCopy, GITHUB_AUTHORIZE_KEY, readAuthorize } from '@/features/project/lib/github-sync';
import { useOrgs } from '@/features/workspace/hooks/use-orgs';
import { apiRequest } from '@/lib/api/client';
import { routes } from '@/lib/routes';

/**
 * The GitHub App's OAuth callback, for the personal-account create (spec 044, decision 7). GitHub
 * lands here with `code` and `state`; the page hands both to `POST …/repo-link/authorized` once,
 * for the project the panel remembered, and goes back to it.
 */
export function GithubAuthorizedPage(): React.JSX.Element {
  const [params] = useSearchParams();
  const { activeOrg, isLoading } = useOrgs();
  const orgId = activeOrg?.id;
  const [remembered] = useState(readAuthorize);

  const parsed = completeRepoCreateRequestSchema.safeParse({
    code: params.get('code') ?? '',
    state: params.get('state') ?? '',
  });
  const body: CompleteRepoCreateRequest | undefined = parsed.success ? parsed.data : undefined;

  const complete = useMutation({
    mutationFn: (input: CompleteRepoCreateRequest) =>
      apiRequest(
        'POST',
        `/orgs/${encodeURIComponent(orgId ?? '')}/projects/${encodeURIComponent(remembered?.projectId ?? '')}/repo-link/authorized`,
        { body: input },
      ),
    onSuccess: () => {
      window.sessionStorage.removeItem(GITHUB_AUTHORIZE_KEY);
    },
  });

  // Once: GitHub's code is single-use, and React's development double-invoke would spend it twice.
  const sent = useRef(false);

  useEffect(() => {
    if (body !== undefined && orgId !== undefined && remembered !== undefined && !sent.current) {
      sent.current = true;
      complete.mutate(body);
    }
  }, [body, complete, orgId, remembered]);

  if (complete.isSuccess && remembered !== undefined) {
    return <Navigate to={remembered.returnTo} replace />;
  }

  if (remembered === undefined || body === undefined || complete.isError) {
    return (
      <AuthLayout>
        <AuthHeading
          badge={{ icon: AlertTriangle, tone: 'danger' }}
          title="We could not create the repository"
          description={
            remembered === undefined
              ? 'This browser tab no longer knows which project this was for. Open the project and try again.'
              : body === undefined
                ? 'GitHub sent us back without an approval. Nothing was created.'
                : errorCopy(complete.error, 'The repository could not be created.')
          }
        />
        <Link
          to={remembered?.returnTo ?? routes.home}
          className="text-body-sm text-foreground mt-6 inline-block underline"
        >
          {remembered === undefined ? 'Back to your projects' : 'Back to the project'}
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <AuthHeading title="Creating your repository" />
      <div className="mt-6 flex items-center gap-2.5" role="status" aria-live="polite">
        <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
        <span className="text-body-sm text-subdued">
          {isLoading ? 'Checking your account…' : 'Linking it to the project…'}
        </span>
      </div>
    </AuthLayout>
  );
}
