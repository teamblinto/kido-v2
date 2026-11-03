# Docker Sandboxes (sandboxd) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Daytona with `apps/sandboxd`, a Daytona-wire-compatible service over Docker, so BAIOS runs on one 8 GB VPS.

**Architecture:** `sandboxd` implements exactly the Daytona v0.190 REST + toolbox subset that `apps/api/src/modules/sandbox/daytona.adapter.ts` calls, backed by the Docker Engine API (dockerode), with a `node:sqlite` metadata store, a token-routed preview proxy, an allow-list egress proxy for agent homes, and host firewall rules. The API changes only its URL, plus a key-file option.

**Tech Stack:** Node 24 (TypeScript run directly, like `apps/gateway`), dockerode, zod, node:sqlite, Vitest, Docker Engine ≥ 27, gVisor `runsc`, iptables.

**Spec:** `docs/specs/042-docker-sandboxes/design.md` (read it first; section refs below are to it).

## Global Constraints

- Wire contract = what `daytona.adapter.ts` sends and what `daytona.schemas.ts` parses. Reference behaviour = `apps/api/test/support/fake-daytona.ts`. When in doubt, match the fake. There is no standalone contract test against `daytona.schemas.ts` (design §14 step 3): the CI `sandboxd` job runs the API's `*-real` suites, whose adapter parses every sandboxd response with those schemas, against a real sandboxd.
- No Daytona source code is read or copied (AGPL). Only our own adapter/fake/schemas are the reference.
- No BAIOS code reads `.credentials.json`, keychain, or any Claude token. Never add `--dangerously-*`/bypass flags. Do not modify the `claude` binary.
- Only sandboxd holds `/var/run/docker.sock`. Callers can never pass image refs outside the allow-list (`forge/*`, `forge-snap/*`, plus `SANDBOXD_IMAGE_ALLOW`), mounts, or Docker options.
- Containers: uid 1000, `CapDrop: ["ALL"]`, `SecurityOpt: ["no-new-privileges"]`, no privileged, no host mounts except the read-only `/etc/resolv.conf` bind gVisor sandboxes get (`writeResolvConf`, design §8), `Memory` = `MemorySwap` cap, `PidsLimit`, `NanoCpus`, `Ulimits nofile 4096`.
- Class limits (§7): project 1 vCPU/1.5 GiB/512 PIDs/5 GiB disk, runtime `SANDBOXD_RUNTIME_PROJECT` (default `runsc`); agent home 0.5 vCPU/768 MiB/128 PIDs/2 GiB, runtime `runc`; build 2 vCPU/2 GiB/1024 PIDs/10 GiB, runtime `SANDBOXD_RUNTIME_PROJECT`. Swap allowance project 0.5 GiB.
- Sandbox ids: `<SANDBOXD_NODE_ID>-<uuid v4>`. `runnerId` = node id.
- Container home/workdir stays `/home/daytona`, user `daytona` (uid 1000).
- Admission: queue (state `starting`) when `MemAvailable` < 1 GiB or running ≥ `SANDBOXD_MAX_RUNNING` (default 22). Never refuse for capacity.
- Egress: agent homes on internal bridge `sbx-agent` via proxy only; project/build on `sbx-proj`, open internet minus private/loopback/link-local/CGNAT/metadata/host/other-sandbox/SMTP 25,465,587, plus hashlimit on new connections. `network-settings` allow-list **replaces** the agent-home default.
- Preview: token = HMAC-SHA256(sandboxId, port, exp) is the route; one plain upstream URL; header `x-daytona-preview-token`; HTTP and WebSocket upgrade. No gateway change.
- Key on real deployments from a file (`DAYTONA_API_KEY_FILE` for API, `SANDBOXD_API_KEY_FILE` for sandboxd); env-held key stays local-only (ADR 027 check in `environment.ts:821-830` stays).
- Logs: JSON lines to stdout (same shape the gateway/API use), include sandboxId, class, op, durationMs, `x-forge-operation-id`, `x-forge-lease-epoch`. Never log tokens, file contents, command env.
- New code passes `pnpm lint`, `pnpm typecheck`, `pnpm test` for its package; keep repo conventions (ESLint flat config, Prettier, dependency-cruiser).

## Review Focus

- Path/command injection through toolbox args (`path`, `pattern`, `cwd`, session ids): every exec uses argv arrays, never string interpolation into `sh -c`, except `process/execute`'s and session `command`, which are caller-supplied shell by contract. → tests in Task 5.
- A toolbox call for a stopped/queued/removed sandbox must return the status the adapter maps correctly (404 → re-lookup once then `sandbox-not-found`; stopped → adapter `lookup` refuses on `state !== 'started'`). → tests in Task 4/5.
- Exec timeout must kill the whole process group inside the container and answer 408 with no body requirement; long output is not buffered unbounded (cap 1 MiB, adapter truncates further). → Task 5.
- sandboxd restart mid-queue or mid-session: queued sandboxes resume being started; sessions are reported gone (DELETE → 404, which the adapter swallows). → Task 4/5.
- Preview token replay to a different sandbox/port or after expiry is refused; WebSocket upgrade with a bad token is closed before proxying. → Task 6.

