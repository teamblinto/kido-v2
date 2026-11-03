import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Wordmark } from '@/components/wordmark';
import { routes } from '@/lib/routes';

export function NotFoundPage(): React.JSX.Element {
  return (
    <main className="bg-canvas flex min-h-dvh flex-col items-center justify-center px-5 text-center">
      <Wordmark />
      <p className="text-overline text-faint mt-10 font-medium">404</p>
      <h1 className="text-display-sm text-foreground mt-2 font-semibold">
        That page does not exist
      </h1>
      <p className="text-body-md text-subdued mt-2 max-w-md text-pretty">
        The link may be broken, or the page may have moved.
      </p>
      <Button asChild className="mt-7">
        <Link to={routes.home}>
          Back to your workspace
          <ArrowRight aria-hidden="true" />
        </Link>
      </Button>
    </main>
  );
}
