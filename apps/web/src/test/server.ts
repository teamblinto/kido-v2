import type { ModelCatalogueResponse, TemplateCatalogueResponse } from '@repo/contracts';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

/** The prefix every handler is written against, matching `apiRequest`'s. */
export const API = '/api/v1';

/**
 * `GET /api/v1/orgs/:orgId/models` as 020's contracts/byok.md § 2 writes it: the list, each entry
 * stamped with the credential a run would use, and which is default. No key stored, so all platform.
 */
export const modelCatalogue: ModelCatalogueResponse = {
  default: 'claude-sonnet-5',
  models: [
    {
      available: true,
      credentialMode: 'PLATFORM',
      description: 'Most capable · uses credits faster',
      id: 'claude-opus-5',
      name: 'Claude Opus 5',
      provider: 'anthropic',
      shortName: 'Opus 5',
    },
    {
      available: true,
      credentialMode: 'PLATFORM',
      description: 'Balanced — best default for building',
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
      provider: 'anthropic',
      shortName: 'Sonnet 5',
    },
    {
      available: true,
      credentialMode: 'PLATFORM',
      description: 'Fastest · good for small edits',
      id: 'claude-haiku-4-5',
      name: 'Claude Haiku 4.5',
      provider: 'anthropic',
      shortName: 'Haiku 4.5',
    },
  ],
};

/**
 * `GET /api/v1/templates` as spec 015 writes it: deployment-wide, one row per `PROJECT_TEMPLATES`
 * id, `ready` meaning a current version exists. `python` is unready so every screen that renders
 * the catalogue has an unpickable row to prove it explains itself.
 */
export const templateCatalogue: TemplateCatalogueResponse = {
  default: 'vite-react',
  templates: [
    {
      description: 'React and Vite — the fastest way to a screen',
      id: 'vite-react',
      name: 'Vite + React',
      ready: true,
    },
    {
      description: 'Next.js with the app router and server actions',
      id: 'nextjs',
      name: 'Next.js',
      ready: true,
    },
    {
      description: 'A headless Node service with no UI',
      id: 'node-api',
      name: 'Node API',
      ready: true,
    },
    {
      description: 'FastAPI with uv',
      id: 'python',
      name: 'Python',
      ready: false,
    },
  ],
};

/**
 * The request-layer interceptor every test shares.
 *
 * Interception rather than a mocked module, deliberately. A stubbed `apiRequest` proves the
 * component calls a function; this proves it calls the right method at the right URL with the CSRF
 * header attached and parses what actually comes back — which is the half of the wiring that can be
 * wrong. Handlers are registered per test with `server.use`, so nothing is shared but the socket
 * and the one catalogue read below, which a test overrides only when its organisation holds a key.
 */
export const server = setupServer(
  http.get(`${API}/orgs/:orgId/models`, () => HttpResponse.json(modelCatalogue)),
  http.get(`${API}/templates`, () => HttpResponse.json(templateCatalogue)),
  // Spec 032 US7: the composer reads the policy; allowed unless a test says otherwise.
  http.get(`${API}/orgs/:orgId/settings/personal-accounts`, () =>
    HttpResponse.json({ allowed: true }),
  ),
  // Spec 041: the composer asks whether the person's Claude plan is connected; not unless a test
  // says otherwise.
  http.get(`${API}/me/subscriptions`, () =>
    HttpResponse.json({
      claude: {
        message: null,
        models: null,
        plan: null,
        provider: 'claude',
        signIn: null,
        state: 'disconnected',
        updatedAt: '2026-11-03T10:00:00.000Z',
        usage: null,
      },
    }),
  ),
);
