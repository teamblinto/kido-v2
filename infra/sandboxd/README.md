# sandboxd

sandboxd (`apps/sandboxd`, spec 042) is the sandbox control plane that replaced Daytona. It speaks
Daytona's wire protocol, so the API's adapter just points `DAYTONA_API_URL` at it. Design:
[docs/specs/042-docker-sandboxes/design.md](../../docs/specs/042-docker-sandboxes/design.md).

## Architecture in one screen

- One container per host, `network_mode: host`, the only holder of `/var/run/docker.sock`. It runs as
  root (socket + iptables) with `userns_mode: host`, `NET_ADMIN`/`NET_RAW`, a read-only root fs.
- **Control API and preview proxy listen on `sbx-ctl`**, a small internal bridge
  (`172.30.2.0/24`, gateway `172.30.2.1`, bridge name `sbx-ctl0`, created by compose, so the stack
  must be up before sandboxd can bind; it logs a clear error and retries every 5 s until then) that
  only the worker (and, in the VPS overlay, the api/gateway) is attached to: `172.30.2.1:3986`
  (bearer key) and `172.30.2.1:3987` (signed preview tokens). Not `127.0.0.1` (containers cannot
  reach the host's loopback) and not `0.0.0.0` (the public interface). Sandboxes are never on
  `sbx-ctl`.
- That address is a local one, and Linux accepts packets for any local address from any interface,
  so binding to it is not enough. `firewall.sh` therefore pins INPUT rules (derived from the config
  by `firewallEnv`): traffic to `172.30.2.1` is accepted from `lo`, and from `sbx-ctl0` on the two
  listener ports (an explicit ACCEPT, because UFW's default-deny INPUT policy would otherwise drop
  the worker and gateway), and dropped from anywhere else; traffic to the egress proxy address
  `172.30.0.1` from `lo` and `sbx-agent0` only (sandboxes reach the proxy port through the `SBX-IN`
  chain). They apply only when sandboxd listens on that bridge gateway; on the staging mesh it
  listens on a WireGuard address and these rules are skipped.
- Sandboxes live on `sbx-agent` (`172.30.0.0/24`, internal, egress proxy only) and `sbx-proj`
  (`172.30.1.0/24`, filtered); `firewall.sh` owns the iptables chains. Project sandboxes run under
  gVisor (`runsc`), agent homes under hardened runc. Docker uses `userns-remap`. Sandbox containers
  get `OomScoreAdj: 500`, so memory pressure kills a sandbox before the platform.
- DNS: gVisor's netstack cannot reach Docker's embedded resolver (`127.0.0.11`) on a user-defined
  bridge, and `--dns` does not change that. sandboxd writes `/var/lib/sandboxd/resolv.sandbox.conf`
  from `SANDBOXD_DNS` (IPv4 resolvers, default `1.1.1.1,9.9.9.9`) at boot and bind-mounts it
  read-only as `/etc/resolv.conf` into every gVisor sandbox: the only host mount a sandbox gets.
  `firewall.sh` accepts udp/tcp 53 from `sbx-proj` to exactly those resolvers. dockerd resolves
  the bind source on the host, so sandboxd's data dir must be the same path inside its container
  and on the host (compose mounts `/var/lib/sandboxd` at `/var/lib/sandboxd`). Agent homes never
  resolve names (the proxy does) and runc sandboxes keep Docker's DNS.
- Single host: a project sandbox calls the BAIOS API on the host's public address, which Docker
  DNATs to the edge container on a `10.x` network; `firewall.sh` accepts that DNAT'd path for the
  allowed ports (443) before its private-range denies.
- Secrets: the API key is the file `/etc/sandboxd/api_key` (`SANDBOXD_API_KEY_FILE`; the worker reads
  the same file as `DAYTONA_API_KEY_FILE`, and so does the api in the VPS overlay, whose preview
  broker asks sandboxd for each route's upstream). The preview secret is generated into
  `/var/lib/sandboxd`.
- The worker (and the overlay's api) stay under userns-remap: non-root, they read the key through
  supplementary gid 3986, which dockerd maps to host gid (dockremap subgid base + 3986);
  `host-setup.sh` chowns the key file (`0640`, not `0600`) to that gid. Only sandboxd runs in the
  host user namespace.

## Deploy (single 8 GB VPS, Ubuntu 24.04)

1. `sudo bash infra/sandboxd/host-setup.sh` prints the plan and changes nothing. Review it, then
   re-run with `--yes`. It installs Docker CE and gVisor from their apt repositories, writes
   [`daemon.json`](./daemon.json) (runsc with `--overlay2=none`, `userns-remap`, `local` log driver,
   `live-restore`, address pools away from `172.30.0.0/23`), a systemd drop-in so dockerd never
   starts before the data volume is mounted, a 4 GiB swapfile with `vm.swappiness=10`,
   `/var/lib/sandboxd` (0700) and `/etc/sandboxd/api_key`, and builds `forge/sandbox-base:1`. It
   refuses to replace a different `/etc/docker/daemon.json`, or to move the data root while Docker
   holds containers or volumes, unless `--force` (the old daemon.json is backed up first).
2. Disk quotas need XFS with `pquota`. Either pass a real data disk (`--data-disk /dev/sdb`: formatted
   and mounted at `/var/lib/docker-sbx`), or let it create a sparse loop file
   (`--loop-size 40G` is the default: `/var/lib/sbx-xfs.img`, `loop,pquota,nofail` in fstab; it checks
   the free space first). `--loop-size 0` skips XFS, and then you must set
   `SANDBOXD_STORAGE_QUOTA=0` (quotas off; weaker). Do this on a fresh host.
3. Build the web app Caddy serves (writes `apps/web/dist`). The host needs no Node; build it in a
   throwaway container:

       docker run --rm -v "$PWD":/repo -w /repo node:24-bookworm-slim sh -c 'corepack enable && CI=1 pnpm install --frozen-lockfile && pnpm --filter "@repo/web..." build'

   (it leaves a `node_modules` tree in the checkout; harmless, and the image builds ignore it).

4. Create `.env` next to `compose.yaml` (below), then `docker compose up -d --build`. The overlay's
   one-shot `migrate` service applies the database migrations first (the image's own migrator,
   on every `up`; the api and worker wait for it). To run it by hand:
   `docker compose run --rm migrate`.
5. `bash infra/sandboxd/spike.sh` as a final check; `curl` `/healthz` on `172.30.2.1:3986`.

### The single-VPS overlay (`compose.vps.yaml`) and what it is not

On the server, put `COMPOSE_FILE=compose.yaml:compose.vps.yaml` in `.env`. That also stops compose
loading the local-dev `compose.override.yaml`. The overlay unpublishes Postgres, the four Redis
instances and OpenBao (the base file publishes them for local development), publishes only Caddy on
80/443 with TLS from Let's Encrypt, and adds the preview gateway (`apps/gateway/Dockerfile`).

**This is a single-host, `DEPLOY_ENV=local`-grade deployment, not a hardened production one.** These
are not production-hardened, and the real deployment path is `infra/ansible`:

- the app runs with `DEPLOY_ENV=local`, which relaxes checks that real deployments enforce. On a
  public host that means: mail goes to the console mailer (printed to the api log, never
  delivered: no sign-up or reset emails), outbound webhooks may target plain `http://` URLs, and
  agent homes get `BAIOS_ALLOW_INSECURE_HTTP=1`;
- OpenBao is the in-memory dev server with a fixed, published root token, and it loses its keys on
  restart; `KEK_ENV_MASTER_KEY` is the all-zero placeholder, so tenant data keys are not protected;
- Postgres and Redis keep the repository's fixed passwords or none (reachable only inside the
  compose network);
- the gateway uses the plain broker over a shared network namespace, not mTLS. It therefore sits
  in the api's network namespace: a gateway compromise reaches everything the api can (the stores,
  the broker, sandboxd's control port). If the api container is recreated or restarts, the gateway is
  left in the dead namespace and turns unhealthy: `docker compose up -d gateway`;
- no object store is configured unless you add `OBJECT_STORE_*`, so features that need one
  (repository mirrors, deployed sites, some checkpoint artifacts) are unavailable;
- there are no backups and no replication.

`.env` needs:

- `APP_HOST` (apex, e.g. `app.example.com`), `HOOKS_HOST` (e.g. `hooks.example.com`),
  `PREVIEW_DOMAIN` (e.g. `preview.example.com`). DNS: `A` records for `APP_HOST` and `HOOKS_HOST`
  and a wildcard `A` record for `*.PREVIEW_DOMAIN`, all pointing at the VPS. Ports 80 and 443 must
  be open. Preview certificates are issued on demand per hostname, so the first load of a new
  preview is slow. Before issuing, Caddy asks the gateway (`TLS_ASK_PORT`), which approves only a
  label the broker knows, on its live route's port (a cold sandbox's label: at most three
  hostnames), so random names cannot exhaust the domain's Let's Encrypt quota. The alternative,
  one wildcard certificate, needs the DNS-01 challenge and therefore a Caddy build with your DNS
  provider's module (`xcaddy build --with github.com/caddy-dns/<provider>`); not done here.
- `SANDBOXD_API_HOST=<APP_HOST>`: the host agent homes may reach through the egress proxy. The
  callback URL the api hands to sandboxes (`SANDBOX_CALLBACK_URL`) is set by the overlay to
  `https://<APP_HOST>/api/v1/internal/sandbox-callbacks`; project sandboxes reach it on the host's
  public address.
- `PREVIEW_SIGNING_KEY`, `PREVIEW_SIGNING_KEY_ID`, `PREVIEW_PUBLIC_JWKS`, generated once:

      node -e "const c=require('crypto');const k=c.generateKeyPairSync('ed25519');const kid='vps-1';console.log('PREVIEW_SIGNING_KEY='+k.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'));console.log('PREVIEW_SIGNING_KEY_ID='+kid);const j=k.publicKey.export({format:'jwk'});console.log('PREVIEW_PUBLIC_JWKS='+JSON.stringify({keys:[{kty:'OKP',crv:'Ed25519',x:j.x,kid}]}))"

  Quote the JWKS line in `.env` with single quotes.

- `AGENT_HOME_CLAUDE_VERSION` (required by the overlay): an exact Claude Code version (e.g. `2.1.311`) for agent homes.
  The default `stable` installs whatever is current at template-publish time; pin it so the binary
  is one you chose, and bump it deliberately (a new value is a new template on the next publish).
- `SANDBOXD_DNS`, `SANDBOXD_MAX_RUNNING`, `SANDBOXD_MIN_MEM_AVAILABLE_MB` (optional): the
  sandbox resolvers and admission limits; compose passes them through with the defaults
  `1.1.1.1,9.9.9.9`, `22`, `1024`.
- `ANTHROPIC_API_KEY` only if you use the platform-key path (a platform credential in the model
  catalogue): add it to the `api` and `worker` environment in a third compose file listed in
  `COMPOSE_FILE`. Subscription (BYOS) linking needs none.

Staging mesh: [`infra/ansible/sandboxd.yml`](../ansible/sandboxd.yml) replaces the old `daytona`
host. It runs host-setup.sh and the container with `SANDBOXD_LISTEN` set to the host's WireGuard
address (never `0.0.0.0`), so the app and gateway hosts reach it over the mesh without TLS. The
app pool mounts the key as a file (`vault_sandboxd_api_key`). Release does not publish a sandboxd
image yet; `forge_sandboxd_image` must be one built from `apps/sandboxd/Dockerfile`.

## Capacity and operations

- 8 GB comfortably serves about 6-8 people actively building, about 10 at the limit with swap.
  Beyond that move to 16 GB or a second sandbox host. `SANDBOXD_MAX_RUNNING` and
  `SANDBOXD_MIN_MEM_AVAILABLE_MB` queue new sandboxes (they report `starting`) rather than refuse them.
- `GET /capacity` (bearer key) returns `running, queued, maxRunning, memAvailableBytes,
diskFreeBytes, diskUsedPct` (df's definition, of `SANDBOXD_DOCKER_ROOT`). **Alert at 70.** A root
  cron line that alerts past the threshold; the key is read by curl from the root-only header file
  `host-setup.sh` writes, so it never appears in a process list:

      */10 * * * * curl -fsS -H @/etc/sandboxd/capacity.header http://172.30.2.1:3986/capacity | jq -e '.diskUsedPct < 70' >/dev/null || echo 'sandboxd disk >= 70%' | mail -s sandboxd root

  `/healthz` is unauthenticated.

- **Never run `docker system prune`** (or `docker image prune -a`, `docker volume prune`) on this
  host: it deletes template and checkpoint images (`forge-snap/*`) that stopped sandboxes depend on.
- Local development: `compose.override.yaml` runs sandboxd on the default network with
  `SANDBOXD_FIREWALL=off` and runc. Sandboxes are not isolated there, and the preview proxy cannot
  reach sandbox IPs on Docker Desktop (the real suites' `preview-real` runs in CI on Linux).

### Running the real suites against a VPS

`sandbox-real`, `sandbox-lifecycle-real` (api) and `preview-real` (gateway) can run against the
compose stack from a throwaway Node 24 container attached to the compose network and `sbx-ctl`
(Postgres and Redis are not published). Use the compose hostnames for `DATABASE_*`/`REDIS_*_URL`,
`DAYTONA_API_URL=http://172.30.2.1:3986`, `PREVIEW_UPSTREAM_DIAL=http://172.30.2.1:3987` (the spec
dials that host and port), and read the key as gid 3986 (`docker exec -u 0:3986 ...`). Stop the
stack's worker for `sandbox-lifecycle-real`: it competes for the same pool and queue.

## Upgrade and rollback

Upgrade: `git pull && docker compose up -d --build sandboxd`. Running sandboxes are plain Docker
containers, so they survive a sandboxd restart (it re-adopts them from its sqlite file).
Rollback: `git checkout <previous> && docker compose up -d --build sandboxd`. To go back to
Daytona, point the worker's `DAYTONA_API_URL`/key back at it; that stays possible until
`infra/daytona` is deleted (design §14 step 8, after a staging soak).

## Spike

`spike.sh` is a throwaway host check for the Docker + gVisor design (spec 042 §7-§9). It prints
`PASS`/`FAIL`/`SKIP`/`INFO` per check and exits 1 if any check FAILs. It only creates resources
named `sbxspike-<pid>-*` and removes them on exit; it never edits daemon config or iptables
(except check 6, which runs `firewall.sh apply` and `check` once that exists, so run it only on the VPS). The
`node:24-slim` image is pulled if missing and left in place.

Run on the VPS (as a user in the `docker` group, gVisor installed and registered):

    bash infra/sandboxd/spike.sh

Local Docker Desktop (runc only) expected: 1, 2, 3, 6, 8 SKIP; 5 PASS; exit 0.

| Check                                                                             | If it FAILs, the spec changes                                                                                                                           |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 runsc + `--overlay2=none`, `docker commit` keeps writes                         | Template snapshots cannot use `docker commit`; build templates with `docker build` and drop snapshot-from-sandbox                                       |
| 2 `--storage-opt size=1G` returns ENOSPC                                          | Disk quota fallback (loop-mounted per-sandbox volumes or XFS project quotas by hand); SKIP means Docker data root is not XFS+pquota, fix the host first |
| 3 Vite on 5173 returns 200 and WS 101 over the container IP                       | Preview proxying design (§ preview) must change, e.g. publish ports or use a different runtime for dev servers                                          |
| 4 `npm ci` runc vs runsc                                                          | Informational: use the ratio to size build timeouts                                                                                                     |
| 5 `enable_icc=false` blocks A to B                                                | Network isolation falls back to per-sandbox networks or iptables rules                                                                                  |
| 6 `169.254.169.254` unreachable after `firewall.sh`                               | Egress firewall rules are wrong; fix `firewall.sh` before any sandbox runs                                                                              |
| 7 idle memory runc vs runsc                                                       | Informational: adjust per-host sandbox density                                                                                                          |
| 8 runsc on a user-defined bridge resolves names with sandboxd's bound resolv.conf | gVisor sandboxes have no DNS: check outbound udp/53 to the resolvers and the `Binds` in classes.ts                                                      |
