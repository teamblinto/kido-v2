# 040 — Local Agent Bridge (run agents on the person's own subscription)

Status: Draft · Owner: platform · Date: 2026-11-02

## 1. Problem

People want to run BAIOS agent work on the Claude or ChatGPT/Codex subscription they already
pay for, without creating API keys. A web app cannot spawn processes, and provider terms forbid
a third-party service from collecting, storing or relaying subscription credentials. The only
compliant shape is: the person's **own, unmodified, self-authenticated official CLI** runs on
**their own machine**, and BAIOS only sends it prompts and renders what it streams back.

## 2. Provider compliance (verified 2026-11-02 — re-verify before each release)

| Provider               | Allowed in BAIOS                                             | Conditions                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code (`claude`) | Yes, default **on**                                          | Unmodified binary installed by the person; login only via `claude auth login` / `/login`; BAIOS never reads, stores, asks for or relays tokens (`setup-token` output included); one person per account, no pooling/resale; no Claude/Anthropic marks in our product name/logo ("runs Claude Code" in plain text is fine); BAIOS operator accepts Anthropic Commercial Terms. Source: code.claude.com/docs/en/legal-and-compliance, /authentication, /cli-reference. |
| Codex CLI (`codex`)    | Yes, but **ChatGPT-plan auth is policy-gated, default deny** | OpenAI: "App-server authentication has never been permitted for commercial or hosted services" (learn.chatgpt.com/docs/app-server). A Codex CLI signed in with an API key (the person's own, held by the CLI) is allowed. ChatGPT-plan auth is enabled only when `LOCAL_AGENT_CODEX_CHATGPT_AUTH=allow`, which the operator may set only for local/open-source deployments or after OpenAI "Sign in with ChatGPT" partner approval.                                 |
| Gemini CLI             | No                                                           | Consumer tiers no longer serve Gemini CLI (June 2026); Google bars third-party use of its OAuth.                                                                                                                                                                                                                                                                                                                                                                    |

Login state is checked **only** through official commands (`claude auth status`, Codex
app-server `account/read`). Credential files and OS keychains are never opened.

### Existing code that conflicts with this policy (out of scope here, flagged)

- `apps/api/src/modules/agent/byos/` with Anthropic OAuth: BAIOS-held subscription grants in
  `linked_accounts` = "collect, store, or intermediate Claude.ai credentials". Must not ship
  for Anthropic; OpenAI equivalent needs partner approval.
- Local `ANTHROPIC_BASE_URL=http://localhost:20128` subscription proxy (`agent.module.ts`
  `proxyFetch`): routes API traffic through plan credentials. Local hack; should be removed.

## 3. Architecture

```
 Browser (BAIOS web)            BAIOS API + worker                 Person's machine
 ───────────────────            ───────────────────                ─────────────────────────────
 session cookie + CSRF  ──────▶ /api/v1/... (existing)
 EventSource run stream ◀────── run events (Redis stream, PG)
                                LocalAgentExecutor (worker) ◀─┐
                                   │ publishes commands       │ companion events (Redis)
                                   ▼                          │
                                cmd stream per device ──SSE──▶ baios-companion (outbound only)
                                ingest controller ◀──HTTPS POST─┘   │ stdio
                                (device bearer token)               ├─ claude -p (stream-json)
                                                                    └─ codex app-server (JSON-RPC)
```

Decisions (ADR):

1. **Companion dials out; it never listens on the network.** The browser never talks to
   localhost. Rejected alternative — browser ⇄ `http://127.0.0.1` companion: Chrome Local
   Network Access prompts, Safari mixed-content blocking, DNS-rebinding and drive-by
   localhost attacks, and it bypasses BAIOS's durable run log. Outbound HTTPS works through
   NAT/proxies on Windows, macOS and Linux with zero inbound firewall changes.
2. **Downlink = SSE, uplink = HTTPS POST.** Reuses the hand-rolled SSE pattern
   (`run.controller.ts`), adds no runtime dependency (no WebSocket stack on either side;
   Node 24 `fetch` streams SSE).
3. **Device pairing modelled on OAuth device authorization (RFC 8628).** Companion obtains a
   `deviceCode` (secret) + `userCode` (shown to the person); the signed-in person approves the
   `userCode` in BAIOS (session + step-up); companion polls and receives a device token once.
   Device tokens: 256-bit random, prefixed `bld_`, stored server-side only as SHA-256, scoped
   to one person, revocable, `lastSeenAt` tracked. Pairing state lives in Redis (TTL 10 min);
   every write to it checks the pairing still exists (a Lua script), so none is re-created
   without its TTL. Against a phished code: the preview shows when the code was requested and
   from which network (IPv4 /24 or IPv6 /48, the rest zeroed) with the warning "Only approve if
   you just ran `baios-companion pair` on your own computer"; the web's Approve stays disabled
   until the person types the code (a `?code=` link only pre-fills the lookup); and a new
   pairing mails the person (`mail.local-agent-paired` through the outbox) with a link to revoke.
   The preview path `/me/local-agents/pairings/:userCode` is redacted in request logs.
4. **The local agent is a `RunExecutor`.** A run created with a `localAgent` target is executed by
   `LocalAgentExecutor` in the worker: it publishes `run.start` to the device's command stream,
   then consumes the run's companion-event stream and maps each event through `ctx.emit`.
   Fencing, cancellation, persistence, SSE replay and the web transcript are all reused. Whether a
   run is local is read from `local_agent_runs` (independently of `LOCAL_AGENT_ENABLED`): a local
   run never falls back to the cloud executor — with local agents off it fails with a reason, and
   its input route refuses it. Each follow-up answer is a new **turn** of the same run (turn =
   the number of user messages): `run.start` carries `turn`, the companion dedupes on
   (run, turn), and the server keeps each turn's events in a stream of their own. The turn is
   opened (`beginTurn`) and `run.start` published under the run's fence, so a stale worker sends
   nothing; the requested permission mode is `local_agent_runs.permission_mode`.
5. **The server never sends filesystem paths.** The person registers workspaces locally
   (`baios-companion workspace add <path>`); the server refers to them by opaque
   `workspaceId`. The companion rejects unknown ids.
6. **Permission ceiling is local.** The companion config holds `maxPermissionMode`
   (default `default` = every risky tool needs approval). The server may request a mode at or
   below it; `bypassPermissions` is impossible unless the person sets it locally.
7. **Approvals round-trip through BAIOS.** Claude: `--permission-prompt-tool
mcp__baios__approve` backed by a stdio MCP server that is the companion itself
   (`baios-companion mcp-approval`), linked to the parent over a per-run named pipe / Unix
   socket with a random token. Codex: native `item/*/requestApproval` server requests.
   Pending approvals time out (default 10 min) → deny. A resolution is idempotent per request:
   the executor emits `approval.resolved` and writes it under the fence before dropping the
   request from Redis, so a fenced worker leaves it for its successor; a worker that dies between
   the two has its successor resolve it again, and the web keeps the latest resolution.
8. **Login stays in the official CLI on the person's machine.** `baios-companion login claude`
   runs `claude auth login` with inherited stdio; `login codex` runs `codex login`
   (`--device-auth` when no display). BAIOS web shows status and the exact command; it never
   proxies a login or terminal.
9. **Provider resume references only.** BAIOS stores the provider's session/thread id per run
   (`--resume <id>` / `thread/resume`) as an opaque reference; the conversation of record is
   BAIOS's run log.
10. **Policy enforced twice.** Server computes per-provider `policy` (`allowed` | `blocked` +
    reason) from config and the companion-reported auth method — at admission and again at the
    start of every turn, against the device's current report (so a Codex CLI switched to a
    ChatGPT plan mid-conversation is refused where that is denied); the companion re-checks before
    every spawn using policy it received in `hello`.