---

## File Structure

```
apps/sandboxd/
  package.json, tsconfig.json, eslint.config.mjs, vitest.config.mts, Dockerfile   (copy gateway's shape)
  src/main.ts            boot: config, store, docker, servers (control+toolbox, preview, egress), firewall check
  src/config.ts          zod env schema → Config
  src/log.ts             JSON-line logger
  src/http.ts            tiny router + JSON/error helpers + bearer auth
  src/store.ts           node:sqlite metadata (sandboxes, sessions)
  src/docker.ts          DockerPort interface + dockerode implementation
  src/classes.ts         label → class → HostConfig (limits, runtime, network)
  src/sandboxes.ts       control-plane handlers (create/describe/start/stop/remove/labels/list/snapshot*)
  src/admission.ts       capacity check + FIFO start queue
  src/toolbox.ts         toolbox handlers (work-dir, files*, process/execute, sessions)
  src/exec.ts            exec helper: argv, stdin, timeout, process-group kill, output cap
  src/preview.ts         token mint/verify + HTTP/WS proxy
  src/egress.ts          forward/CONNECT proxy with per-source-IP policy
  src/network.ts         ensure bridges; run firewall script; check rules
  src/events.ts          docker events → log (die/oom)
  test/*.spec.ts         unit (FakeDocker)
  test/*.int-spec.ts     integration against real Docker (skip with banner if no socket)
infra/sandboxd/
  images/base/Dockerfile, images/agent-home/Dockerfile
  firewall.sh            idempotent iptables rules (DOCKER-USER + INPUT)
  host-setup.sh          gVisor, daemon.json, userns-remap, swap, XFS notes
  daemon.json            dockerd config (runtimes, userns-remap, log rotation)
  spike.sh               Task 0 checks
  README.md              ops/deploy doc
```

---

### Task 0: Spike script (throwaway checks, run before building on the VPS)

**Files:** Create `infra/sandboxd/spike.sh`, `infra/sandboxd/README.md` (section "Spike").

- [ ] **Step 1:** Write `spike.sh` (bash, `set -euo pipefail`, prints `PASS/FAIL <check>` per line, exit 1 if any FAIL). Checks, each skippable with a printed `SKIP` when its prerequisite (runsc, xfs pquota, Linux) is absent:
  1. `runsc` registered with `--overlay2=none`; `docker run --runtime=runsc` writes a file; `docker commit` image contains it.
  2. `--storage-opt size=1G`: writing 1.5 GiB fails with ENOSPC.
  3. `node:24-slim` container under runsc runs `npx vite` sample on 5173; host curl to container IP gets 200; a WS handshake (`curl -i -N -H 'Connection: Upgrade' -H 'Upgrade: websocket' …`) gets 101.
  4. `npm ci` time for `apps/api/templates/vite-react` under runc vs runsc (print seconds, no pass/fail).
  5. Two containers on a bridge created with `com.docker.network.bridge.enable_icc=false`: A cannot reach B.
  6. Container cannot reach `169.254.169.254` after `firewall.sh` (only if Task 8 landed; else SKIP).
  7. Idle memory of a runsc vs runc container (`docker stats --no-stream`).
- [ ] **Step 2:** Run it locally (Docker Desktop, runc only). Expected: checks 1, 2, 3 (runsc), 6 print SKIP; 5 PASS; script exits 0.
- [ ] **Step 3:** README "Spike" section: how to run on the VPS and what each failure changes in the spec (1 → template snapshots; 2 → disk quota fallback; 3 → preview; 5/6 → network).
- [ ] **Step 4:** Commit `chore(sandboxd): spike checks for docker/gvisor host`.

### Task 1: Base images and template edits

