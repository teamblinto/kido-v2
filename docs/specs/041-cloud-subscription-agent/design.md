# 041 — Cloud subscription agent (design)

Status: Draft · Date: 2026-11-03 · Builds on 040 (local agent bridge) and the sandbox tool
bridge in `spec.md` (same folder).

> **2026-11-03: local devices retired.** Spec 040's local agents (a person's own computer paired
> through the companion, its workspaces, the `workspace` tool mode, approvals, Codex, and the
> `localAgent` run target) were removed. BAIOS runs agents only on a person's own Claude
> subscription inside their agent home, below. What remains of 040 is the runner wire
> (`local-agent/companion.ts`) and the `local-agent` substrate the agent home uses; the companion
> package (`apps/companion`) is now only the runner, `start --hosted`. Text below that still
> describes local devices records the design as it was built.

## Goal

A person runs BAIOS's agent on **their own Claude subscription**, entirely in the cloud: nothing
to install. The model is driven through the person's own, unmodified Claude Code CLI, signed in
by the person through Anthropic's own flow, running in a **private per-person container**
("agent home"). All file and command actions happen in the **project sandbox** through BAIOS's
existing tools, so preview, checkpoints and deploy work exactly as for platform-billed runs.

## Compliance (verified 2026-11-03, code.claude.com/docs/en/legal-and-compliance)

Allowed: "preinstalling or running Claude Code in your products or services (e.g. in hosted
sandboxes or other agent infrastructure)" and "an end user signing in to the unmodified Claude
Code binary with their own Claude subscription, including where a platform hosts Claude Code".
Conditions we honour:

- Operator accepts Anthropic's Commercial Terms (business action, before launch).
- Binary installed and run as published (official installer, pinned version, auto-update off);
  no authentication method removed or disabled.
- Each person signs in with their own plan via Anthropic's flow (`claude auth login`: URL shown,
  person signs in at Anthropic, pastes the one-time code). BAIOS never collects, stores, logs or
  reuses credentials or session tokens; the one-time code transits BAIOS in memory only.
- One agent home per person; never shared; no other person's runs or app code execute there.
- No paying for, reselling or intermediating usage; plain-text "runs Claude Code" only.