### Authorisation

A local run executes on its **starter's** computer with the starter's sign-in, so
`project:agent.run` — which every other editor of the project also holds — is not enough to act
on it. Only the starter may send it input (`POST …/runs/:runId/input`) or answer its approvals
(`403 forbidden` for anyone else). Cancel stays open to every member with `project:agent.run`:
stopping a run is always safe. On every attempt the executor re-checks that the device still
belongs to the starter and is not revoked, and that the starter still holds
`project:agent.run` in the project; the device check repeats at each idle tick. A failed check
fails the run (`local-agent revoked` / `local-agent access`) without sending anything to the
device.

Threat model: a compromised BAIOS server or a stolen device token must not be able to exceed the
person's local ceiling, leave the registered workspaces, inject CLI arguments, or exfiltrate
secrets more easily than strictly necessary. The companion therefore enforces locally, whatever
the server sends:

- **No argument injection.** Every argv value that came from the server is a plain token
  (`localAgentModelSchema`, `localAgentProviderSessionIdSchema`: no leading `-`, no whitespace or
  quoting), validated by the contract on receipt and again by the adapter before spawning, and
  passed as `--flag=value` (Claude's `--resume` takes an _optional_ value). Codex receives these
  values inside JSON-RPC; its argv is only `app-server`.
- **`plan` is read-only locally.** Claude: the prompt tool denies, without asking BAIOS, every tool
  but `Read`, `Grep`, `Glob`, `LS`, `TodoWrite` (so `ExitPlanMode` too). Codex: command and
  file-change approvals are declined locally.
- **`acceptEdits` never auto-approves a sensitive or outside write.** Claude runs in the CLI's
  `manual` mode (its own `acceptEdits` would bypass the prompt tool); the companion allows an edit
  itself only when its target, resolved symlink-safe (OS realpath of the nearest existing
  ancestor), lies inside the workspace and outside `SENSITIVE_PATHS` (`.git/`, `.claude/`,
  `.codex/`, `.vscode/`, `.idea/`, `.husky/`, `.github/workflows/`, `.env*`, `package.json`,
  `.npmrc`, `.mcp.json`, `.gitmodules`). Codex: the same rule for `fileChange` approvals.
- **Approvals show what runs.** The workspace root appears as `<workspace>` and home as `~`; a
  command over 8 KB is denied rather than shown cut, other cut details say `(truncated)`. A Codex
  allow is only ever `accept` (never `acceptForSession`).
- **Secrets.** Tool input/output, tool summaries, approval details and streamed text are scrubbed
  of credential-shaped strings (private-key blocks, well-known key prefixes, JWTs, long bearer
  tokens) and absolute home paths before upload; ordinary text is left intact.
- **Bounded.** At most `maxConcurrentRuns` (default 2) runs at once; one probe per provider at a
  time; no redirects followed on any request; oversized commands skipped.

### Residual risks

- **Reads outside the workspace (Codex).** In `untrusted`, Codex runs commands it classifies as
  safe reads (`cat`, `grep`, `rg`, `ls`, …) without asking, on any path, and Codex 0.162.1's
  app-server cannot restrict sandbox reads: its `SandboxPolicy` (`readOnly`, `workspaceWrite`)
  has no readable-roots field, and the documented `readOnlyAccess: {type:'restricted',
readableRoots}` is absent from 0.162.1's generated schema (an unknown field could be silently
  ignored, so it is not sent). The only other route, named permission profiles via the
  experimental `permissions` field, is beta and undocumented for config, and it is not used. A
  prompt-injected or malicious instruction can therefore read anything the person's account can,
  and the text can reach BAIOS as tool output. Re-check on each Codex upgrade and adopt
  restricted readable roots once the app-server schema has them.
