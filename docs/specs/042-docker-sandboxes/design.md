# 042 — Docker sandboxes (replace Daytona)

Status: draft for approval · 2026-11-03

## 1. Intent

BAIOS lets a person build an app by chatting with an agent, Lovable-style, using **their own Claude
subscription**. Spec 041 already does this compliantly: each person gets a private "agent home"
running the unmodified, pinned `claude` CLI, they sign in through Anthropic's own `claude auth login`
flow, and BAIOS never stores the token. The agent's tools run in a separate per-project sandbox.

All of that sits on Daytona. Self-hosted Daytona is a large stack (API, Docker-in-Docker runner, its
own Postgres/Redis/registry/object store) that does not fit next to BAIOS on a small VPS, and staging
cannot even use it today (`environment.ts:821-830` refuses an env-held `DAYTONA_API_KEY` on real
deployments while `infra/ansible/.../app.yml:91` sets one; `hosts.yml:17` references a missing
`daytona.yml`).

This spec replaces Daytona with plain Docker on the same host, keeping every behaviour BAIOS relies
on, so that one 8 GB VPS can serve ~10 people building at once and more hosts can be added later.

## 2. Goals, non-goals, anti-goals

Goals
- G1. Every sandbox operation BAIOS uses today works on Docker: create/start/stop/remove, labels,
  exec, files (list/info/download/upload/find/search), long-lived sessions, template images,
  per-port preview with an upstream token, egress allow-list.
- G2. A person signs in with their own Claude subscription inside their own agent home and builds an
  app end-to-end (chat → edits → live preview), exactly as spec 041 describes.
- G3. Runs on one 8 GB VPS with Docker Compose for ~10 concurrent people; degrades by queueing, not
  by OOM-killing the platform.
- G4. Untrusted code (AI-written app code, npm/pip packages) cannot reach another tenant, the host,
  the platform's services, or the cloud metadata endpoint.
- G5. Clear path to N hosts without re-architecture.

Non-goals
- No Kubernetes, Nomad, or Firecracker/Kata in this spec (§12 says when to revisit).
- No change to the agent runtime, run streaming, leases, checkpoints, preview gateway logic, or the
  web app beyond what the swap needs.
- No new product features (terminals, PTY UI, per-org billing quotas).

Anti-goals (failure even if it "works")
- BAIOS collecting, storing, relaying or reading anyone's Claude credentials or `setup-token`
  output; modifying the `claude` binary; using the Agent SDK with subscription login.
- The API process (or anything reachable from a sandbox) holding the Docker socket.
- A sandbox able to reach another sandbox, Postgres/Redis/OpenBao, or `169.254.169.254`.
- A noisy tenant taking the platform down (memory, disk, PIDs).

## 3. Compliance basis (verified 2026-11-03)

Source: https://code.claude.com/docs/en/legal-and-compliance.md

- "preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or
  other agent infrastructure) requires agreeing to our Commercial Terms of Service" — the binary
  "must not be modified" and no built-in auth method may be removed or restricted.
- "Each end user must authenticate with their own Anthropic API key, Claude subscription plan
  credentials, or 3P inference provider credential."
- "developers may not collect, store, or intermediate Claude.ai credentials or session tokens —
  sign-in to a Claude account must complete through Anthropic's own flow." … "Nor does it prevent an
  end user from signing in to the unmodified Claude Code binary with their own Claude subscription,
  including where a platform hosts Claude Code."
- Agent SDK docs: no claude.ai login for third-party products "unless previously approved".

Consequences for this design
- The agent home runs the published `claude` binary, pinned, `DISABLE_AUTOUPDATER=1` (unchanged from
  041). Credentials live only in that home's own filesystem (`CLAUDE_CONFIG_DIR`). No BAIOS code,
  sandboxd included, reads `.credentials.json` or the keychain. (T3 Code's
  `claudeResetCredits.ts`, which reads the OAuth token and calls Anthropic's endpoints as
  `claude-cli`, is explicitly **not** a pattern to reuse.)
