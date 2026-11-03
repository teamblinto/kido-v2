# Local Daytona

A self-hosted [Daytona](https://github.com/daytonaio/daytona) for the sandbox module (spec 010):
the control plane the API's `SANDBOX_PORT` talks to, and one sandbox to talk to. Its own Compose
project — the root `compose.yaml` (Postgres and the Redis roles) does not need it, and nothing in
Forge starts it for you.

## Start it

```bash
docker compose -f infra/daytona/compose.yaml up -d
docker compose -f infra/daytona/compose.yaml logs -f bootstrap   # until "ready"
cat infra/daytona/.generated/daytona.env >> apps/api/.env
```

The first `up` pulls the images (~1.5 GB) and the runner then pulls the default sandbox image,
`daytonaio/sandbox:0.5.0-slim`, into its own Docker-in-Docker daemon; expect a few minutes before
`bootstrap` reports ready. Every later `up` is seconds.

`bootstrap` is a one-shot service that runs again on every `up` and is idempotent. It signs in as
the built-in user, mints an API key named `forge-local` once (Daytona shows a key's value only at
creation, so it is kept in the `bootstrap-state` volume) with `write:sandboxes`, `delete:sandboxes`,
`write:snapshots` and `delete:snapshots` — a stored key missing one of those is re-minted on the
next `up`, so update `DAYTONA_API_KEY` in `apps/api/.env` when the log says so — creates a sandbox
named `forge-local`
with auto-stop off — or starts it again if it was stopped — and writes the three variables the API
and the real-sandbox suite read:

```
DAYTONA_API_URL=http://localhost:3100/api
DAYTONA_API_KEY=dtn_…
DAYTONA_TEST_SANDBOX_ID=<uuid>
```

`.generated/` is git-ignored. The API reads them from `apps/api/.env` like every other variable
(`apps/api/src/config/environment.ts`): both-or-neither, and a key in the environment is refused
whenever `DEPLOY_ENV` is not `local` (ADR 027).

## Use it

| What               | Where                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Daytona API        | `http://localhost:3100/api` (`/api/health`; Swagger at `/api`)                                                           |
| Dashboard          | `http://localhost:3100/dashboard` — `dev@daytona.io` / `password`                                                        |
| Toolbox proxy      | `http://localhost:4000/toolbox/<sandboxId>/…` (research R1)                                                              |
| Register a sandbox | `pnpm --filter @repo/api build && pnpm --filter @repo/api sandbox:register <orgId> <projectId> $DAYTONA_TEST_SANDBOX_ID` |
| Real-sandbox suite | `pnpm --filter @repo/api test -- test/sandbox-real.e2e-spec.ts`                                                          |

The real-sandbox suite registers the sandbox against a throwaway project, writes one file, reads,
lists, runs `ls`, searches for it, and removes it. Without the three variables it prints
`DAYTONA-SKIP "sandbox-real": …` and skips — a banner distinct from the `SKIPPING` one CI greps
for, so a machine without this stack is not a CI failure.

Postgres and Redis are not published on the host: Forge's own Postgres owns `5432`. The dashboard
signs in through Dex on `localhost:5556`, which is why that port is.

## Configuration

Everything has a default; `.env.example` lists the two worth changing. Copy it to `.env` in this
directory (Compose reads it from here, and it is git-ignored) only to override one:

- `DAYTONA_IMAGE_TAG` — `v0.189.0-amd64` by default. Docker Hub has no `v0.190.0` image tags for
  the API, runner and SSH gateway (the release shipped binaries only), so the last published set
  runs under the v0.190.0 compose configuration; the endpoints the adapter uses are identical
  between the two (research R1–R2). Apple Silicon needs `v0.189.0-arm64` — the runner is
  Docker-in-Docker and does not survive emulation.
- `DAYTONA_API_PORT` — `3100` by default; Forge's API owns `3000`. Changing it also changes the
  dashboard and Dex redirect URLs, and the `DAYTONA_API_URL` the bootstrap writes.

The credentials inside `compose.yaml` are the placeholders from Daytona's own compose file, the same
convention as the root `compose.yaml`: local-only and not secrets. The one secret that matters — the
API key — is minted at runtime and never committed.

## Stop, reset, rebuild

```bash
docker compose -f infra/daytona/compose.yaml down            # keep sandboxes, key, images
docker compose -f infra/daytona/compose.yaml down -v         # forget everything; next up re-pulls the snapshot and mints a new key
```

After `down -v`, remove the old `DAYTONA_*` lines from `apps/api/.env` before appending the new ones,
and re-register any project whose `sandboxes` row named the old sandbox id.

## What is not here

Daytona's compose file also ships pgAdmin, a registry UI, MailDev, Jaeger, an OTel collector and an
SSH gateway. None of them is on the path the sandbox module uses, so none of them runs here; add one
back from the upstream file if you need it.