Codex: hosted ChatGPT-plan auth is not permitted ("App-server authentication has never been
permitted for commercial or hosted services"). Out of scope until OpenAI "Sign in with ChatGPT"
partner approval.

## Architecture

```
Browser ─▶ BAIOS API ─▶ Agent home (Daytona sandbox, one per person)        Project sandbox
            │           runner = companion --hosted ─▶ claude -p (built-ins off)
            │             ▲ SSE commands / POST events        │ mcp__baios__* tools
            │             └──────────────────────────────────┘
            └─ LocalAgentExecutor ─ tool.call ─▶ ToolBroker ─▶ Daytona (project sandbox)
```

- **Agent home**: a Daytona sandbox created from the `agent-home` template (published through
  `TemplatePublisher`, like the project templates): Node 24 + Claude Code (official installer,
  pinned, `DISABLE_AUTOUPDATER=1`), `CLAUDE_CONFIG_DIR=/home/daytona/.claude`. Labels
  `{ baios: 'agent-home', userId, provider: 'claude' }`. `autoStopInterval: 0` (BAIOS stops
  idle homes itself — Daytona's auto-stop ignores running processes), `autoArchiveInterval`
  7 days. Disk persists across stop/start/archive, so the login survives.
- **Runner**: the companion in hosted mode (`node /opt/baios/runner.js start --hosted`). The
  runner bundle (`apps/companion/dist/main.js`) is uploaded on every start, so it is always
  current. Config by env + a 0600 token file: `BAIOS_SERVER_URL`, `BAIOS_TOKEN_FILE`. Sandbox
  tool mode only, Claude only, never runs `login` interactively. Since local devices were retired
  this is the companion's only mode: `start --hosted` is its only command (a bare `start` is
  refused), and pairing, workspaces, approvals and Codex are gone from it.
- **Device identity**: each home has a `local_agent_devices` row (kind `cloud`). A fresh device
  token is minted on every home start, written to the token file through the toolbox, and the
  previous token is revoked. The runner connects out over the existing SSE + POST protocol.
- **Egress**: optional allowlist (`AGENT_HOME_EGRESS_ALLOW_CIDRS`, CIDR-only per Daytona);
  unset in local dev. WebFetch is not offered to the model (spike: it would run inside the home).
- **Resource limits**: local Daytona runs with `RESOURCE_LIMITS_DISABLED=true`; production must
  enable limits (cpu 1–2, memory 2–4 GiB, disk 10 GiB per home). Deployment note, not code.

## Data

`agent_homes` (per person, no RLS — per-person like `local_agent_devices`):
`id, user_id (unique per provider), provider ('claude'), daytona_id, device_id → local_agent_devices,
state ('provisioning'|'stopped'|'starting'|'running'|'stopping'|'error'), last_used_at,
last_error, created_at, updated_at`. Sign-in status is not stored; it comes from the runner's
status report (`claude auth status`), cached in Redis like device status.

## Person-facing API (`/api/v1`, session + CSRF; no step-up — the sign-in is Anthropic's)

| Route                                   | Body → Response                                                           |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `GET /me/subscriptions`                 | → `{ claude: SubscriptionStatus }`                                        |
| `POST /me/subscriptions/claude/connect` | → 202 `SubscriptionStatus`; provisions/starts the home and starts sign-in |
| `POST /me/subscriptions/claude/code`    | `{ code }` (≤ 512 chars, never logged) → 202                              |
| `POST /me/subscriptions/claude/cancel`  | → 204; cancels a pending sign-in                                          |
| `DELETE /me/subscriptions/claude`       | → 204; `claude auth logout` in the home, then deletes the home            |

`SubscriptionStatus = { provider:'claude', state:'disconnected'|'provisioning'|'starting'|
'awaiting-sign-in'|'verifying'|'connected'|'signed-out'|'error', plan: string|null,
signIn: { url: string, expiresAt: iso } | null, message: string|null, updatedAt: iso }`.
`signIn.url` must be an `https://claude.com/` or `https://claude.ai/` URL (validated
server-side) and is shown to the person verbatim.

Runs: `createRunRequestSchema` gains `subscription?: { provider: 'claude' }` (mutually exclusive
with `credential`; the `localAgent` target was later removed with local devices). `model` is a Claude alias/name validated by
`localAgentModelSchema` (null → CLI default). Admission: the person's home exists and its last
status is `connected`, else problem `subscription-not-connected` (409). The run is a
sandbox-tool-mode local-agent run targeting the home's device with
`conversationKey = projectId`. The executor starts a stopped home and waits ≤ 120 s for the
runner to come online before `run.start`.

## Runner sign-in protocol (ephemeral — never in the durable command stream)

Downlink (delivered over the SSE connection from a per-device Redis pub/sub channel, not the
`local-agent:cmd:*` stream, and never persisted): `auth.login.start {provider}`,
`auth.login.code {provider, code}`, `auth.login.cancel {provider}`, `auth.logout {provider}`.
Uplink `POST /local-agent/auth` events: `auth.login.url {provider, url}`,
`auth.login.result {provider, ok, message}`, followed by a normal status report. The runner
spawns `claude auth login` with pipes, extracts the printed `https://claude.com/cai/oauth/...`
URL from the "If the browser didn't open, visit:" line, writes the code + newline to stdin,
kills the process after 10 min or on cancel, never logs the code, and re-probes
`claude auth status` (parse JSON; exit code is not reliable).

## Lifecycle jobs (cron profile)

- Idle stop: homes `running` with no active run and `last_used_at` > 30 min → stop runner, stop
  sandbox.
- Reconcile: homes whose sandbox vanished → `error`; orphan agent-home sandboxes (label) with no
  row → delete.

## Web

- Settings → "Claude subscription" card: Connect → progress → "Sign in with Claude" link
  (opens Anthropic in a new tab) + code field → Connected (plan) · Disconnect. Copy: "Runs Claude
  Code on your own Claude plan in a private cloud workspace. BAIOS never sees your Claude
  password or tokens."
- Composer: "Pay with: BAIOS · My Claude subscription" (disabled with reason when not
  connected). Preview, checkpoints, transcript unchanged.
- The 040 local-device "Run on" picker is removed from the composer, and (2026-11-03) its
  backend with it: pairing, devices, workspaces and approvals are gone.

## Deviations (as built; see spec.md § Cloud subscription agent)

- Disconnect revokes the home's device (`revoked_at`) rather than deleting it, so past runs still
  name their device, as a revoked companion's do. The home row and the sandbox are deleted.
- Home sandboxes also carry an `owner` label (`SANDBOX_OWNER`), so reconcile never deletes another
  deployment's homes on a shared Daytona.
- Node 24 rather than 20: the companion requires Node 24 or later.
- The runner bundle is uploaded as `/opt/baios/runner.mjs`, so Node runs it as ESM.
- Idle stop and reconcile run in a `cron`-profile tick under an advisory lock, not as
  `maintenance.due` jobs on a queue.
- The sign-in verdict is cached for 30 days rather than the device status's 24 hours, so a stopped
  home still admits runs. It is the home's own only: dropped when a new sandbox is created, and
  ignored when older than the current sandbox (admission, status) or the current start (sign-in).
- The 120 s start bound is a run's, and covers lock and adopt waits too; a connect's background
  start may also take the sandbox's 300 s first create. A run cancelled or fenced while its home
  starts stops waiting at once.
- Idle stop also spares a home with a `queued` run, and claims the home with a conditional update
  under its start lock.
- Egress is applied on every start (fail closed when configured) and re-applied by reconcile when
  the setting changes, not only at creation.
- Not in the design: per-person throttles on connect, code and cancel; a sweep that deletes homes
  not signed in and unused for `AGENT_HOME_UNUSED_DAYS` (14); retirement of superseded agent-home
  snapshots (current and previous kept). No plan gate: `canConnectSubscription` is the hook.
- Disconnect of an offline home starts it (≤ 45 s) to sign out; if it cannot, the home is deleted
  anyway and the status tells the person to end the session in their Claude account settings.
- An agent home runs `subscription` runs only (the `localAgent` target was removed with local
  devices).
- `AGENT_HOME_CLAUDE_VERSION` must be an exact version outside `local` (when homes are on).
