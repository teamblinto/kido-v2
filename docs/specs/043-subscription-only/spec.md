# 043 — Subscription-only builder, t3code-style chat, staged project start

**Status** Built and verified on kido.blinto.co, 2026-11-04.
**Architecture reference** §03 (pagination), §08 (guards), §10 (problems), §13 (tenancy).
**Depends on** 020 (BYOK), 032 (linked accounts), 041 (agent home), 042 (sandboxd).
**Supersedes** the platform-credit credential (ADR 027's `PLATFORM` mode) for new runs.

## Decisions (asked and answered, 2026-11-03)

- Platform credits are removed. A run is paid by the person's connected Claude subscription
  (041 agent home, or a 032 linked account) or by the organisation's own API key (BYOK stays as
  an alternative). With neither, the API answers `subscription-not-connected` and the web offers
  a way to connect one.
- Credit data is archived, not deleted: `credential_mode` keeps `PLATFORM` and
  `orgs.credit_balance` stays, both marked retired; no migration. Usage history shows
  "Platform credits (retired)" for those runs, and an agent-home run reads as the subscription
  whatever its unstamped mode says.
- Usage lives in Settings → Usage.
- `react-markdown` and `remark-gfm` are added for assistant text (no raw HTML).

## What changed

- **Models.** The agent home's runner asks the signed-in CLI for its own model list and limits
  (`initialize`, `get_usage` control requests; no model call) and reports them; `GET
/me/subscriptions` returns them. One model picker (home and project) lists the subscription's
  models and the organisation's key-paid catalogue, and applies to the next message; an answer
  to a waiting run carries `model`.
- **Runs.** A follow-up while the project's run awaits input answers that run instead of queueing
  behind it. A subscription run with no model uses the CLI's default. The CLI's cost per turn is
  recorded as `cost_micros`.
- **Chat.** Markdown streaming, grouped tool calls, follow-bottom with "Jump to latest", Send →
  Stop, Retry for failed runs, no "Queued" without a run, no double preview load from a replay.
- **Project start.** `GET …/preview` states `stage`; the pane walks Creating → Installing →
  Starting → Ready and frames the preview only at `ready` (no refused-TLS page before a sandbox
  exists).
- **Usage.** `GET /orgs/:orgId/usage/runs` (the caller's own runs, keyset-paged, RLS) and
  Settings → Usage with the subscription's windows and the run history.
- **Infra.** The preview edge compresses with zstd/gzip, never `text/event-stream`; the gateway
  exits when its shared network namespace is dead so Docker rejoins the api's; the not-serving
  page refreshes itself.
- **Found while verifying.** sandbox.ops job ids collided with the previous cycle's completed job,
  so a second hibernate was dropped and the row stayed `hibernating` with every run refused; job
  ids now carry the outbox event id.

## Success criteria

| Criterion                                           | Proved by                                                                                                                                                                                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nothing to pay with is a connect path, not a 422    | `refuses a run nothing can pay for as subscription-not-connected, before any write`; web `offers to connect instead of sending when nothing can pay for a run (spec 043)`                                                         |
| Models come from the subscription, never hard-coded | `asks the signed-in CLI for its own models and limits with a run's safe flags, never a prompt`; `carries the models and limits the signed-in CLI last reported, and none once signed out`                                         |
| Model switch applies from the next message          | `switches the run to a model the catalogue pays for, from this answer on`; e2e `switches the model from the answer on, and refuses one outside the catalogue (422)`                                                               |
| A follow-up answers a waiting run                   | `answers that run with the prompt and returns it, inserting no new run`; e2e `a follow-up to a run awaiting input answers it instead of queueing behind it`; web `answers a run that waits for input instead of starting another` |
| No "Queued" after a failed request                  | `keeps the prompt and claims no queued run when the run request is refused`; `claims no run state while the project has no run (spec 043)`                                                                                        |
| The preview loads once on open                      | `loads the preview once on open: a checkpoint the stream replays reloads nothing`                                                                                                                                                 |
| Staged start; frame only at ready                   | `walks the steps at creating / installing / starting, with no frame yet`; `polls until ready, then mounts the frame and stops asking`; `maps a settled %s row whose dev server reported %s to %s`                                 |
| Usage: caller's runs only, readable retired credits | e2e `another member’s and another organisation’s runs never appear`; `lists the caller’s own runs and maps what paid, the cost and the CLI default; an agent-home run is the subscription`                                        |
| Gateway recovers from a restarted api               | `declares the namespace dead after three consecutive unanswered probes past the start period`; live: `docker restart kido-api-1` → gateway rejoined in ~20 s                                                                      |
| Second hibernate is not dropped                     | `gives the second hibernate of a sandbox its own job, and a republished event the same one (spec 043)`                                                                                                                            |
| Waking page reaches the app                         | live: 202 Waking up → 503 not serving (refreshing) → 200 app, no manual reload                                                                                                                                                    |
| `installing` is a real phase                        | ✗ — dependencies are baked into the template image; the API never reports `installing`, so the step completes with creation.                                                                                                      |
