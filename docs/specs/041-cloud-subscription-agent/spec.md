# 041 — Cloud subscription agent

> **2026-11-03: local devices retired.** Spec 040's local agents (a person's own computer paired
> through the companion, its workspaces, the `workspace` tool mode, approvals, Codex, and the
> `localAgent` run target) were removed. BAIOS runs agents only on a person's own Claude
> subscription inside their agent home, below. What remains of 040 is the runner wire
> (`local-agent/companion.ts`) and the `local-agent` substrate the agent home uses; the companion
> package (`apps/companion`) is now only the runner, `start --hosted`. Text below that still
> describes local devices records the design as it was built.

## Sandbox tool bridge

Every local run is in the `sandbox` **tool mode** (`local_agent_runs.tool_mode`): its tools act on
the project's sandbox, through the same broker the cloud agent uses. The `workspace` mode (the
CLI's own tools on a folder registered on a person's computer, spec 040) was removed with local
devices; rows written before then keep `workspace`.

The CLI still does the thinking, on the person's own subscription, but its
built-in file and shell tools are switched off. The companion runs a tool server (MCP) named
`baios` (`LOCAL_AGENT_SANDBOX_TOOL_SERVER`) offering exactly the tools `run.start` lists. Each
call is relayed to the API, which runs it the way the cloud agent does and sends the answer back.
Web tools the CLI keeps (WebSearch, say) are its own business: they are not on the bridge.

### Admission

Removed: a run could once be created with `localAgent: { deviceId, provider }` naming a person's
own device. A `sandbox` run is now created only through the `subscription` target (§ Runs below).
The sandbox needs nothing more at creation than a cloud run needs, which is nothing: the attempt
makes it ready.

### Attempt (API)

1. The consumer treats a `sandbox` local run like a cloud run for the sandbox. Its heartbeat
   touches the sandbox.
2. On every attempt, before `run.start`, the executor runs `SandboxTools.prepare`. This is the
   cloud agent's pre-flight, now shared code: `ensureReady` (with `sandbox.preparing` while it
   waits), a probe, and the checkpoint baseline (`ensureRepository`). A failure fails the run as
   it would a cloud run (`no-sandbox`, `sandbox unavailable: …`, `checkpoint`).
3. The command is `run.start` with `conversationKey` and `toolset`: the
   seven tools as `{ name, description, inputSchema }`. Each `inputSchema` is the tool's JSON
   Schema flattened to a root `type: "object"`.
4. Each `tool.call` is checked against the tool's own input schema and dispatched through
   `ToolBroker` inside `ctx.dispatch` (fenced, tenant scope). The run gets the same `tool.start`,
   `tool.end` and `file.patch` events as a cloud tool call, with step ids `<runId>/<n>`. The same
   step bound applies (`MAX_TOOL_CALLS`, which fails the run with `step-limit` and interrupts the
   device). So does the consumer's rule that three failed `tool.end`s in a row fail the run as
   `tool_error`, and the device is interrupted then too. The answer goes to the device as
   `tool.result`.
5. A tool call counts as activity for the idle check, both when it arrives and once it is
   answered. The cursor is saved after each answered call, so a successor attempt does not run it
   again. A call that arrives while the run is stopping gets an
   `ok: false` refusal. Events after `terminal` are never read, so a late call is ignored.
6. The CLI's own `tool.start`, `tool.output` and `tool.end` events for a bridged tool
   (`mcp__baios__<tool>`) are dropped, because the server's events are the record. Other CLI
   tools still map as they do in spec 040.
