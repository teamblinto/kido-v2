# Production Monorepo

A production-ready TypeScript workspace built with Turborepo and pnpm. It contains a NestJS API, a React + Vite web client, compiled shared packages, centralized quality tooling, tests, CI, and container builds.

## Requirements

- Node.js 24 or newer
- Corepack (included with supported Node.js installations)
- Docker with Compose (optional)

## Quick start

```bash
corepack enable
pnpm install
pnpm dev
```

The web app runs at `http://localhost:5173`, the API at `http://localhost:3000/api/v1`, and Swagger UI at `http://localhost:3000/api/docs`. Vite proxies `/api` to the local API during development.

> **Reach the dev server at `localhost`, not at your machine's LAN address.**
>
> Vite is configured with `host: true`, so it prints something like `http://192.168.1.14:5173/` alongside the local URL and invites you to open it from a phone or another laptop. Signing in from that address will not work, and the reason is deliberate rather than a bug to fix.
>
> The session cookie is named `__Host-forge_session`. The `__Host-` prefix is what makes the _browser_ enforce "no `Domain` attribute, `Path=/`, and `Secure`" instead of trusting the server to have got it right — and `Secure` means the cookie is only ever sent over a trustworthy origin. Browsers treat `http://localhost` and `http://127.0.0.1` as trustworthy by special case, so the real cookie attributes work unchanged over plain HTTP there. A LAN IP gets no such exemption: the browser silently declines to store the cookie, and every request after sign-in looks unauthenticated.
>
> The fix is never to weaken the cookie. There is deliberately no `COOKIE_SECURE` switch in `apps/api/src/config/environment.ts`, because a configurable `Secure` is a configurable way to break the prefix. To reach the app from another device, put a TLS-terminating tunnel in front of it and use its `https://` origin.

### Services the API needs

Postgres and the four Redis roles come from Compose, and the schema has to be applied before the API or its integration suites will work:

```bash
docker compose up -d postgres redis-session redis-cache redis-queue redis-stream
pnpm --filter @repo/db db:migrate
```