**Files:** Create `infra/sandboxd/images/base/Dockerfile`, `infra/sandboxd/images/agent-home/Dockerfile` (optional—only if `install.sh` can't run in base). Modify `apps/api/templates/{vite-react,nextjs,node-api,python}/template.json` (`base`, `install`), `apps/api/templates/agent-home/template.json` (`base`), `apps/api/templates/agent-home/files/install.sh`. Test: `apps/api` template manifest specs (find with `grep -rl "template.json" apps/api/src apps/api/test`).

- [ ] **Step 1:** Base Dockerfile: `node:24-bookworm-slim` pinned by digest (repo FR-006 style), `apt-get install git ripgrep python3 python3-venv curl ca-certificates findutils coreutils procps`, user `daytona` uid/gid 1000 home `/home/daytona`, `mkdir -p /opt/baios && chown 1000:1000 /opt/baios`, no sudo, `WORKDIR /home/daytona`, `USER 1000`, `CMD ["sleep","infinity"]`. Tag `forge/sandbox-base:1`.
- [ ] **Step 2:** `docker build -t forge/sandbox-base:1 infra/sandboxd/images/base` succeeds; `docker run --rm forge/sandbox-base:1 sh -c 'id -u; rg --version; git --version; realpath --version; find --version; python3 -m venv /tmp/v'` exits 0 and prints `1000`.
- [ ] **Step 3:** Templates: set `"base": "forge/sandbox-base:1"`; delete the `sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends git && ` prefix from the four project templates. `install.sh`: replace `sudo mkdir -p /opt/baios` + `sudo chown …` with `mkdir -p /opt/baios`; make the Node<24 branch `echo "base image must provide Node >= 24" >&2; exit 1` (no sudo left in the file).
- [ ] **Step 4:** Run the API template/manifest specs and fix fixtures that pin the old base/digests (`pnpm --filter @repo/api test -- template`). Expected: PASS. `grep -rn sudo apps/api/templates` → no output.
- [ ] **Step 5:** Commit `feat(templates): forge/sandbox-base image, drop sudo from installs`.

### Task 2: sandboxd scaffold — config, logger, HTTP, auth, store

**Files:** Create `apps/sandboxd/{package.json,tsconfig.json,eslint.config.mjs,vitest.config.mts}`, `src/{config,log,http,store,main}.ts`, `test/{config,http,store}.spec.ts`. Add `dockerode` + `@types/dockerode` to the pnpm catalog.

**Interfaces — Produces:**

- `loadConfig(env: NodeJS.ProcessEnv): Config` where `Config = { nodeId: string; apiKey: string; listen: {host:string; port:number}; previewListen: {host;port}; previewPublicUrl: string; previewSecret: Buffer; egressListen: {host;port}; dataDir: string; runtimeProject: string; maxRunning: number; minMemAvailableBytes: number; imageAllow: string[]; apiHost: string /* BAIOS API/callback host allowed through proxy & firewall */; egressAgentDefault: string[] }`. Env: `SANDBOXD_NODE_ID` (default `n1`), `SANDBOXD_API_KEY` | `SANDBOXD_API_KEY_FILE` (exactly one), `SANDBOXD_LISTEN` (`127.0.0.1:3986`), `SANDBOXD_PREVIEW_LISTEN` (`127.0.0.1:3987`), `SANDBOXD_PREVIEW_PUBLIC_URL` (default `http://<preview listen>`), `SANDBOXD_PREVIEW_SECRET_FILE` (generated into dataDir if absent), `SANDBOXD_EGRESS_LISTEN` (bridge gateway of `sbx-agent`, port 3988), `SANDBOXD_DATA_DIR` (`/var/lib/sandboxd`), `SANDBOXD_RUNTIME_PROJECT` (`runsc`), `SANDBOXD_MAX_RUNNING` (22), `SANDBOXD_MIN_MEM_AVAILABLE_MB` (1024), `SANDBOXD_IMAGE_ALLOW` (comma list), `SANDBOXD_API_HOST`, `SANDBOXD_EGRESS_AGENT_DEFAULT` (comma list of hostnames; default `api.anthropic.com,claude.ai,console.anthropic.com,statsig.anthropic.com` — refined after spike).
- `log(level: 'info'|'warn'|'error', msg: string, fields?: Record<string, unknown>): void`.
- `router()` with `route(method, pattern: string /* '/sandbox/:id/start' */, handler: (req, res, params, url) => Promise<void>)`, `sendJson(res, status, body)`, `HttpError(status, message)`; `requireBearer(req, key)` uses `crypto.timingSafeEqual`.
- `Store` (node:sqlite, file `<dataDir>/sandboxd.db`, WAL): `insert(row: SandboxRow)`, `get(id): SandboxRow|undefined`, `byLabels(match: Record<string,string>): SandboxRow[]` (all pairs must match), `setLabels(id, labels)`, `setState(id, desired: 'started'|'stopped'|'queued')`, `setNetwork(id, allow: string[]|null, blockAll: boolean)`, `remove(id)`, `all()`. `SandboxRow = { id; containerId: string|null; image: string; class: 'project'|'agent'|'build'; labels: Record<string,string>; desired: 'started'|'stopped'|'queued'; networkAllow: string[]|null; networkBlockAll: boolean; createdAt: string /* ISO */; queuedAt: string|null }`.

- [ ] **Step 1:** Tests: `config.spec.ts` — both key sources set → throws; file key read and trimmed; defaults as above. `http.spec.ts` — wrong/missing bearer → 401 JSON `{message}`; unknown route → 404; handler `HttpError(409)` → 409; thrown Error → 500 without leaking message. `store.spec.ts` (temp dir) — insert/get round-trip; `byLabels({a:'1'})` matches superset labels, not mismatches; survives reopen.
- [ ] **Step 2:** Run `pnpm --filter @repo/sandboxd test` → FAIL (modules missing).
- [ ] **Step 3:** Implement. `main.ts` boots config, store, and `GET /healthz` (unauthenticated, returns `{ok, docker, store, firewall}` — docker/firewall wired in later tasks; start with store only).
- [ ] **Step 4:** Tests PASS; `pnpm --filter @repo/sandboxd lint typecheck` PASS.
- [ ] **Step 5:** Commit `feat(sandboxd): scaffold config, http, auth, store`.

### Task 3: Docker port + container classes

**Files:** Create `src/docker.ts`, `src/classes.ts`, `test/fake-docker.ts`, `test/classes.spec.ts`, `test/docker.int-spec.ts`.

**Interfaces — Produces:**

- `interface DockerPort { create(spec: ContainerSpec): Promise<string /*containerId*/>; start(cid): Promise<void>; stop(cid, timeoutS: number): Promise<void>; remove(cid): Promise<void> /* force, 404 ok */; inspect(cid): Promise<{ status: 'created'|'running'|'paused'|'restarting'|'removing'|'exited'|'dead'; ip: string|null; startedAt: string } | null>; commit(cid, repoTag: string): Promise<void>; imageExists(ref): Promise<boolean>; removeImage(ref): Promise<'removed'|'missing'|'in-use'>; exec(cid, opts: ExecOpts): Promise<ExecOutcome>; execDetached(cid, opts: Omit<ExecOpts,'stdin'|'timeoutMs'>): Promise<void>; ensureNetwork(name, opts: {internal: boolean}): Promise<void>; events(onEvent: (e: {action: string; cid: string; labels: Record<string,string>}) => void): () => void; ping(): Promise<boolean> }`.
- `ExecOpts = { argv: string[]; cwd?: string; env?: Record<string,string>; stdin?: Buffer; timeoutMs: number; maxOutputBytes: number; user?: string /* default '1000:1000' */ }`; `ExecOutcome = { timedOut: false; exitCode: number; output: Buffer /* merged, capped */; truncated: boolean } | { timedOut: true }`.
- `ContainerSpec = { name: string; image: string; labels: Record<string,string>; env: string[]; hostConfig: object; network: 'sbx-agent'|'sbx-proj' }`.
- `classOf(labels): 'project'|'agent'|'build'` — `labels.baios === 'agent-home'` → agent; template-publish / build labels (read exact keys from `template-publisher.ts` and `build-sandbox.service.ts` create calls) → build; anything else → project.
- `containerSpec(cfg: Config, id: string, image: string, cls, labels, proxyEnv: string[]): ContainerSpec` applying Global Constraints limits; label `sandboxd.id=<id>`, `sandboxd.owner=1`; agent env adds `HTTP_PROXY/HTTPS_PROXY=http://<egress listen>`, `NO_PROXY=` empty, `NODE_USE_ENV_PROXY=1`.
- `FakeDocker implements DockerPort` (in-memory; scripted `exec` handler; records calls) for unit tests.

- [ ] **Step 1:** `classes.spec.ts`: agent labels → `Runtime 'runc'`, `Memory 805306368`, `PidsLimit 128`, `NanoCpus 5e8`, network `sbx-agent`, env contains `NODE_USE_ENV_PROXY=1`; project → runtime = `cfg.runtimeProject`, `Memory 1610612736`, `MemorySwap 2147483648`, `PidsLimit 512`, `StorageOpt {size:'5G'}`, network `sbx-proj`, no proxy env; all classes `CapDrop ['ALL']`, `SecurityOpt ['no-new-privileges']`, `Privileged false`, no `Binds`; unknown labels → project.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with dockerode (`new Docker({ socketPath: '/var/run/docker.sock' })`). Exec: `container.exec({Cmd: argv, AttachStdout, AttachStderr, AttachStdin: !!stdin, WorkingDir, Env, User})`, `exec.start({hijack: true, stdin: !!stdin})`, demux with `docker.modem.demuxStream` into one capped buffer; on timeout run a second exec `kill -KILL -<pgid>` — make argv run under `setsid` so pgid = pid; get pid via `exec.inspect().Pid` is host-namespace, so instead wrap: `['setsid','sh','-c','echo $$ > /tmp/.sbx-exec-<rand>; exec "$@"','sh',...argv]` and kill `-$(cat file)`. `StorageOpt` only when `SANDBOXD_STORAGE_QUOTA=1` (XFS hosts); else omitted and logged once.
- [ ] **Step 4:** `docker.int-spec.ts` (skip with `SANDBOXD-DOCKER-SKIP` banner if `ping()` false): create from `forge/sandbox-base:1` (runtime runc in CI), start, exec `id -u` → `1000`, exec with stdin `cat` round-trips 200 KiB binary, exec `sleep 30` with 500 ms timeout → `timedOut` and no `sleep` left (`ps` check), commit → `imageExists` true, remove → inspect null. Run unit + int → PASS.
- [ ] **Step 5:** Commit `feat(sandboxd): docker port and container classes`.

### Task 4: Control plane + admission queue

**Files:** Create `src/sandboxes.ts`, `src/admission.ts`, `src/events.ts`, `test/sandboxes.spec.ts`, `test/admission.spec.ts`, `test/sandboxes.int-spec.ts`.

**Interfaces — Consumes:** Task 2 `Store`, router; Task 3 `DockerPort`, `containerSpec`, `classOf`.
**Produces:** routes (all bearer-auth):

| Route                                                                                                   | Behaviour                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /sandbox` `{snapshot, labels, autoArchiveInterval, autoStopInterval}`                             | image = snapshot name resolved as: `forge-snap/<snapshot>:latest` if exists, else `snapshot` verbatim if allow-listed, else 400. Insert row, create container, `admission.request(id)`; 200 with dto |
| `GET /sandbox/:id`                                                                                      | dto; 404 if no row                                                                                                                                                                                   |
| `POST /sandbox/:id/start` / `stop`                                                                      | start → `admission.request`; stop → `docker.stop(10)`, desired `stopped`, drop from queue; 200 `{}`                                                                                                  |
| `DELETE /sandbox/:id?force=true`                                                                        | remove container + row; 404 if unknown                                                                                                                                                               |
| `PUT /sandbox/:id/labels` `{labels}`                                                                    | replace labels; 200 dto                                                                                                                                                                              |
| `GET /sandbox?labels=<json>&cursor=`                                                                    | `{items: dto[], nextCursor: null}` (one page)                                                                                                                                                        |
| `POST /sandbox/:id/snapshot` `{name}`                                                                   | `docker.commit(cid, 'forge-snap/<name>:latest')`; 200 `{}`                                                                                                                                           |
| `GET /snapshots/:name`                                                                                  | `{name, state: 'active', errorReason: null}` or 404                                                                                                                                                  |
| `DELETE /snapshots/:name`                                                                               | removeImage: removed/missing → 200/404, in-use → 409                                                                                                                                                 |
| `POST /sandbox/:id/network-settings` `{networkAllowList: string /* comma */, networkBlockAll: boolean}` | store; egress picks it up (Task 7); 200 `{}`                                                                                                                                                         |

- dto `{ id, state, labels, createdAt, runnerId: cfg.nodeId, toolboxProxyUrl: '<SANDBOXD public base>/toolbox', user: 'daytona' }`; `state` mapping: no container yet or desired `queued` → `starting`; running → `started`; created/exited with desired `started` → `starting`; exited/created with desired `stopped` → `stopped`; restarting → `starting`; removing → `destroying`; dead → `error`.
- `Admission { request(id): void; tick(): Promise<void>; size(): number }` — FIFO; `tick` every 2 s and on any `die`/stop event: while queue non-empty and `running < maxRunning` and `memAvailable() >= min` → start head. `memAvailable()` reads `MemAvailable` from `/proc/meminfo` (injectable for tests). On boot: rows with desired `started|queued` whose container isn't running → enqueue in `createdAt` order.
- `events.ts`: subscribe `docker.events`; log `die`/`oom` with `sandboxd.id` label and class; on `die` call `admission.tick()`.

- [ ] **Step 1:** `sandboxes.spec.ts` (FakeDocker + temp Store): create returns `starting` dto whose `id` matches `/^n1-[0-9a-f-]{36}$/` and passes this zod shape copied into the test: `{createdAt: string, id: string, labels: record, runnerId: string, state: string, toolboxProxyUrl: url}`; snapshot name not allow-listed and no `forge-snap/` image → 400; describe unknown → 404; `listByLabels` filters; delete then describe → 404; snapshot then `GET /snapshots/x` → `active`; `DELETE /snapshots/x` while FakeDocker says in-use → 409. `admission.spec.ts`: maxRunning 2, three requests → third stays `starting` until one dies, then starts; memAvailable below min → nothing starts, then starts when it rises; boot recovery enqueues `queued` rows.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `sandboxes.int-spec.ts` with real Docker: create → poll describe until `started` (≤ 20 s); stop → `stopped`; start → `started`; delete. Run all → PASS.
- [ ] **Step 5:** Commit `feat(sandboxd): control plane and capacity queue`.

### Task 5: Toolbox (files, exec, sessions)

**Files:** Create `src/toolbox.ts`, `src/exec.ts`, `test/toolbox.spec.ts`, `test/toolbox.int-spec.ts`.

**Interfaces — Consumes:** `DockerPort.exec/execDetached`, `Store`. **Produces:** routes under `/toolbox/:id/…` (bearer-auth; sandbox must be running, else 404 so the adapter re-looks-up once and then reports the real state). Behaviour must match `fake-daytona.ts` for each route — read its handler for the exact output format before implementing each one.

| Route                                                        | In-container argv (never interpolate caller strings into shell)                                                            | Answer                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `GET work-dir`                                               | —                                                                                                                          | `{dir: '/home/daytona'}`                                    |
| `GET files?path=`                                            | `find <p> -mindepth 1 -maxdepth 1 -printf '%y\t%s\t%f\0'` after `test -d`                                                  | `[{name,isDir,size}]`; missing 404; not a dir 400           |
| `GET files/info?path=`                                       | `stat -L -c '%F\t%s\t%n' -- <p>`                                                                                           | `{name: basename, isDir, size}`; 404                        |
| `GET files/download?path=`                                   | `test -f` then `cat -- <p>` (cap 64 MiB)                                                                                   | raw bytes, `application/octet-stream`; dir 400; missing 404 |
| `POST files/upload?path=` multipart `file`                   | `sh -c 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"' sh <p>` with stdin                                                 | 200 `{}`                                                    |
| `GET files/find?path=&pattern=`                              | `rg --json --fixed-strings --max-count 50 --max-filesize 1M -- <pattern> <p>` (exclude same vendor dirs the fake excludes) | `[{file, line, content}]`; missing 404                      |
| `GET files/search?path=&pattern=`                            | `find <p> -name <pattern> -not -path '*/node_modules/*' …`                                                                 | `{files: [...]}`                                            |
| `POST process/execute` `{command, cwd, envs, timeout}`       | `['sh','-c',command]`, cwd, env, timeoutMs = timeout×1000, cap 1 MiB                                                       | `{exitCode, result}`; timeout → 408 `{}`                    |
| `POST process/session` `{sessionId}`                         | record in store (`sessions` table: sandboxId, sessionId)                                                                   | 200 `{}`                                                    |
| `POST process/session/:sid/exec` `{command, runAsync: true}` | `execDetached(['setsid','sh','-c','echo $$ > /tmp/.sbx-session-<sid>; exec sh -c "$1"','sh',command])`                     | 200 `{}`                                                    |
| `DELETE process/session/:sid`                                | `sh -c 'kill -TERM -$(cat /tmp/.sbx-session-$1) 2>/dev/null; rm -f /tmp/.sbx-session-$1' sh <sid>`; unknown sid → 404      | 200 `{}`                                                    |

- Validate: `path` absolute, no NUL, ≤ 4096 chars; `sessionId` `/^[A-Za-z0-9_.-]{1,64}$/`; `timeout` 1–600; body ≤ 64 MiB (upload) / 1 MiB (JSON). Log `x-forge-operation-id`/`x-forge-lease-epoch` per call.

- [ ] **Step 1:** `toolbox.spec.ts` (FakeDocker scripted): path `'/x; rm -rf /'` arrives as a single argv element (assert recorded argv); relative path → 400; sessionId `'a b'` → 400; stopped sandbox → 404; execute timeout → 408; output > 1 MiB → `result` length ≤ 1 MiB; list maps `%y` `d`→`isDir:true`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement.
- [ ] **Step 4:** `toolbox.int-spec.ts` (real Docker, base image): upload binary to `/home/daytona/a/b.bin` then download equal; list/info/search/find against a seeded tree; `execute('echo $LC_ALL; exit 3', envs {LC_ALL:'C'})` → `{exitCode:3, result:'C\n'}`; execute `sleep 5` timeout 1 → 408 and no sleep in `ps`; session start `sleep 300` → `ps` shows it → DELETE → gone; symlink `/home/daytona/l -> /etc` then `files?path=/home/daytona/l` lists `/etc` (the API's realpath jail, not sandboxd, refuses it — this test just documents that sandboxd follows the contract). PASS.
- [ ] **Step 5:** Commit `feat(sandboxd): toolbox files, exec, sessions`.

### Task 6: Preview proxy

**Files:** Create `src/preview.ts`, `test/preview.spec.ts`. Route in control API: `GET /sandbox/:id/ports/:port/signed-preview-url?expiresInSeconds=`.

**Interfaces — Produces:** `mintPreviewToken(secret: Buffer, sandboxId: string, port: number, expiresAt: number /* unix s */): string` (format `base64url(json{s,p,e}) + '.' + base64url(hmac)`); `verifyPreviewToken(secret, token, now): {sandboxId, port} | null` (constant-time compare; rejects expired, malformed). Route answers `{url: cfg.previewPublicUrl, token}`; port 1–65535, `expiresInSeconds` 1–86400 (the API route broker asks for 30 s). Preview server (listen `previewListen`): read `x-daytona-preview-token`, verify, look up container IP via `docker.inspect`, proxy request (keep path/query, strip the token header, set `x-forwarded-*` passthrough) or `upgrade` (pipe sockets after writing the upstream 101). Bad/missing token → 401 (HTTP) or socket destroyed (upgrade). Sandbox not running → 503 `{message:'sandbox not running'}`. Upstream refused → 502.

- [ ] **Step 1:** Tests: round-trip; tampered payload/sig → null; expired → null; token for (A,3000) used against sandbox B is impossible by construction (route uses token's sandboxId — assert proxy dialled A's IP); HTTP proxy to a local test server via FakeDocker IP `127.0.0.1` returns body and path/query intact; WS upgrade through proxy echoes a frame (use `node:http` upgrade + raw socket, no ws dependency); bad token on upgrade → socket closed, upstream never contacted.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(sandboxd): token-routed preview proxy`.

### Task 7: Egress proxy (agent homes)

**Files:** Create `src/egress.ts`, `test/egress.spec.ts`.

**Interfaces — Consumes:** `Store` (networkAllow/BlockAll), docker inspect for IP→sandbox map (refresh on start/die events; `Map<ip, sandboxId>`). **Produces:** `startEgressProxy(cfg, deps: { sandboxForIp(ip): SandboxRow|undefined; resolve(host): Promise<string[]> }): http.Server`.

- Policy: allowed host set = row.networkAllow (if non-null: entries are hostnames or CIDRs; replaces default) else `cfg.egressAgentDefault` ∪ `{cfg.apiHost}`; `networkBlockAll` → refuse all. Match host exactly or as subdomain of a listed name (`api.anthropic.com` matches itself only; `.anthropic.com` form allows subdomains). Resolve, and refuse if any resolved address is private/loopback/link-local/CGNAT/multicast/`169.254.169.254`, unless host == `cfg.apiHost`; CIDR entries match resolved IPs. Connect to the resolved IP (not re-resolving). `CONNECT host:443` only ports 443/80; plain HTTP forward for `http://` absolute URIs. Unknown source IP → 403. Refusals: 403 + log `{sandboxId, host, reason}`.

- [ ] **Step 1:** Tests (local servers + injected resolver): allowed host CONNECT tunnels bytes; not-listed host → 403; host resolving to `10.0.0.5` → 403; host resolving to `169.254.169.254` → 403; apiHost resolving to private IP → allowed; CIDR entry `1.2.3.0/24` allows host resolving to `1.2.3.4`; `networkBlockAll` → 403; unknown client IP → 403; port 22 CONNECT → 403.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(sandboxd): agent-home egress allow-list proxy`.

### Task 8: Networks and firewall

**Files:** Create `src/network.ts`, `infra/sandboxd/firewall.sh`, `test/network.spec.ts`.

**Interfaces — Produces:** `ensureNetworks(docker)`: `sbx-agent` (`Internal: true`, `com.docker.network.bridge.enable_icc: 'false'`, subnet `172.30.0.0/24`), `sbx-proj` (`Internal: false`, icc false, subnet `172.30.1.0/24`). `applyFirewall(): Promise<void>` runs `firewall.sh apply`; `checkFirewall(): Promise<boolean>` runs `firewall.sh check` (exit 0 = rules present) → `/healthz.firewall`. Skipped (reported `firewall: 'skipped'`) when not Linux or `SANDBOXD_FIREWALL=off` (local dev only; refused when `SANDBOXD_REAL=1`).

- `firewall.sh apply|check`, own chains `SBX-FWD` (jumped from `DOCKER-USER`) and `SBX-IN` (jumped from `INPUT`), idempotent (flush own chains, re-add jumps only if absent). For `sbx-proj` sources: allow ESTABLISHED,RELATED; drop to 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16, 127/8, 224/4, both sandbox subnets; drop tcp dport 25,465,587; `hashlimit` new connections 20/s burst 50 per source; accept rest. `SBX-IN` for both subnets: accept tcp dport `$SBX_EGRESS_PORT` from `sbx-agent` only, tcp 443 to host (Caddy, for callback/API), drop everything else to the host. Values via env (`SBX_EGRESS_PORT`, subnets).

- [ ] **Step 1:** `network.spec.ts`: `ensureNetworks` calls FakeDocker with exact options; `firewall.sh` passes `shellcheck` (skip if absent) and `bash -n`; `apply` twice then `iptables -S SBX-FWD` count unchanged (Linux + root only; else skip with banner).
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS; re-run `spike.sh` checks 5–6 on Linux if available.
- [ ] **Step 5:** Commit `feat(sandboxd): sandbox bridges and host firewall`.

### Task 9: API edits — key file, real-suite images, capacity wait

**Files:** Modify `apps/api/src/config/environment.ts` (add `DAYTONA_API_KEY_FILE`), `apps/api/src/modules/sandbox/daytona.adapter.ts:105-111` (read file), `apps/api/.env.example`, `*-real` specs + `apps/gateway/test/preview-real.e2e-spec.ts` (image `daytonaio/sandbox:0.5.0-slim` → `forge/sandbox-base:1`), and verify `sandbox-claim.ts`, `sandbox-ops.consumer.ts` poll loops.

**Interfaces — Produces:** env: `DAYTONA_API_KEY_FILE` (path); exactly one of `DAYTONA_API_KEY`/`DAYTONA_API_KEY_FILE` with `DAYTONA_API_URL`; the ADR 027 refusal still applies to the env key only; the file key is allowed on real deployments.

- [ ] **Step 1:** Tests in the existing environment spec: URL + file → valid on a real deployment; URL + env key on a real deployment → still refused (unchanged message); both key forms → refused. Adapter spec: with `DAYTONA_API_KEY_FILE` pointing to a temp file containing `k\n`, requests carry `authorization: Bearer k`.
- [ ] **Step 2:** FAIL → **Step 3:** implement (read file once at construction, trim) → **Step 4:** PASS (`pnpm --filter @repo/api test -- environment daytona.adapter`).
- [ ] **Step 5:** Read `sandbox-claim.ts` and `sandbox-ops.consumer.ts` create/resume paths: confirm `starting` is polled until `started` or deadline. If either throws on `starting` or reports a generic failure on deadline, add a spec reproducing it and the minimal fix (treat `starting` as in-progress; deadline error message "Waiting for a free sandbox slot — try again shortly"). Record the finding in the commit message.
- [ ] **Step 6:** Commit `feat(api): sandbox key file, forge base image in real suites`.

### Task 10: Packaging, compose, host setup, CI, docs

**Files:** Create `apps/sandboxd/Dockerfile` (gateway's shape + `apk add iptables bash`, runs as root because it needs the socket and iptables — document why), `infra/sandboxd/{daemon.json,host-setup.sh,README.md}`, `infra/ansible/sandboxd.yml`. Modify `compose.yaml` (service `sandboxd`, `network_mode: host`, mounts `/var/run/docker.sock`, `/var/lib/sandboxd`, `cap_add: [NET_ADMIN]`, secret file; `mem_limit` on platform services; `oom_score_adj: -500` api/worker/postgres), `compose.override.yaml` (`DAYTONA_API_URL=http://host.docker.internal:3986`, key from `.env` local-only), `infra/compose.staging.yaml`, `infra/ansible/inventories/staging/hosts.yml` (replace `daytona` host with `sandboxd`; the missing `daytona.yml` reference goes away), `.github/workflows/ci.yml` (job: build base image, start sandboxd with runc + `SANDBOXD_FIREWALL=off`, run sandboxd int tests and `apps/api` `*-real` + gateway `preview-real` with `DAYTONA_API_URL` → sandboxd), `README.md` (local dev: sandboxd replaces Daytona).

- `daemon.json`: `runtimes.runsc = {path: '/usr/local/bin/runsc', runtimeArgs: ['--overlay2=none']}`, `userns-remap: 'default'`, `log-driver: local` with `max-size 10m`, `live-restore: true`, `default-address-pools` not overlapping `172.30.0.0/23`.
- `host-setup.sh` (Ubuntu 24.04, idempotent): install Docker CE + gVisor from official apt repos, write `daemon.json`, 4 GiB swapfile + `vm.swappiness=10`, optional XFS pquota data disk instructions (prints, does not format), creates `/var/lib/sandboxd` 0700, generates `/etc/sandboxd/api_key` 0600, then `docker build` base image.
- README: architecture summary, deploy steps (single VPS), staging mesh notes, capacity guidance (~6–8 comfortable, ~10 max on 8 GB), "never run `docker system prune`", disk alert at 70% via `/capacity`, how to run `spike.sh`, upgrade/rollback (Daytona selectable by pointing `DAYTONA_API_URL` back until `infra/daytona` is deleted).
- Add `GET /capacity` → `{running, queued, maxRunning, memAvailableBytes, diskFreeBytes, diskUsedPct}` (statfs of Docker root via `fs.statfs`).

- [ ] **Step 1:** Test `capacity` route in `sandboxes.spec.ts` (injected readers) → exact fields.
- [ ] **Step 2:** `docker compose config` validates for `compose.yaml` + override; `docker build -f apps/sandboxd/Dockerfile .` succeeds; `bash -n infra/sandboxd/*.sh`.
- [ ] **Step 3:** Local end-to-end: `docker compose up -d sandboxd postgres redis-*`; run `pnpm --filter @repo/api test:e2e -- sandbox-real sandbox-lifecycle-real checkpoints-real` with `DAYTONA_API_URL=http://127.0.0.1:3986` (check exact script names in `apps/api/package.json`). Expected: PASS, no `DAYTONA-SKIP` banner. Then `agent-real` and gateway `preview-real` if their other prerequisites (API key etc.) exist; otherwise record SKIP and why.
- [ ] **Step 4:** Commit `feat(infra): sandboxd compose, host setup, CI, docs`.

### Task 11 (manual, owner): VPS rollout

- [ ] Run `host-setup.sh` then `spike.sh` on the VPS; all checks PASS (or apply the README's per-failure fallback).
- [ ] Deploy; agent-home sign-in with a real Claude subscription; build a vite-react project to live preview.
- [ ] Soak with ~10 scripted people; watch `/capacity`, OOM logs.
- [ ] Then delete `infra/daytona/` and the Daytona override (separate PR).
