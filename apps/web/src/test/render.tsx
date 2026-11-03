import { PROBLEM_TYPE_BASE_URI, type SignedInResponse } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type RenderResult, render } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { SessionProvider } from '@/features/auth/session/session-provider';
import { API, server } from './server';

export type TestUser = SignedInResponse['user'];

/** A confirmed account, which is what most screens are about. */
export const aUser: TestUser = {
  email: 'rakibul@blinto.co',
  emailVerified: true,
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  mfaEnabled: false,
};

/** A problem document shaped exactly as the API's exception filter renders one. */
export function problemResponse(slug: string, status: number, extra: Record<string, unknown> = {}) {
  return HttpResponse.json(
    {
      detail: 'A sentence about what went wrong.',
      instance: '/api/v1/test',
      requestId: '01JD0000000000000000000000',
      status,
      title: 'Something',
      type: `${PROBLEM_TYPE_BASE_URI}${slug}`,
      ...extra,
    },
    { status },
  );
}

/**
 * The `GET /auth/me` handler every render needs, because `SessionProvider` always asks.
 *
 * `null` produces the 401 a signed-out visitor gets, which is the *answer* rather than a fault —
 * `me.ts` chose a refusal over "a 200 carrying an empty user" so the two could never be confused.
 */
export function sessionHandler(user: TestUser | null) {
  return http.get(`${API}/auth/me`, () =>
    user === null ? problemResponse('unauthorized', 401) : HttpResponse.json({ user }),
  );
}

interface RenderOptions {
  /**
   * The query client to render with.
   *
   * Defaults to a bare one with retries off. Pass the application's own (`createQueryClient()`)
   * when the behaviour under test is one the client carries — the session reaction, most of all.
   */
  readonly client?: QueryClient;
  /** Extra routes, so a test can assert where a page navigated to. */
  readonly routes?: Readonly<Record<string, ReactNode>>;
  /** The path to start at, and the path the component under test is mounted on. */
  readonly path?: string;
  /** The pattern to mount the component on instead, when it reads `useParams()`. */
  readonly route?: string;
  /** Who is signed in. `null` renders as a signed-out visitor. */
  readonly user?: TestUser | null;
}

/**
 * Render a screen with the three providers the real application gives it.
 *
 * A helper rather than per-test boilerplate, because getting one of them wrong produces a failure
 * that looks like a bug in the component. The query client is built per render with retries off:
 * the production client retries 5xx twice, and a test that asserted an error state would otherwise
 * wait for both attempts before seeing it.
 */
export function renderScreen(ui: ReactNode, options: RenderOptions = {}): RenderResult {
  const {
    path = '/',
    route = path.split('?')[0],
    routes: extraRoutes = {},
    user = aUser,
  } = options;

  server.use(sessionHandler(user));

  const queryClient =
    options.client ??
    new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false, staleTime: 0 },
      },
    });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <SessionProvider>
          <Routes>
            <Route path={route} element={ui} />
            {Object.entries(extraRoutes).map(([routePath, element]) => (
              <Route key={routePath} path={routePath} element={element} />
            ))}
          </Routes>
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