7. When the companion's `terminal` says `completed`, the executor saves the assistant text, then
   runs `SandboxTools.checkpoint`, which commits the turn as `Turn <n>` (n is the run's turn) and
   emits `checkpoint`. A commit failure fails the run with `checkpoint`.
8. Approvals are not used. The approval machinery (`approval.request`, `approval.respond`) was
   removed with local devices.

### Wire (contracts `local-agent/companion.ts`)

`run.start` (downlink) is strict. Since local devices were removed it carries no
`permissionMode`, `toolMode` or `workspaceId`, and these fields are required:

```ts
conversationKey: string /^[A-Za-z0-9_-]{1,128}$/
toolset: { name: SandboxTool; description: string (1..2000);
           inputSchema: { type: 'object', ... } }[]        // 1..7
```

`conversationKey` is the first 32 hex characters of `sha256("<orgId>:<projectId>")`. It is
opaque and the same for every run in a project. The companion runs the CLI in one empty directory
per key, so the CLI's resume, which only finds sessions saved in the same directory, keeps working
from one run to the next.

`tool.call` (uplink run event, sequenced and deduplicated like every other event):

```ts
{ type: 'tool.call', seq,
  data: { callId: string (1..100, /^[A-Za-z0-9_-]+$/),       // the companion mints call-<uuid>
          name: 'fs_read'|'fs_list'|'fs_edit'|'exec'|'search'|'find'|'preview_status',
          input: Record<string, unknown> } }                  // ≤ 262 144 chars as JSON
```

`tool.result` (downlink command):

```ts
{ type: 'tool.result', runId, turn, callId,
  ok: boolean,               // false: refused input, a sandbox refusal, or the run takes no calls
  output: string (≤ 48 000), // the tool's answer, or `kind: <kind>\n<detail>` on failure
  isError?: true }           // set with ok: false; maps onto the tool server's error flag
```

An output over 48 000 characters (`LOCAL_AGENT_MAX_TOOL_OUTPUT_CHARS`) is cut by
`truncateToolOutput`, which keeps the head and ends with
`[output truncated: the first N of M characters are shown]`. The cap sits under 50 000 because
Claude Code moves a longer tool result into a local file, and a CLI whose file tools are off
cannot read that file back. The run's own `tool.end` keeps the full output.
`LOCAL_AGENT_MAX_COMMAND_CHARS` rose to 327 680 so that the largest `tool.result` fits even when
fully escaped.

## Cloud subscription agent (as built)

The design is `design.md`; this is what the API ships, and its § Deviations lists where it differs.

### Contracts (`packages/contracts/src/local-agent/subscription.ts`)

- `subscriptionStatusSchema`: `{ provider:'claude', state, plan, signIn: {url, expiresAt} | null, message, updatedAt }`.
- `subscriptionListSchema`: `{ claude: SubscriptionStatus }`.
- `subscriptionCodeRequestSchema`: `{ code }`, where `subscriptionCodeSchema` is trimmed and
  `^[A-Za-z0-9_\-#.]{1,512}$` — no control characters or whitespace reach the CLI's stdin.
- `subscriptionSignInUrlSchema`: `https:` on `claude.com`, `claude.ai` or `platform.claude.com`,
  no port, no credentials; text that is not a URL fails the parse (it never throws).
- `subscriptionRunTargetSchema`: `createRunRequestSchema.subscription?: { provider:'claude' }`; at
  most one of `credential`, `localAgent`, `subscription`; `model` must be a plain CLI token.
- `companionAuthCommandSchema` (downlink, ephemeral): `auth.login.start`, `auth.login.code {code}`,
  `auth.login.cancel`, `auth.logout`, each with `provider:'claude'`. Not part of
  `companionCommandSchema`.
- `companionAuthEventSchema` (uplink, `POST /local-agent/auth`, cloud devices only):
  `auth.login.url {url}`, `auth.login.result {ok, message (≤ 500) | null}`.
- `COMPANION_AUTH_SSE_EVENT = 'auth'`: the SSE `event:` of the commands above; no `id:`.
- `SUBSCRIPTION_SIGN_IN_TTL_SECONDS = 600`; `localAgentDeviceKindSchema = 'local' | 'cloud'`.
- The `state` run event's `localAgentFailure` gains optional `origin: 'device' | 'subscription'`.
- Problem slugs `subscription-not-connected` (409, refines `conflict`) and
  `subscription-unavailable` (503, refines `service-unavailable`).

### Data

`agent_homes` (migration `0054_agent_homes.sql`; a root table like `local_agent_devices`: no RLS,
`forge_app` the four verbs, `forge_bypass` read): unique `(user_id, provider)` and `device_id`, an
index on `state`. `local_agent_devices.kind` defaults to `'local'`; a home's device is `'cloud'`,
never listed by `GET /me/local-agents` and not revocable there. Migration
`0055_agent_homes_start_times.sql` adds `sandbox_created_at` (when the current sandbox was created)
and `started_at` (when the current start began), which bound which sign-in verdict counts. Two
connects racing to create the home end with one row: the loser's transaction (and its device) rolls
back and it reads the winner's.

### Agent home

- Image: the `agent-home` system template (`apps/api/templates/agent-home/`), published by
  `TemplatePublisher` like a project template: `pnpm --filter @repo/api template:publish --
agent-home` (`all` still means the four project templates). The catalogue loads system templates
  but never offers them: not in `all()`, the pool, the sandbox reconciler or `/templates`. Its
  `install.sh` installs Node 24 from nodejs.org (checksum-verified) when the base's Node is older
  than 24 (the companion requires 24), then Claude Code with the official installer at
  `AGENT_HOME_CLAUDE_VERSION`, and gives `/opt/baios` to the sandbox user. The manifest's
  `{{AGENT_HOME_CLAUDE_VERSION}}` is filled before the digest is taken, so a new version is a new
  snapshot. The install outlasts one HTTP exchange (Node's fetch gives up on headers after 300 s;
  the Claude Code download alone took over 4 minutes on the local stack), so the manifest sets
  `installInSession: true`: the publisher runs it detached in the daemon session `forge-install`
  and polls `/tmp/forge-install.exit` (still bounded by `buildTimeoutMs`). The flag is how the
  install runs, not what it builds, so it is not part of the digest.
- Sandbox: labels `{ baios:'agent-home', owner: SANDBOX_OWNER, provider, userId }`,
  `autoStopInterval` 0, `autoArchiveInterval` 10 080 minutes. No `forge.owner` label, so the
  sandbox reconciler never takes a home for its own orphan.
- Egress: `AGENT_HOME_EGRESS_ALLOW_CIDRS` is applied (Daytona `network-settings`, idempotent) on
  **every** start, before the runner starts; the applied list is remembered in
  `local-agent:home-egress:<deviceId>`. With an allowlist configured, a failure to apply fails the
  start (fail closed). Reconcile re-applies it to a running home whose remembered list differs (the
  setting changed), and stops that home if it cannot. Unset and never applied: nothing is sent.
- Start (`AgentHomeService`): one start (or stop) per home across processes — a Redis `SET NX` lock
  holding a random token, released by a compare-and-delete script, so a holder that outlived its TTL
  never frees someone else's lock; callers in one process share one start. A run's start is bounded
  by one 120 s budget (`onlineMs`) covering the wait for another holder's lock, the create or the
  adopt of a sandbox a timed-out create still made, the sandbox reaching `started`, and the runner's
  presence. `started_at` is stamped; the sandbox started, or created from the current `agent-home`
  version when it is missing — which drops the cached verdict and stamps `sandbox_created_at`; a fresh
  `bld_` token whose digest replaces the device's (the previous token dies with it); the bundle
  uploaded as `/opt/baios/runner.mjs` and the token as `/opt/baios/token` (`chmod 600`); then the
  daemon session `baios-runner` (re-created, which kills an older runner) runs
  `node /opt/baios/runner.mjs start --hosted` with `BAIOS_SERVER_URL`, `BAIOS_TOKEN_FILE`,
  `CLAUDE_CONFIG_DIR=/home/daytona/.claude`, `DISABLE_AUTOUPDATER=1`, `~/.local/bin` on `PATH`, and
  `BAIOS_ALLOW_INSECURE_HTTP=1` only under `DEPLOY_ENV=local`, logging to `/opt/baios/runner.log`.
  A start that fails marks the home `error`; a runner that reports after all (`POST
/local-agent/status`) moves it back to `running`.
- Runner bundle: read from `AGENT_HOME_RUNNER_BUNDLE`, by default `apps/companion/dist/main.js`
  resolved from the API's own directory; the API never imports the companion. Turbo's
  `@repo/api#build` depends on `@repo/companion#build`, and the API image builds the companion and
  ships the bundle at `/app/runner/main.js` with `AGENT_HOME_RUNNER_BUNDLE` set to it.

### Sign-in: the code stays ephemeral

- `connect` answers 202 at once and provisions and starts the home in the background (its start
  may also take `sandboxReadyMs`, 300 s, for a first create). Once the runner is online, the API
  waits up to `reportMs` (10 s) for a verdict given since `started_at`; unless that verdict is
  `authenticated`, `auth.login.start` is sent. A verdict from before the start never skips it.
- Every sign-in command is a Redis `PUBLISH` on `local-agent:auth:<deviceId>` (stream Redis). The
  command stream subscribes a cloud device's connection to that channel before it claims presence,
  and writes each message as `event: auth` with no `id:`. Nothing is stored: not the durable
  `local-agent:cmd:*` stream, no Redis key, not Postgres, not the audit trail, not a log. A code
  published to no subscriber is refused with `409`, and the person pastes it again.
- Request logs: `req.body.code` is a redaction path, and the scrubber's `code` key rule is the
  second net. A refused code's `422` names the rule, never the value.
- Kept briefly in stream Redis (TTL 600 s): `local-agent:sign-in:<deviceId>`, the phase
  (`requested`, `url`, `verifying`, `failed`), the Anthropic URL and its expiry. The runner's
  verdict (`claude auth status`: status, plan; no identifiers) is kept in
  `local-agent:home-auth:<deviceId>` for 30 days and refreshed by every report, so a stopped home
  still admits runs. Its `checkedAt` is when this server received it (not the runner's clock), so it
  compares with `sandbox_created_at` and `started_at`. It is dropped whenever a new sandbox is
  created and when reconcile finds the sandbox gone; admission and the status ignore a verdict older
  than the current sandbox.
- `auth.login.result ok:true` only moves the sign-in to `verifying`. Connected is the next status
  report's `authenticated`, which also clears the sign-in. The status message never repeats the
  runner's own provider message.

### Status

With no home: `disconnected`, with the disconnect note below when there is one. Otherwise, in
order: the home in `error` → `error` with its reason; a live URL → `awaiting-sign-in`;
`verifying` (→ `connected` once the verdict is authenticated); the home `provisioning` or
`starting`, or a sign-in requested with no URL yet → `provisioning` / `starting`; an authenticated
verdict → `connected` with the plan; otherwise `signed-out` with a failed sign-in's message or
"Sign in again to reconnect your Claude subscription.". With the feature off, `GET` answers
`disconnected` ("Not available on this deployment.") and the other routes
`subscription-unavailable`.

### Abuse and disconnect

- Per person, fixed windows in stream Redis (`local-agent:home-throttle:<action>:<userId>`):
  `connect` 5 an hour, `code` 10 and `cancel` 10 per 10 minutes; past it, `rate-limited` (429,
  `Retry-After`). There is no plan or entitlement check: `AgentHomeService.canConnectSubscription`
  is the one hook for it and answers true (product decision).
- Disconnect signs the CLI out first (`auth.logout`, then up to `reportMs` for a report given since
  it was sent that is not `authenticated`). A home that is away is started for it, at most
  `disconnectStartMs` (45 s), never creating a sandbox that is gone. If the logout cannot be
  confirmed the home is deleted anyway, and the person's status (`disconnected`) carries, for 7
  days, a message that they can end the session from their Claude account settings.
- Malformed JSON, and every other `body-parser` 4xx, is a `400` (or the parser's own 4xx) problem
  whose detail is the catalogue title: the parser's message, which quotes the body, is neither
  answered nor logged.

### Runs

`subscription: {provider:'claude'}` is admitted by `LocalAgentExecutor.admitSubscription`: the
person's home exists, is not in `error`, and its verdict is `authenticated`, else
`subscription-not-connected`. It is recorded as a `sandbox` local run on the home's device. The
sandbox tool mode is Claude only. (The `localAgent` target, which named a person's own device, was
removed with local devices.) On every
attempt the executor re-authorises first (device, starter's `project:agent.run`), so a run that
may no longer run never wakes a home; then `AgentHomeService.wake` bumps `last_used_at` and starts
a stopped home, waiting at most 120 s in all (else the run fails `transport`). The wait ends at
once on the run's cancel (the run is `stopped`) or fence; the start itself carries on, bounded.
`last_used_at` is touched again at the end of the attempt. Every local
run failure carries `localAgentFailure.origin`; a subscription run's `auth`, `transport` and
`policy` reasons are rewritten in Settings terms and never name the companion.

### Lifecycle (`AgentHomeScheduler`, `cron` profile)

Each minute, under `pg_try_advisory_xact_lock(7304101)`: idle stop — a running home unused past
`AGENT_HOME_IDLE_MINUTES`, with no queued, starting or live run and no sign-in under way, is taken
under its start lock and claimed by a conditional update (`running` and still unused → `stopping`),
so a run that touched it meanwhile keeps it; then its runner session and sandbox are stopped and
its presence forgotten. A sandbox Daytona will not stop leaves the home `error` with the reason.
Every fifth tick: reconcile over `baios=agent-home, owner=SANDBOX_OWNER` — a home whose sandbox is
gone goes to `error` with the id cleared and its verdict forgotten (connect recreates it); an
unclaimed home sandbox older than 10 minutes is deleted; a running home's egress is re-applied if
the setting changed. Then the unused sweep — a home whose verdict is not `authenticated` (never
signed in, or signed out; a verdict expires after 30 days) and unused (`last_used_at`, else created)
for `AGENT_HOME_UNUSED_DAYS`, with no run or sign-in under way, is deleted as a disconnect deletes
it (device revoked, sandbox and row deleted) under its start lock. Then superseded `agent-home`
snapshots retire as a project template's do (snapshot removed, row `retired`), keeping the current
version and the one before it.

### Environment

`AGENT_HOME_ENABLED` (default on under `local`; also needs `LOCAL_AGENT_ENABLED`),
`AGENT_HOME_SERVER_URL` (local default `http://host.docker.internal:3000`; https elsewhere when
enabled), `AGENT_HOME_RUNNER_BUNDLE`, `AGENT_HOME_CLAUDE_VERSION` (`stable`, `latest` or `x.y.z`;
an exact `x.y.z` outside `local` when enabled — it is in the template's digest, so a new version is a
new snapshot), `AGENT_HOME_EGRESS_ALLOW_CIDRS` (at most 10 IPv4 CIDRs), `AGENT_HOME_IDLE_MINUTES`
(30), `AGENT_HOME_UNUSED_DAYS` (14).