- **Reads outside the workspace (Claude).** Claude Code asks before reading outside its cwd, but
  that question goes to BAIOS, so a compromised server can approve it.
- **Server-approved actions.** In `default`, whatever BAIOS approves runs. The local ceiling and
  the rules above bound what a compromised server can do without the person, not what it can do
  through approvals.
- **Scrubbing is best effort.** A secret split across two streamed deltas, or in an unusual
  format, is not caught.
- **A phished pairing code.** Someone who gets a person to approve a code they did not start
  gains a device on that person's account. The preview's time and network, the typed-code
  confirmation, the warning and the pairing mail make it unlikely and visible; it is not
  impossible.

Hence the companion's `status` and help tell people to run it only while they trust their BAIOS
organisation and to register only the folders agents should work in.

## 4. Contracts (`packages/contracts/src/local-agent/`)

All `z.strictObject`, named exports. Shapes below are normative; names may be adjusted to
house style.

- `LOCAL_AGENT_PROVIDERS = ['claude', 'codex']`.
- `localAgentProviderStatusSchema`: `{ provider, installed: boolean, version: string|null,
auth: { status: 'authenticated'|'unauthenticated'|'unknown', method:
'subscription'|'api_key'|'cloud_provider'|'unknown'|null, plan: string|null },
policy: { allowed: boolean, reason: string|null }, models: {id,label}[],
message: string|null, checkedAt }`. No email or account identifiers.
- `localAgentWorkspaceSchema`: `{ id, label }` (no path).
- `localAgentDeviceSchema`: `{ id, name, platform: 'windows'|'macos'|'linux', companionVersion,
online: boolean, lastSeenAt|null, createdAt, providers: status[], workspaces: workspace[] }`.
- Pairing: `startPairingRequest {name, platform, companionVersion}` →
  `{deviceCode, userCode, verificationUri, expiresAt, intervalSeconds}`;
  `pairingTokenRequest {deviceCode}` → `{status:'pending'|'denied'|'expired'} |
{status:'approved', deviceId, deviceToken}`; `approvePairingRequest {userCode}`;
  `pairingPreview {name, platform, companionVersion, expiresAt, requestedAt, requesterIp}`
  (shown before approval; `requesterIp` is the coarse network, or null).
