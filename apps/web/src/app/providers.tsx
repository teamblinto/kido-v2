import { QueryClientProvider } from '@tanstack/react-query';
import { type PropsWithChildren, useState } from 'react';
import { BrowserRouter } from 'react-router-dom';

import { SessionProvider } from '@/features/auth/session/session-provider';
import { createQueryClient } from './query-client';

export function AppProviders({ children }: PropsWithChildren): React.JSX.Element {
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {/* Inside the router, because signing out navigates; outside every screen, because all of
            them ask who is signed in. */}
        <SessionProvider>{children}</SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