Without them the API refuses to start and the integration suites skip with a banner that names what they did not prove — see [Testing](#testing).

The sandbox module (spec 010) additionally talks to a Daytona control plane, which is optional and its own Compose project: `docker compose -f infra/daytona/compose.yaml up -d` starts a pinned self-hosted Daytona, mints an API key, creates one sandbox and writes the three `DAYTONA_*` variables to append to `apps/api/.env`. [infra/daytona/README.md](infra/daytona/README.md) has the details; without it the API runs as before and the real-sandbox suite prints `DAYTONA-SKIP` and skips.

The connectors module (spec 018) talks to GitHub through a GitHub App, which is optional and per deployment: without the four `GITHUB_APP_*` variables the connector routes answer `oauth-provider-not-configured` and every GitHub suite runs against the in-process fixture server. To use it locally, register a throwaway GitHub App under your own account (Settings → Developer settings → GitHub Apps → New) with **Setup URL** `http://localhost:5173/connectors/github/callback`, "Request user authorization" off, no webhook, and the permissions `Contents: read & write`, `Metadata: read`, `Administration: read & write`; then put its id, client id, slug and generated private key (PEM, one line with `\n`) into `apps/api/.env`. `apps/api/.env.example` documents the six `GITHUB_*` variables, one comment line each; the example private key it ships is refused unless `DEPLOY_ENV=local`. The worker shells out to `git` for push and pull, so it must be on `PATH` (the production image installs it). The real-GitHub suite additionally wants `GITHUB_TEST_ORG`, an organisation the App is installed on; without it the suite prints `GITHUB-SKIP` and skips.

Copy environment examples before customizing local configuration:

```powershell
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/web/.env.example apps/web/.env
```

Environment files are intentionally package-local. Nest validates server variables at startup; Vite validates public `VITE_*` variables at module initialization. Never put secrets in `VITE_*` variables because Vite embeds them in browser assets.

`RUN_PROFILES` decides what a process does (spec 013): `api` serves requests and only enqueues runs; `agent` executes them; `events` drives the outbox relay and the mail consumer; `cron` runs the reaper. On a developer machine `apps/api/.env` carries `RUN_PROFILES=api,agent,events,cron` so `pnpm dev` is the whole stack in one process; Compose runs the same build twice, the `api` service with `RUN_PROFILES=api` and the `worker` service with `RUN_PROFILES=agent,events,cron`. The variable is refused at boot, before any store is contacted and with the message alone on stderr, when it is unset, names a profile outside the four, or combines `api` with a worker profile while `DEPLOY_ENV` is not `local`. There is no other switch — `OUTBOX_ENABLED` is gone.

Two variables have to agree across the pair, and both default to the same value so they only need thinking about on a deployment that changes one:

| API                | Web                     | Why it is duplicated                                                                                                                                                   |
| ------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CSRF_COOKIE_NAME` | `VITE_CSRF_COOKIE_NAME` | The web client reads that cookie and echoes it in `X-CSRF-Token`. Only code in the browser needs the name, and the browser has no other way to learn it.               |
| `CORS_ORIGINS`     | —                       | The same list backs CORS **and** the CSRF `Origin` check, so an origin missing here fails every unsafe request with `csrf-check-failed` rather than with a CORS error. |

`TURNSTILE_SECRET_KEY` and `VITE_TURNSTILE_SITE_KEY` are a pair too, and both are optional: with neither set there is no widget and no verification, which is every developer machine. Setting only one leaves a control that can never pass, or a check nothing produces a token for.

## Workspace layout

```text
apps/
  api/                 NestJS API
  web/                 React + Vite client, wired to the API through @repo/contracts
packages/
  contracts/           Zod request/response schemas and the problem-type vocabulary, shared by api and web
  db/                  Drizzle schema, hand-written RLS and grant migrations, seed
  eslint-config/       Shared flat ESLint configurations
  prettier-config/     Shared formatting policy
  types/               Compiled cross-application contracts
  typescript-config/   Shared strict TypeScript configurations
  utils/               Compiled runtime utilities
```

Package versions are maintained in the pnpm catalog in `pnpm-workspace.yaml`. Internal dependencies always use the `workspace:*` protocol. Turbo builds upstream packages before their consumers and caches deterministic outputs.

## Calling the API

Swagger UI is at `http://localhost:3000/api/docs`, and the OpenAPI document at
`http://localhost:3000/api/docs/json`, whenever `SWAGGER_ENABLED` is true.

For sending requests there is an importable Postman collection under
[`apps/api/postman`](apps/api/postman/README.md): every route, in folders that follow the
controllers, with the sign-in handshake handled by a collection pre-request script. It exists because
this API is not a bearer-token API and a hand-rolled request is easy to get wrong — a session is an
opaque cookie, and every unsafe request needs a double-submit CSRF token and an allowed `Origin`
alongside it. The script obtains both, signs in on demand, and keeps the tokens in the selected
environment. Import it, fill in `userEmail` and `userPassword` as **current** values, and send.

## Commands

| Command          | Purpose                                          |
| ---------------- | ------------------------------------------------ |
| `pnpm dev`       | Start all applications and watch shared packages |
| `pnpm dev:api`   | Start the API dependency graph only              |
| `pnpm dev:web`   | Start the web dependency graph only              |
| `pnpm build`     | Build every package in dependency order          |
| `pnpm lint`      | Run ESLint across the workspace                  |
| `pnpm typecheck` | Run strict TypeScript checks                     |
| `pnpm test`      | Run unit and integration tests                   |
| `pnpm format`    | Format tracked source and configuration files    |
| `pnpm check`     | Run the complete local CI sequence               |
| `pnpm clean`     | Remove package build output                      |

### Database

| Command                              | Purpose                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `pnpm --filter @repo/db db:generate` | Generate a migration from the Drizzle schema                              |
| `pnpm --filter @repo/db db:migrate`  | Apply migrations. Idempotent — re-running an applied migration is a no-op |
| `pnpm --filter @repo/db db:seed`     | Seed local development data                                               |

Migrations apply from an empty database. The RLS policies and role grants are hand-written SQL under `packages/db/migrations`, because generated DDL does not express them; `packages/db/src/schema/rls.spec.ts` reads `pg_class` and fails if any tenant-owned table has row-level security enabled but not **forced**.

Pass app-specific arguments with pnpm filters, for example:

```bash
pnpm --filter @repo/api test -- --watch
pnpm --filter @repo/web preview
```

## Testing

`pnpm test` runs everything. The API's suite is three layers in one command — unit, integration against real Postgres and Redis, and e2e through the full Nest pipeline — and how it behaves depends on whether those services are up.

The web app's suite needs no services. It intercepts at the request layer with `msw`, configured with `onUnhandledRequest: 'error'`, so a screen that calls an endpoint no handler describes fails loudly instead of hanging on a promise that never settles. Handlers answer with bodies the `@repo/contracts` schemas accept, which means a fixture that drifts from the contract fails in the test that uses it rather than in a browser.

| Command                                                             | What it does                                                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm test`                                                         | Everything. Integration suites **skip with a banner** if Postgres or Redis is unreachable            |
| `EXPECT_INTEGRATION=1 pnpm --filter @repo/api test`                 | What CI runs: a skipped integration suite is a **failure**, and the coverage thresholds are enforced |
| `pnpm --filter @repo/api test -- test/tenant-isolation.e2e-spec.ts` | The §17 tenant-isolation gate on its own                                                             |

A skip is never silent. On a machine with no Docker the run prints a banner naming the unreachable service and what it therefore did not prove, and `pnpm check` stays green — the skip is a deliberate allowance so the workspace is usable without containers, not a way to get a passing build.

`EXPECT_INTEGRATION=1` inverts that, and it does three things at once, which is why it is one variable rather than three: an unreachable service becomes an error, a suite that could never have run (`describe.skip`, a focused `.only`, a constantly-true `.skipIf`) fails the run before any test executes, and the coverage thresholds start binding. See `apps/api/test/support/integration-guard.ts` and ADR 022.

**Coverage** is measured on every run and reported for `src/modules/rbac/` and `src/common/crypto/` only — the two trees spec 001 requires to have no uncovered branch. There is no repo-wide percentage target. The thresholds are 100% on statements, branches, functions and lines, and they are enforced under `EXPECT_INTEGRATION=1`. Never lower one to make a build pass: an uncovered branch in `rbac/` is an authorisation path nobody has exercised, and in `common/crypto/` a key-handling path nobody has exercised.

## Production containers

Build and run the complete stack:

```bash
pnpm --filter @repo/web... build
docker compose up --build
```

Open `http://localhost:8080`. Caddy serves immutable frontend assets, provides SPA fallback routing, and proxies `/api` to the API service — flushing `/api/v1/*/stream` straight through rather than buffering it (spec 025). Its configuration is `infra/Caddyfile`, the same file the app pool runs, and the built single-page app is mounted from `apps/web/dist` rather than baked into an image of its own, which is why the build above comes first. The API image uses `pnpm deploy` to contain only production dependencies and compiled workspace packages.

The stack is `api`, `caddy`, `postgres`, `redis-session`, `redis-cache`, `redis-queue` and `redis-stream`. Every `depends_on` is `condition: service_healthy` rather than `service_started`, and the chain is deliberate: `/api/v1/health` reports Postgres and both Redis roles, so the API container's own healthcheck (`wget --spider http://127.0.0.1:3000/api/v1/health`) only passes once its dependencies are genuinely answering — and `caddy` waits on that, so a browser never reaches a page whose API is not ready. The two Redis instances are separate because their eviction policies contradict each other: `session` is `noeviction`, since an eviction there signs a user out for no reason they can see, and `cache` is `allkeys-lru` (§09).

The same localhost constraint applies here: reach the stack at `http://localhost:8080`, not at a LAN address, for the `__Host-` reason given under [Quick start](#quick-start).

For a real deployment, disable Swagger when it should not be public, set explicit CORS origins, provide secrets through the target platform, terminate TLS at the ingress/load balancer, and attach any required persistence or observability services.

## Adding packages

Create packages under `packages/`, give them an `@repo/*` name, and add them with the workspace protocol:

```bash
pnpm --filter @repo/web add @repo/new-package@workspace:*
```

Add third-party versions to the root pnpm catalog, then reference them as `"catalog:"` from package manifests. This keeps dependency policy centralized without putting application dependencies in the root package.