- Run target added to `createRunRequestSchema`: optional `localAgent: { deviceId, provider,
workspaceId, permissionMode?: 'default'|'acceptEdits'|'plan' }`; `model` is the provider's
  model id/alias and, with `localAgent`, must match `localAgentModelSchema` (else
  `validation-failed`).
- Downlink command union `companionCommandSchema` (SSE `id:` = stream seq for resume):
  `hello {deviceId, policy, heartbeatSeconds}` · `status.refresh` ·
  `run.start {runId, turn, provider, model, workspaceId, permissionMode, prompt, resume:
{providerSessionId}|null}` · `run.input {runId, message}` · `run.interrupt {runId, turn}` ·
  `approval.respond {runId, requestId, decision:'allow'|'deny', message?}` · `device.revoked`.
  `policy` is a partial record (a provider left out is not allowed); `heartbeatSeconds` ≤
  `LOCAL_AGENT_MAX_HEARTBEAT_SECONDS` (300); `model` and `providerSessionId` match the argv-safe
  token schemas above; one command's SSE `data:` is at most `LOCAL_AGENT_MAX_COMMAND_CHARS`
  (262 144 characters), and the companion skips (and acknowledges past) anything larger.
- Uplink: `companionStatusReport {companionVersion, providers[], workspaces[]}`;
  `companionRunEventBatch {turn, events: companionRunEvent[]}` where `turn` (int ≥ 1) is the
  `run.start` it answers and each event carries a per-turn monotonically increasing `seq` from 1
  (server dedupes per turn, making retries idempotent; another turn's batch is refused):
  `session {providerSessionId}` · `text.delta {text}` · `reasoning.delta {text}` ·
  `tool.start {toolId, name, input}` · `tool.output {toolId, chunk}` ·
  `tool.end {toolId, ok, summary}` · `file.change {path, kind}` (path relative to workspace) ·
  `approval.request {requestId, kind:'command'|'file_change'|'tool', title, detail}` ·
  `usage {inputTokens, outputTokens}` · `terminal {status:'completed'|'interrupted'|'failed',
failure?: {class:'auth'|'usage_limit'|'provider'|'transport'|'crash'|'policy'|'workspace',
message, resetsAt?}}`.
- The `state` event of a failed local run carries `localAgentFailure: {class:
CompanionFailureClass, provider}`; the web picks its remedy (sign-in command, start command)
  from it. The free-text `reason` keeps naming the fixing command, and the web still reads it for
  events written before the field existed.
- New durable `RunEvent` variants: `approval.request` and `approval.resolved
{requestId, decision, by:'user'|'timeout'|'run-ended'}`; web posts decisions to
  `POST /orgs/:orgId/projects/:projectId/runs/:runId/approvals/:requestId`.
- New problem slugs (each with a web message): `local-agent-offline`,
  `local-agent-provider-unavailable` (not installed / not signed in / policy blocked),
  `local-agent-workspace-unknown`, `local-agent-pairing-invalid`, `local-agent-revoked`.

## 5. HTTP surface (`/api/v1`)

Person-facing (session cookie, CSRF):

- `GET /me/local-agents` · `DELETE /me/local-agents/:deviceId` (step-up)
- `GET /me/local-agents/pairings/:userCode` (preview) · `POST /me/local-agents/pairings/approve`
  (step-up) · `POST /me/local-agents/pairings/deny`
- `POST /orgs/:orgId/projects/:projectId/runs/:runId/approvals/:requestId`
  (`project:agent.run`, and the caller must be the run's starter)

Companion-facing (`@Public()` + `DeviceTokenGuard`, `Authorization: Bearer bld_…`, no cookies,
CSRF-exempt, throttled):

- `POST /local-agent/pairings` and `POST /local-agent/pairings/token` (unauthenticated,
  strict throttle)
- `GET /local-agent/connect` (SSE command stream, `Last-Event-ID`, heartbeat 15 s)
- `POST /local-agent/status` · `POST /local-agent/runs/:runId/events` (device must own the run;
  accepted only while a worker holds the run — `starting`/`running`/`tool_error` — and the
  batch's `turn` is the active one, else `409`; at most 32 MiB of event JSON per turn, past
  which `413 payload-too-large` and the run is failed). Throttled per address and per device id.

Presence: a Redis key per device with TTL (45 s) refreshed by the open SSE connection. The same
heartbeat re-reads the device row and ends the stream with `device.revoked` once it is revoked
or gone.

Known gap: pairing and revocation are account-scope events with no organisation, and
`audit_log` requires one, so they go only to the structured log (device and person ids, never a
token), not the audit trail.

## 6. Failure model

| Situation                      | Behaviour                                                                                                                                                                                                                                                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Companion offline at run start | Run fails fast `local-agent-offline` (after 10 s grace).                                                                                                                                                                                                                                                                           |
| Companion never picks it up    | No companion event within 30 s of `run.start` → interrupt, fail `transport` ("did not pick the run up"), even while the device stays online.                                                                                                                                                                                       |
| Turn runs too long             | A turn past `LOCAL_AGENT_MAX_RUN_SECONDS` (default 6 h) is interrupted and failed, however busy the device. Counted from the turn's start, across re-claims.                                                                                                                                                                       |
| Too much output                | Past 32 MiB of event JSON in one turn the uplink answers `413` and the run is interrupted and failed.                                                                                                                                                                                                                              |
| Local agents turned off        | A local run already created fails ("local agents are not enabled") rather than reaching the cloud executor; its input route refuses it.                                                                                                                                                                                            |
| Companion disconnects mid-run  | CLI keeps running locally; companion reconnects (jittered backoff 1→30 s) and resumes posting buffered events (seq dedupe). If no events/heartbeat for 120 s the executor fails the run `transport`.                                                                                                                               |
| CLI not installed / signed out | Status shows it with the exact command (`baios-companion login claude`). Mid-run auth failure → `terminal failed {class:'auth'}` → run failure with fix hint.                                                                                                                                                                      |
| Usage limit                    | `failed {class:'usage_limit', resetsAt}` → existing `subscription-limited` UI.                                                                                                                                                                                                                                                     |
| CLI crash                      | `failed {class:'crash'}` with last stderr lines (scrubbed).                                                                                                                                                                                                                                                                        |
| Cancel                         | Executor sees `cancelled()` → `run.interrupt` → Claude: interrupt then process-tree kill after 5 s; Codex: `turn/interrupt`. Outcome `stopped`.                                                                                                                                                                                    |
| Device revoked                 | Token rejected (401) → companion stops and asks to re-pair. Every run the device may be executing is aborted at once through its control stream (interrupt + fail `local-agent revoked`); a revocation that bypassed that (row changed directly, account deleted) is caught at the next idle tick and the stream's next heartbeat. |

## 7. Companion (`apps/companion`, `@repo/companion`, bin `baios-companion`)

Plain Node ≥ 24 ESM; runtime deps only `zod` + `@repo/contracts` (bundled). Commands:
`pair --server <url> [--name]`, `start`, `status`, `login <claude|codex>`,
`workspace add <path> [--label] | remove <id> | list`, `unpair`, `mcp-approval` (internal).
Config dir: Windows `%APPDATA%\BAIOS\companion`, macOS
`~/Library/Application Support/BAIOS/companion`, Linux `${XDG_CONFIG_HOME:-~/.config}/baios/companion`;
token file written with mode 0600. Server URL must be `https:` (loopback `http:` allowed
for development). Binary resolution: PATH lookup honouring `PATHEXT` on Windows (prefer
`.exe`; `.cmd` shims via `cmd.exe /d /s /c` with strict argument quoting), configurable
override. Process-tree kill: `taskkill /T /F` on Windows, process-group kill on POSIX.
Provider adapters implement one interface (`probe()`, `startRun()` → handle with
`input()`, `interrupt()`, `respondApproval()`, async event iterator) so new CLIs plug in
without touching transport code.

## 8. Out of scope (v1)

Context hand-off when switching provider mid-conversation (a provider switch starts a new
run whose prompt carries the run's transcript summary — later); multi-account per provider;
packaging as a signed installer / background service (v1 is `npx`/`pnpm` runnable);
remote (non-local) companions.
