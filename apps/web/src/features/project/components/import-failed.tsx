import type { SyncFailureReason } from '@repo/contracts';
import { AlertTriangleIcon } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { routes } from '@/lib/routes';
import { REASON_COPY } from '../lib/github-sync';

interface ImportFailedProps {
  readonly reason: SyncFailureReason | null;
}

/**
 * A GitHub import that failed (spec 026 R2, spec 047). The import withdrew its project, so the
 * project's own routes refuse everyone, correctly; this says what happened instead, from the import
 * itself, and offers the way back. Rendered in place of the whole project screen, so nothing keeps
 * asking a deleted project for its preview, sync or presence.
 */
export function ImportFailed({ reason }: ImportFailedProps): React.JSX.Element {
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <AlertTriangleIcon className="text-danger size-6" aria-hidden="true" />
      <div className="space-y-1.5">
        <h1 className="text-heading-sm text-foreground font-semibold">The import failed</h1>
        <p className="text-body-sm text-subdued max-w-[420px]">
          {reason === null
            ? 'Something went wrong while importing the repository.'
            : REASON_COPY[reason]}{' '}
          Nothing was kept, so you can try again.
        </p>
      </div>
      <div className="flex gap-2">
        <Button asChild>
          <Link to={routes.projectNewImport}>Try again</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to={routes.home}>Back to projects</Link>
        </Button>
      </div>
    </main>
  );
}
