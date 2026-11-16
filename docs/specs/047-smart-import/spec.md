# 047 — Smart import: any repository to a working preview

**Status** Built, 2026-11-16.
**Builds on** 014 (sandbox lifecycle), 015 (templates), 023 (dev supervisor), 026 (import),
030 (preview env), 041/043 (agent runs paid by a subscription or the organisation's key),
044 (GitHub sync).

## Problem

Spec 026 imports a repository only into one of four templates, and the user has to pick one. The
dev server's command and port come from that template's manifest, so a repository that is not a
template (a pnpm monorepo, a Django app, an Astro site, a Go server) either cannot be previewed or
gets the wrong command. Nothing installs the repository's own dependencies: they were baked into
the template image, so an imported `package.json` runs against the template's `node_modules`.

## What a user sees

1. **Import → pick a repository → done.** No template, no name, no settings. The project opens at
   once and the preview pane walks Creating → Installing → Starting → Ready.
2. The project gets a readable name ("Acme Dashboard", not `acme-dash-v2`). An AI call names it
   when the person has a key or linked subscription that can pay for one; otherwise a
   deterministic name comes from the manifest or README. Renaming always wins over the automatic
   name.
3. If the app does not start, the chat shows the agent fixing it: it reads the dev server's log,
   edits code or the run settings, and the preview restarts. At most two automatic attempts per
   failure streak. If nothing can pay for an agent run, the pane says the preview failed and the
   log is one tool call away for the next run.

## Design

### The run profile is per-project data (`projects.run_config`)

This is t3code's `ProjectScript` idea: a project carries its own commands instead of inferring them
from a fixed template. One nullable `jsonb` column, validated by `runConfigSchema` (contracts):

| field     | meaning                                                                           |
| --------- | --------------------------------------------------------------------------------- |
| `stack`   | `{ language, framework, packageManager }`, for display and for the agent's prompt |
| `install` | runs at the workspace root, or null                                               |
| `root`    | the directory `dev` runs in (a monorepo's app package), relative, never `..`      |
| `dev`     | the dev server command, or null when nothing serves (a library, a script)         |
| `port`    | the port `dev` listens on; null exactly when `dev` is null                        |
| `build`   | `{ command, output }` for a static deploy, or null                                |
| `env`     | variable names the repository expects (from `.env.example`), names only           |
| `source`  | `detected` (the import) or `agent` (the agent's `set_run_config` tool)            |
| `repairs` | automatic repair runs in the current failure streak                               |

Every command is one line (no CR, LF or NUL) because it reaches the sandbox as a line in
`/tmp/forge-callback.env`; a newline there would be an injected variable.

`resolveDevServer(catalogue, { template, runConfig })` is the one reader: the run profile when there
is one, the template manifest otherwise. The five places that read `devPort`/`devCommand` (route
broker, preview reader, callback controller, sandbox service, sandbox ops) and the deploy build now
call it, so a template project behaves exactly as before.

### Detection is deterministic and runs on the worker's clone

The import runner already clones the repository on the worker. `detectRunConfig` (pure,
`connectors/stack-detector.ts`) reads a snapshot of that clone (paths to depth 4 and the
manifests), so detection costs no GitHub calls and sees the whole tree, not just the root. It
covers:

- **Node**: package manager from the lockfile or `packageManager` (npm, pnpm and yarn through
  corepack, bun through npx); Next, Vite (React/Vue/Svelte/Solid), Remix, Astro, Nuxt, SvelteKit,
  Angular, CRA, Vue CLI, Gatsby, Expo web; a plain server's `dev` or `start` script; a static
  `index.html` with no scripts.
- **Monorepos**: npm/yarn workspaces, `pnpm-workspace.yaml`, turbo and nx. Install runs at the root,
  and `dev` runs in the best app package (a web framework dependency, with `apps/web`,
  `apps/frontend` and similar names preferred).
- **Apps in a folder**: a root that names a framework but is not an app (a Next.js root with no
  `app/` or `pages/`, Vite with no `index.html`), or no root manifest at all (`client/` beside
  `server/`): the best app folder below, installed there with `cd <dir> && <install>`.
- **Ports a script sets** (`cross-env PORT=4100 react-scripts start`, `vite --port 5173`) are kept,
  and only the missing bind flags are appended, so a CLI never sees two `--port` values. A
  framework that reads `PORT` with no `dev` script runs its own dev binary, never `start`, which
  for Next.js and Nuxt is the production server.
- **pnpm build approvals**: pnpm 11+ refuses an install with unapproved build scripts, so the
  install allows them, as npm and yarn do, unless the repository manages approvals itself (pnpm
  refuses both at once).
- **Python**: requirements, Pipfile, pyproject (PEP 621 through uv, Poetry through poetry), into a
  workspace `.venv`; Django, FastAPI, Flask, Streamlit and Gradio, otherwise no preview.
- **Go, Rust, Deno**: user-space toolchains installed under `$HOME` by the install command, since
  the sandbox has no root.
- **Static sites**: `python3 -m http.server`.

Every framework is told to bind `0.0.0.0` on the chosen port, by flag or by environment, because
the preview gateway reaches the sandbox's address and not its loopback. Every value taken from the
repository and put into a command (script names, module paths, directories) has to match a
conservative pattern, or it is dropped.

### Provisioning, install and run reuse the dev supervisor

- A smart import creates the project with `template = null`. The claim still uses the warm pool,
  since every template shares `forge/sandbox-base`, and the supervisor is not launched at claim
  because there is no run profile yet.
- After the checkout, the runner runs `git clean -ffdx`, which removes the pool image's starter
  files and `node_modules` so the repository installs from a clean tree. It adds `.venv/` and
  `node_modules/` to `.git/info/exclude`, so dependencies never reach a commit or a push.
- On success the run profile is written and `project.env.changed` is appended in the same
  transaction. Spec 030 already uses that event to restart the supervisor.
- The supervisor gets `FORGE_INSTALL_COMMAND` and `FORGE_DEV_ROOT`. Before each spawn it computes a
  hash of the install command and the manifests and lockfiles. When the hash differs from
  `~/.forge/install.sha` it reports **`installing`** (the stage that had been unreachable until
  now) and runs the install. A failed install counts against the same backoff budget as a crashed
  dev server, so a pull that changes `package.json` reinstalls on the next restart and a broken
  lockfile ends in `failed`. The dev server child gets `PORT`, `HOST=0.0.0.0`, `BROWSER=none`,
  and the venv and user-space toolchains on `PATH`. These sit above the supervisor's inherited
  environment and below the project's own values.

### Self-healing

- **Deterministic**: the supervisor's existing 1–16 s backoff and five-minute cold retry, now
  covering install as well.
- **AI**: when the callback records `failed` for a project with a run profile and `repairs < 2`,
  the same transaction appends `project.preview.failed`. `PreviewRepairConsumer` starts an ordinary
  agent run, so it streams in the chat, is paid like any other run and can be stopped. The person
  who imported or last ran the project pays, through their subscription first and then the
  organisation's key. The prompt carries the stack, the run profile and the last 12 KiB of the
  dev server log. It is skipped when a run is already active. A `listening` report resets
  `repairs` to 0.
- **Restart after a fix**: a run that succeeds during a failure streak appends
  `project.env.changed` (from `RunQueueConsumer`, which already handles `agent-run.finished`). The
  fixed dev server starts at once instead of waiting out the five-minute cold retry.
- **Two new agent tools**, offered to both executors through the ToolBroker:
  - `preview_logs` returns the tail of the dev server log.
  - `set_run_config` validates a run profile with `runConfigSchema`, stores it with
    `source = 'agent'` and restarts the dev server.

### Naming

`project.naming.requested` (ids only) is appended when an import succeeds, and when a run is
created for a project whose `name_pending` is true. The web sets that flag when it names a project
after a prompt's first line. `ProjectNamingConsumer` builds its hint from the first run message or
from the repository (owner/name, the `package.json` description, the README title and first
paragraph, read from the sandbox). It asks for a 2–4 word name with a cheap model through
`CredentialResolver.forModel` and `ProviderRouter` (the person's key or linked subscription). With
neither, it uses `humanizeName`. It renames only while `name_pending` is still true, so a manual
rename always wins.

### GitHub sync

Spec 044's push, pull, autosync, branch switching and conflict reporting work on an imported project
unchanged, because the import leaves the link level at the cloned commit. `.git/info/exclude` keeps
installed dependencies out of every push. A pull that lands commits on a project with a run profile
appends `project.env.changed`, so the dev server restarts and reinstalls if the manifests changed.

### Deploy

Deployability and the build come from `resolveBuild`. A smart import with a detected static build
(Vite, CRA, Astro, Gatsby or Vue CLI at the root) deploys with its own install and build commands,
on the default build image. Anything else is `not-deployable` rather than a wrong `npm ci`. A
nested app has no static deploy yet.

## Security and limits

- No GitHub token reaches the sandbox; the clone and bundle stay on the worker (spec 026).
- A run profile is the tenant's own data and runs only in the tenant's sandbox: no root, all
  capabilities dropped, public egress only. The one-line rule stops env-file injection.
  `set_run_config` validates against the same schema as detection. The commands it stores run
  without the agent's exec allowlist, but that is no new reach: the agent can already write the
  `package.json` scripts that `npm run dev` executes in any template project.
- Repair runs are capped at two per failure streak, skipped while any run is active, and paid
  only through the person's own payment paths.
- Ruby, PHP, Java and .NET have no user-space toolchain here. Detection records the language with
  `dev: null`, the repair agent is told so, and the preview reports that this runtime is not
  available. It never claims a preview it cannot start.

## Success criteria

| Criterion                                            | Proved by                                                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Import needs no template and no name                 | contracts `start import accepts a repository alone`; web `imports with one click`                        |
| Detection covers diverse stacks and monorepos        | `stack-detector.spec.ts` (36 cases)                                                                      |
| Template projects resolve exactly as before          | `run-config.spec.ts`; the existing preview, sandbox-ops and deploy suites, unchanged in what they assert |
| A smart import stores its profile and restarts       | `import.runner.spec.ts` `a smart import detects the run profile…` (Postgres, Redis, git)                 |
| `installing` is reported and reinstall is hash-gated | `dev-supervisor.spec.ts` `install (spec 047)`                                                            |
| A failure starts at most two repair runs             | `preview-callback.controller.spec.ts` `self-healing`; `preview-repair.consumer.spec.ts`                  |
| A manual rename beats the automatic name             | `project-naming.consumer.spec.ts`                                                                        |
| Real repositories reach `listening` in the sandbox   | `smart-import-sandbox-real.e2e-spec.ts` (below)                                                          |

## Verification against the real sandbox image

`SMART_IMPORT_SANDBOX_IMAGE=forge/sandbox-base:1 pnpm --filter @repo/api exec vitest run
test/smart-import-sandbox-real.e2e-spec.ts` writes each repository, detects it with the production
detector, copies it into a fresh container of the image (uid 1000, no root), runs the production
supervisor with the env file a claim writes, and fetches the app from the container's own address.
Add `SMART_IMPORT_REAL_REPOS=1` (and `SMART_IMPORT_RESULTS=<file>` for the log) for public
repositories.

| Repository                                    | Detected                           | Outcome                                                                               |
| --------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| Vite + React (npm)                            | vite-react · npm                   | installing → listening, served                                                        |
| pnpm monorepo, `apps/web` on Vue              | vite-vue · pnpm · root apps/web    | installing → listening, served                                                        |
| Express on a literal port (yarn)              | express · yarn · port 8080         | installing → listening, served                                                        |
| FastAPI (requirements.txt, uvicorn added)     | fastapi · pip                      | installing → listening, served                                                        |
| Flask (PEP 621 pyproject)                     | flask · uv                         | installing → listening, served                                                        |
| Django (migrate, runserver)                   | django · pip                       | installing → listening, served                                                        |
| Static site                                   | static · html                      | listening, served                                                                     |
| Go (user-space toolchain)                     | go                                 | installing → listening, served                                                        |
| A dependency that does not exist              | javascript · npm                   | installing → failed (the repair trigger)                                              |
| sveltejs/realworld                            | sveltekit · pnpm                   | served, HTTP 200                                                                      |
| fastapi/full-stack-fastapi-template           | vite-react · bun · root frontend   | served, HTTP 200                                                                      |
| vercel/next-learn                             | nextjs · pnpm · root seo           | served, HTTP 200                                                                      |
| gothinkster/react-redux-realworld-example-app | create-react-app · npm · port 4100 | installs, then crashes on Node 24 (`http_parser` removed): failed, for the repair run |

The first runs found four defects that the unit suites could not, all fixed and covered:

- pnpm 11's refusal of build scripts, and its conflict with a repository's own approvals.
- An inherited `PATH` hiding the Go toolchain.
- `next start` chosen for a Next.js root.
- A course repository whose apps live in folders below the root.