- One home per person, never shared (Consumer Terms §2).
- Open item, not blocking the build: during `claude auth login` the one-time code the person pastes
  passes through the API to the CLI's stdin (041 keeps it in memory only). Get written confirmation
  from Anthropic (contact-sales link on the legal page) before public launch.
- Out of scope but flagged: the BYOS path (`apps/api/src/modules/agent/byos/*`,
  `anthropic.adapter.ts:51-62`) runs its own OAuth, stores the access token, and calls the Messages
  API with it. Unless Anthropic issued that OAuth client, it conflicts with the text above. Decide
  separately; this spec does not touch it.

## 4. The core decision: a Daytona-compatible `sandboxd` over Docker

The API talks to Daytona through one hand-written REST client (`daytona.adapter.ts`, 619 lines,
zod-validated in `daytona.schemas.ts`), referenced by 14 non-spec files and faked at the HTTP level
by `test/support/fake-daytona.ts` for ~30 specs.

**Decision:** build `apps/sandboxd`, a small Node service that implements *the subset of the Daytona
v0.190 REST + toolbox API that `daytona.adapter.ts` calls*, backed by the Docker Engine API. The API
keeps its adapter, its port, its tests and its fake; the URL it points at changes, plus the small
API edits listed in §14a.

Why
- Smallest diff in the API: no call-site rewrites, no test rewrites beyond config (image names).
- Parity is provable: the existing `*-real` suites (`sandbox-real`, `sandbox-lifecycle-real`,
  `checkpoints-real`, `agent-real`, gateway `preview-real`) already exercise a real Daytona by URL;
  pointed at sandboxd they become the acceptance suite.
- The wire contract is already written down (`daytona.schemas.ts` + `fake-daytona.ts`).
- Daytona stays usable by config until parity is proven, then its infra (`infra/daytona/`) is
  deleted.

Licensing: Daytona is AGPL-3.0. sandboxd re-implements an HTTP interface from our own client and
fake; **no Daytona source is copied or read for implementation.** The Daytona-derived base image
`daytonaio/sandbox:0.5.0-slim` is replaced by our own base image (§7).

Alternatives considered and dropped
- Rewrite `SANDBOX_PORT`/adapter around a new vendor-neutral provider interface: cleaner names, but
  touches ~9 injection sites and ~30 specs for no behavioural gain. Renaming (`daytona_id` → `sandbox_id`
  etc.) is a later cosmetic follow-up.
- Keep self-hosted Daytona: too heavy for 8 GB, and currently broken on staging.
- Hosted sandboxes (E2B, Daytona Cloud, Cloudflare Sandbox, Vercel Sandbox): per-second billing and
  egress to a third party; fine later, contradicts the self-hosted VPS goal now.
- Kubernetes (k3s): real but adds ~0.5–1 GB of control plane and operational surface on an 8 GB box.

## 5. Architecture

```
                    Internet
                       │
                    Caddy (TLS)
             ┌─────────┴──────────┐
         api / worker          gateway (preview proxy, holds no secrets)
     (unchanged code;             │  x-daytona-preview-token
      DAYTONA_API_URL ──┐         │
      → sandboxd)       │         │
                        ▼         ▼
              ┌──────────────────────────────┐   host network, private listener
              │ sandboxd  (one per host)     │   - control API  (bearer key)
              │  - Docker Engine API (sock)  │   - preview proxy (signed token)
              │  - node:sqlite metadata      │   - egress proxy  (allow-list)
              │  - admission control         │
              └───────┬──────────────────────┘
                      │ docker.sock (only sandboxd has it)
        ┌─────────────┴─────────────────────────────────────┐
        │  sbx-proj (open, filtered)  sbx-agent (proxy only) │
        │   project sandbox (runsc)   agent home (runc,      │
        │   dev server, npm, git      hardened; claude CLI + │
        │                             companion only)        │
        └────────────────────────────────────────────────────┘
```

