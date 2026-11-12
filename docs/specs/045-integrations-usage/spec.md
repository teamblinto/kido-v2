# 045 — Connected services reach the agent, the preview, the build and the database

**Status** Built; unit and Postgres-backed suites green locally, 2026-11-12. Not yet verified
against live provider accounts.
**Depends on** 030 (connectors: Neon, Supabase, Netlify, Resend), 023 (dev supervisor), 027
(deploy), 041/043 (subscription runs).

## Why

Spec 030 connects the four providers and binds them to a project, but the values reached only
the sandbox dev server, at its next start. The agent was never told an integration existed. A
production build got none of the values. And no part of the product could create a table. So
"connect Supabase → the agent builds on it → preview works → deploy works" broke at every step
after the connect.

## Decisions

- **The agent is told what is connected, by env name only.** `integrationNote(keys)`
  (`sandbox/integration-note.ts`) is built from the keys `PREVIEW_ENV_SOURCE` emits. It names
  the variables, the SDK to use, and the migrations directory. No value ever enters a prompt.
  - The cloud agent carries it in the uncached `excerpts` block. `SYSTEM_PROMPT` stays
    byte-identical, so the prompt cache still holds.
  - A subscription (CLI) run has no system prompt of ours, so the note leads the turn's prompt
    (`framePrompt`). The companion protocol is unchanged.
- **A running preview restarts itself when a value changes.**
  - The trigger: when one of `neon_branch_create`, `neon_branch_reset`, `supabase_key_fetch`,
    `resend_key_mint` or `resource_release` succeeds, the same transaction appends
    `project.env.changed`.
  - `SandboxProjectConsumer` turns that event into a `sandbox.op.requested { op: 'env' }` for a
    sandbox that is `active` and not in a transition. A hibernated sandbox gets the values at
    resume, as before.
  - The `env` op rewrites `/tmp/forge-project.env`, then TERMs the supervisor's process group,
    escalating to KILL after 5 s (`STOP_DEV_SUPERVISOR`). It then launches a fresh supervisor.
  - `kill -SIG -PID` rather than `kill -SIG -- -PID`, because dash's builtin `kill` rejects `--`.
    This was verified against a real process tree under dash and bash.
- **A production build gets the browser-public values only.** These are `VITE_*` and
  `NEXT_PUBLIC_*`, i.e. the Supabase URL and publishable key, which a bundler inlines into the
  shipped files anyway. They go to the build command alone. `DATABASE_URL` and `RESEND_API_KEY`
  never reach a build, so SC-012 still holds for secrets.
- **Supabase aliases.** The same publishable key is also emitted as `SUPABASE_ANON_KEY`,
  `VITE_SUPABASE_ANON_KEY` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`, the names most Supabase code and
  imported repositories read.
- **Schema changes are migrations a person applies.** The agent writes
  `<YYYYMMDDHHMMSS>_<name>.sql` files:

  | Provider | Directory             | Applied set recorded in                                                                      |
  | -------- | --------------------- | -------------------------------------------------------------------------------------------- |
  | Supabase | `supabase/migrations` | `supabase_migrations.schema_migrations` (Supabase CLI's table, so `supabase db push` agrees) |
  | Neon     | `db/migrations`       | `forge_migrations.schema_migrations`                                                         |

  The integrations panel lists the files, marks each one applied or pending, and applies the
  pending ones. Each migration runs in its own transaction, in version order, and the run stops
  at the first failure, showing the database's message.
  - Routes: `GET …/projects/:projectId/connectors/:provider/migrations` (`project:read`) and
    `POST` on the same path (`org:connectors.manage`, audited as `connector.migrations-applied`).
  - Supabase goes through the Management API's `database/query` with the org's OAuth grant.
  - Neon connects over Postgres with the preview branch's own sealed URI.
  - The agent gets no SQL tool. A person stays in the loop, because the Supabase project may be
    production.

- **Shell output is scrubbed.** `exec` results go through `scrubSecrets` before the model, the
  event stream and `run_messages` see them. File reads stay exact, because the agent edits what
  it read.
- **Deleted organisations revoke their grants.** The sweep now revokes the Supabase grant or
  GitHub installation before deleting the connection rows, as a removal does.

## Operator setup

- **The Supabase OAuth app must grant "Database: write"**, as well as the projects read and
  secrets read it already needs. Scopes live on the OAuth app in Supabase's dashboard; the
  authorize URL does not carry them. An existing grant without it answers `missing-scope` on
  apply, and the panel offers "Reconnect Supabase".

## Known limits

- **Hosting is static.** A deployed app can use Supabase from the browser. `DATABASE_URL` (Neon)
  and `RESEND_API_KEY` work only in the preview, which has a server. The same holds for Netlify:
  publish uploads a release that own hosting built.
- **Migrations run inside the request.** A migration longer than the provider's timeout (120 s)
  fails. Move the work to a `connector.ops` job if that matters.
- **Supabase refresh-token rotation inside a failed request.** A refreshed grant is sealed in
  the caller's transaction. Committing it in a separate transaction was tried and reverted: it
  takes a second pool connection while the caller holds the first, which deadlocks under load.
  A safe fix needs the refresh moved out of request transactions.
- **Netlify** still uses the token's first account, and does not track a site it created at bind.