- Platform services (Postgres, Redis, OpenBao) are on the compose network, which sandboxes are never
  attached to.
- The companion inside an agent home reaches the API's `/local-agent/*` endpoints **through the
  egress proxy**, whose allow-list includes that host. Project sandboxes reach
  `SANDBOX_CALLBACK_URL` over their filtered public route via Caddy (§9).

## 6. sandboxd wire surface → Docker mapping

Ids: sandboxd issues `<nodeId>-<uuid>` so a future router can find the host from the id (§12).
Metadata Docker can't mutate (labels, snapshot name, network policy, auto-archive) lives in a local
`node:sqlite` DB (built into Node 24, no dependency) on a host volume; Docker is the source of truth
for runtime state.

| Daytona call used by the adapter | sandboxd implementation |
|---|---|
| `POST /sandbox` (snapshot, labels, autoArchiveInterval) | `docker create` from the image tagged by snapshot name, class-specific runtime/limits (§7–8); start now if capacity allows, else return state `starting` and start it from a FIFO queue when capacity frees (§12); DTO incl. `toolboxProxyUrl` (sandboxd's own toolbox base) and `runnerId` (= nodeId) |
| `GET /sandbox/{id}` | `docker inspect` → map to Daytona states (`started/stopped/starting/stopping/error/archived`) |
| `POST …/start`, `POST …/stop` | `docker start` / `docker stop -t 10` (disk persists) |
| `DELETE /sandbox/{id}` | `docker rm -f`, drop metadata |
| `PUT …/labels`, list by labels | sqlite |
| `POST …/snapshot {name}` | `docker commit` → tag `forge-snap/<name>` (see §7 for why commit works under gVisor) |
| `GET/DELETE /snapshots/{name}` | `docker image inspect` / `docker rmi` |
| `GET …/ports/{port}/signed-preview-url` | mint HMAC token (sandbox, port, exp) → return sandboxd preview URL + token (§10) |
| `POST …/network-settings {allowList, blockAll}` | store policy; egress proxy enforces it per source IP (§9) |
| toolbox `process/execute` (cmd, cwd, timeout) | `docker exec` as the sandbox user, merged output, hard timeout kills the exec'd process group |
| toolbox `process/session/{id}/exec`, `DELETE session` | detached `docker exec` tracked by session id; stop = kill its process group |
| toolbox files: list / info / download / upload / find / search, workDir, realpath(s) | performed **inside** the container via `docker exec` (stat/cat/`tee` from stdin/find/rg/realpath). The container is the jail; sandboxd never touches tenant files from the host side (avoids host-side symlink escapes) |

Response shapes must satisfy `daytona.schemas.ts` exactly; anything the adapter doesn't read is
omitted. Unknown endpoints return 404.

## 7. Container classes and images

| Class | Who creates it | Runtime | Limits (start values) | Contents |
|---|---|---|---|---|
| Project sandbox | `sandbox-claim`, `pool-refill` | gVisor `runsc` | 1 vCPU (burst 2), 1.5 GiB mem, swap 0.5 GiB, 512 PIDs, 5 GiB disk | template image; dev server via `dev-supervisor.mjs` |
| Agent home | `agent-home.service` | `runc`, hardened (§8) | 0.5 vCPU, 768 MiB, 128 PIDs, 2 GiB disk | `claude` CLI pinned + companion bundle; no built-in tools (041) |
| Build / template | `build-sandbox`, `template-publisher` | `runsc` | 2 vCPU, 2 GiB, 1024 PIDs, 10 GiB | template base |

- The class comes from the labels the API already sends (`baios=agent-home`, template/build
  labels); sandboxd maps label → class in one table; unknown labels → project class (the most
  restricted runtime).
- Agent homes run only trusted binaries: the CLI's tools are limited to `Agent`, `WebSearch`
  (executed server-side by Anthropic), `Task*`, and `mcp__baios__*`, which execute in the project
  sandbox; no Bash/Edit/Read (`apps/companion/src/providers/claude/index.ts:107-119`). So they use
  `runc` and skip gVisor's per-sandbox memory overhead. Project and build sandboxes run arbitrary
  code and get gVisor.
- `runsc` is registered with `--overlay2=none` so container writes land in Docker's normal overlay
  (makes `docker commit` and disk quotas work; workspace I/O already goes through the same path).
  The spike in §14 confirms this before anything else is built.
- Base image `forge/sandbox-base` (Debian slim, Node 24, git, ripgrep, python3 + venv, uid 1000, no
  sudo). User and home stay `daytona` / `/home/daytona` for now because `RUNNER_DIR`,
  `CLAUDE_CONFIG_DIR` and the workspace root are hard-coded around it; renaming is the later
  cosmetic follow-up. An `agent-home` image layer adds what `agent-home/files/install.sh` does with
  `sudo` today (directories, the pinned `claude` binary).
- Every template's `install` only uses `sudo apt-get install git` before `npm ci`/`pip`; git is in
  the base image, so the `sudo apt-get …` prefix is deleted from the four `template.json` files.
  That changes their digests, which is fine: the base image changes anyway, so every template is
  republished once through the existing `template-publisher` flow (create → exec install →
  snapshot = `docker commit`). Build sandboxes keep the full hardening of §8.

## 8. Isolation and hardening

Every sandbox container:
- non-root uid 1000; `--cap-drop ALL`; `--security-opt no-new-privileges`; Docker default seccomp
  (runc) / gVisor's own syscall filtering (runsc); no `--privileged`, no host mounts, no Docker
  socket, no device access.
- dockerd with `userns-remap` so uid 0 in any container is unprivileged on the host.
- `--memory` = `--memory-swap` cap, `--pids-limit`, `--cpus`, `--ulimit nofile`.
- Disk: `--storage-opt size=` on overlay2 over XFS with `pquota` (deploy doc formats the Docker data
  disk that way). If the host can't do XFS quotas, sandboxd runs a periodic `docker ps --size`
  check and stops sandboxes over quota (fallback, documented as weaker).
- Labels never carry secrets. Secrets keep arriving as files via upload with `chmod 600`, exactly as
  today (callback token, project env, device token).

sandboxd itself:
- The only process with the Docker socket. Runs as a compose service with `network_mode: host`,
  listening on a private address only; never exposed by Caddy.
- Authenticated by a bearer key. On real deployments the key comes from a compose secret file, not
  the environment (respects ADR 027's "no env-held key outside local"): the adapter gains
  `DAYTONA_API_KEY_FILE` support; env-held key stays local-only.
- Validates every input (ids, paths, ports, image names against an allow-list of `forge-snap/*` and
  `forge/*`, extendable by `SANDBOXD_IMAGE_ALLOW` for test images); never accepts arbitrary image
  refs, mounts, or Docker options from callers.

Residual risk stated plainly: agent-home credentials are readable by anyone with root on the host
(true of any host, Daytona included). Mitigation: encrypted disk, no shell access for non-operators.

## 9. Network and egress

- Two bridges, both with inter-container traffic disabled, neither attached to the platform's
  compose network:
  - `sbx-agent` (agent homes): no outbound route at all except the sandboxd egress proxy below.
  - `sbx-proj` (project + build sandboxes): **open public internet** (owner decision, §17 Q1), NAT'd,
    with deny rules for private/loopback/link-local/CGNAT ranges, `169.254.169.254`, the host's
    own addresses (except Caddy 443 for `SANDBOX_CALLBACK_URL` and the API), other sandboxes, and
    SMTP ports 25/465/587; plus a per-sandbox new-connection rate limit (`hashlimit`).
- sandboxd installs these rules at start, idempotently, in `DOCKER-USER` (forwarded traffic) and
  `INPUT` (traffic to the host itself, which `DOCKER-USER` doesn't see), and `/healthz` fails if
  they are missing. sandboxd → sandbox (preview) is allowed on both bridges.
- Egress proxy: an HTTP CONNECT/HTTP forward proxy inside sandboxd (Node `http`, ~150 lines),
  injected as `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` plus `NODE_USE_ENV_PROXY=1` (Node's global
  `fetch` ignores `HTTP_PROXY` without it — affects `dev-supervisor.mjs` callbacks and the
  companion). Policy is looked up by source IP → sandbox → class/policy:
  - agent home: Anthropic endpoints Claude Code needs (API, claude.ai login, console; exact list
    measured in the spike), the BAIOS API host. When `network-settings` sets an allow-list (041's
    `AGENT_HOME_EGRESS_ALLOW_CIDRS`), it **replaces** the default — "only these", as today
    (`agent-home.service.ts:790`); fail-closed `applyEgress` is unchanged.
  - project / build: not proxied — they use the open, filtered route on `sbx-proj` above.
  - The proxy resolves DNS itself and refuses any target that resolves to a private, loopback,
    link-local or metadata address (DNS-rebinding safe), except the configured BAIOS API/callback
    host.

## 10. Preview

- The gateway routes by `Host`, overwrites `host` with the upstream's host, and forwards `req.url`
  unchanged (`apps/gateway/src/proxy.ts:119,216`; `upgrade.ts:61`) — so the upstream URL cannot
  carry a path, and minting per-sandbox hostnames would need wildcard internal DNS.
- Therefore **the token is the route**: `signed-preview-url` returns the same plain upstream for
  every sandbox (`http://<sandboxd private addr>:<preview port>`) plus a token = HMAC-SHA256 over
  (sandboxId, port, expiry), key held by sandboxd only. The gateway already sends it as
  `x-daytona-preview-token` on every request and upgrade; sandboxd verifies it and routes to
  `<container IP>:<port>` on its bridge. **No gateway change.** The cookie stripping of
  `daytona-sandbox-auth-*` becomes a harmless no-op.
- Proxies HTTP **and WebSocket upgrades** (Vite HMR). The port comes from the signed token, which
  the API only mints for the template's declared port, so sandboxd needs no template manifest.
- Works in both topologies: same host (loopback/private address) or the staging mesh, where the
  gateway host reaches sandboxd over WireGuard.
- A stopped sandbox returns 503 with a body the gateway already handles; the API's existing resume
  path wakes it.

## 11. Lifecycle, persistence, recovery

- The API keeps owning lifecycle (sweeps, pool, reconciler, agent-home scheduler) — sandboxd is
  mechanism, not policy. Existing timings stand: active→idle 20 min, idle→hibernated (stop) 60 min,
  agent home idle stop 30 min. Note: the API's 14-day "archive" for project sandboxes only logs
  "archive refused" today (`sandbox-sweep.ts:90-105`) — nothing is removed.
- Workspace lives in the container's writable layer; `stop` keeps it, `remove` deletes it.
- Stopped-sandbox retention (owner decision, §17 Q2): stopped project sandboxes stay on the VPS disk
  until the API removes them; no archive tier in v1. sandboxd's `/capacity` reports disk use and the
  deploy doc wires a 70% disk alert. Moving long-stopped sandboxes to the object store is the
  follow-up when that alert starts firing. `autoArchiveInterval` is accepted and ignored.
- sandboxd restart: containers keep running (dockerd owns them); sandboxd rebuilds its view from
  `docker ps` + sqlite. Host reboot: containers come back `stopped` (restart policy `no`); the API's
  reconciler and on-demand resume handle it. Orphans (container without metadata or vice versa) are
  reported through `listByLabels` exactly as Daytona would, so `sandbox-reconciler` cleans them.
- `docker system prune` must never be run on the host (would delete stopped sandboxes); the ops doc
  says so and sandboxd labels everything it owns.

## 12. Capacity on 8 GB, admission control, scaling

Budget (steady state, start values; verified under load in the plan):

| Item | Memory |
|---|---|
| OS + dockerd + containerd | ~0.4 GiB |
| api + worker (Node) | ~0.7 GiB |
| Postgres | ~0.5 GiB |
| 4× Redis (existing maxmemory caps) | ~0.3 GiB |
| OpenBao, Caddy, gateway, sandboxd | ~0.3 GiB |
| **Platform subtotal** | **~2.2 GiB** |
| 10 project sandboxes, dev server running (~400 MiB + gVisor ~40 MiB) | ~4.4 GiB |
| 10 agent homes (companion idle ~80 MiB; ~350 MiB while a turn runs, assume half busy) | ~2.1 GiB |
| **Total** | **~8.7 GiB** |

That is over 8 GiB, so:
- 4 GiB swap (swapfile, `vm.swappiness=10`) as a shock absorber, and limits are ceilings, not
  reservations.
- **Admission control in sandboxd, by queueing**: when host `MemAvailable` < 1 GiB or running
  sandboxes ≥ `SANDBOXD_MAX_RUNNING` (default 22), `create`/`start` are accepted and the sandbox
  reports `starting` until a FIFO slot frees. A refusal would not work: the adapter does not retry
  (`daytona.adapter.ts:533-548`) and agent-home turns a retryable `create` error into an adopt-poll
  that ends in failure (`agent-home.service.ts:749-758`). The API's existing "poll until `started`
  or deadline" loops already handle `starting`; the plan verifies `sandbox-claim` and
  `sandbox-ops.consumer` do too, and adds a "waiting for capacity" run event if the deadline path
  shows a generic error to the person.
- Platform containers get compose `mem_limit`s and higher OOM priority protection
  (`oom_score_adj` negative for Postgres/api; sandboxes positive) so the kernel kills a sandbox
  before the platform.
- Practical guidance in the deploy doc: 8 GB comfortably serves ~6–8 actively building people and
  ~10 with swap; move to 16 GB or a second sandbox host beyond that.

CPU: 8 GB VPSes usually have 2–4 vCPUs; `--cpus` caps plus CFS shares keep the API responsive. npm
installs under gVisor are slower (expect 1.3–2× runc); templates preinstall dependencies in the
image so first boot avoids most installs, and the existing warm pool (`pool-refill`) hides create
latency.

Scaling path (not built now, design doesn't block it)
1. Move Postgres/Redis/OpenBao to their own box when the API host gets tight.
2. Add sandbox hosts: each runs sandboxd only. A thin router mode of sandboxd (same API) places new
   sandboxes on the host with the most headroom and forwards by the `<nodeId>-` id prefix; the API
   still sees one `DAYTONA_API_URL`. `runnerId` → the existing `node` column already records
   placement.
3. When sandboxes from many tenants need a hard VM boundary or density >~100/host, revisit
   Firecracker/Kata or a managed sandbox provider behind the same wire.

## 13. Observability and errors

- sandboxd logs JSON via pino (same as the API), with sandboxId, class, op, duration, and the
  `x-forge-operation-id` / `x-forge-lease-epoch` headers the adapter already forwards
  (`daytona.adapter.ts:558-561`).
- `GET /healthz` (Docker reachable, sqlite writable, iptables rules present) and `GET /capacity`
  (running count, MemAvailable, disk free) for the deploy check and the future router.
- Errors map to the status codes the adapter's `DaytonaError` classification already understands
  (retryable 5xx/503/timeout vs. permanent 4xx); sandboxd must not invent new semantics.
- Docker events stream (`die`, `oom`) logged with class and sandboxId so OOM-kills are visible.

## 14. Rollout and testing

Order matters; each step is independently shippable.
1. **Spike (throwaway, first):** on a fresh Ubuntu 24.04 VPS — install gVisor with
   `--overlay2=none`, userns-remap, XFS pquota. Confirm: `docker commit` captures writes under runsc;
   `--storage-opt size` enforced; Vite dev server + HMR through a WebSocket proxy; npm install time
   vs runc; sandbox cannot reach another sandbox, the compose network, or metadata; per-sandbox
   memory overhead. Any failure here changes §7–9 before code is written.
2. `forge/sandbox-base` image; templates and the agent-home template switch `base` to it.
3. `apps/sandboxd`: control API + toolbox + sqlite, unit tests against a fake Docker Engine, and a
   **contract test that runs `fake-daytona.ts`'s expectations and `daytona.schemas.ts` against
   sandboxd's responses**.
4. Preview proxy + egress proxy + iptables, with tests for: token expiry/forgery, undeclared port,
   WebSocket upgrade, private-IP/DNS-rebinding refusal, per-class allow-lists.
5. Run the existing `*-real` suites with `DAYTONA_API_URL` pointing at sandboxd in CI (a job on a
   runner with Docker; runc in CI if gVisor isn't available there, runsc on the staging VPS).
6. Compose + Ansible: `sandboxd` service, daemon.json (runtimes, userns-remap, log rotation),
   swap, XFS data disk, secret file for the key, remove the Daytona override; deploy doc in
   `infra/sandboxd/README.md`.
7. Staging soak with ~10 synthetic people (scripted runs) watching memory, OOMs, latency.
8. Delete `infra/daytona/` and the Daytona compose override once staging has run on sandboxd.

## 14a. API / repo edits this spec does make

- `daytona.adapter.ts`: read the key from `DAYTONA_API_KEY_FILE` when set (§8).
- Four `template.json` files: drop the `sudo apt-get …` prefix (§7); `agent-home` install moves into
  its image.
- `*-real` suites: config-level edits only (image name `daytonaio/sandbox:0.5.0-slim` → `forge/…`,
  e.g. `preview-real.e2e-spec.ts:114`), never behavioural.
- Possibly one "waiting for capacity" run event (§12), only if the plan finds the existing deadline
  error is unclear to the person.

## Deployment targets

Both, from one design: (a) the **single 8 GB VPS** — everything in one Compose project (the new
production starting point); (b) the existing **multi-host staging mesh**
(`infra/ansible/inventories/staging/hosts.yml`) — sandboxd replaces the `daytona` host, the gateway
host reaches sandboxd over WireGuard, so no TLS between them is needed. The §12 budget applies to
(a).

## 15. Left to the builder

- Docker Engine API client: raw `node:http` over the socket vs. `dockerode` — pick whichever keeps
  exec stream demux simplest; don't add more than one dependency.
- Exact egress allow-list hostnames for Claude Code (measure with the proxy in log-only mode during
  the spike, then lock).
- Exact limit numbers within the budget in §12, after the spike measures real usage.
- Whether the sandboxd router mode (§12 step 2) shares a binary with the node mode.

## 16. Calls made in this document (review these)

- Compatibility server instead of a new provider port (§4).
- gVisor for project/build sandboxes, hardened runc for agent homes (§7).
- Workspace in the container layer, no Docker volumes (§11).
- Agent-home egress via an allow-list proxy rather than per-container iptables CIDRs (§9).
- The preview token is the route, so the gateway needs no change (§10).
- Full host → queue, not refuse (§12).
- Templates drop `sudo`; no looser profile for build sandboxes (§7).
- One design serves both the single VPS and the staging mesh.
- sandboxd key from a secret file on real deployments (§8).
- Keep `/home/daytona` paths and Daytona names in the API for now; rename later.
- Spec lives under `docs/specs/042-…` (repo convention) rather than `docs/superpowers/specs/`.

## 17. Owner decisions (2026-11-03)

- **Q1. Project-sandbox internet access → open, with blocks.** Apps people build can call outside
  APIs from preview; private/platform/metadata/other-sandbox addresses and SMTP are blocked, new
  connections are rate-limited. Agent homes stay on a strict allow-list.
- **Q2. Stopped projects → keep on disk for v1**, with a 70% disk alert; archive to the object
  store later if needed.
- Target: one 8 GB VPS, ~10 concurrent people, each using their own Claude subscription through
  041's agent home.
