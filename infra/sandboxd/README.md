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
  `firewall.sh` accepts udp/tcp 53 from `sbx-proj` to exactly those resolvers (before its private-range
  denies, so sandboxd refuses to boot with a private or otherwise non-public resolver). The file is
  bound when a sandbox is created, so after changing `SANDBOXD_DNS` restart sandboxd and then the
  sandboxes (stop/start) for running ones to pick it up. dockerd resolves
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

- Repository mirrors: with no bucket configured, the overlay sets `OBJECT_STORE_DIR` and keeps them on
  the `repo-mirrors` volume. A mirror is the only copy of a project's files that outlives its sandbox
  (a replaced sandbox is restored from it), so back this volume up with Postgres.

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
loading the local-dev `compose.override.yaml`. The overlay unpublishes Postgres and the four Redis
instances (the base file publishes them for local development), does not run OpenBao (the KEK is
the env provider), publishes only Caddy on 80/443 with TLS from Let's Encrypt, and adds the preview
gateway (`apps/gateway/Dockerfile`).

**This is a single-host, `DEPLOY_ENV=local`-grade deployment, not a hardened production one.** These
are not production-hardened, and the real deployment path is `infra/ansible`:

- the app runs with `DEPLOY_ENV=local`, which relaxes checks that real deployments enforce. On a
  public host that means: mail goes to the console mailer (printed to the api log, never
  delivered: no sign-up or reset emails), outbound webhooks may target plain `http://` URLs, and
  agent homes get `BAIOS_ALLOW_INSECURE_HTTP=1`;
- the KEK is the env provider: `KEK_ENV_MASTER_KEY` sits in `.env` on the host, so anyone with
  root there can unwrap tenant data keys. No OpenBao runs (its dev server would regenerate the KEK
  on every restart and make all tenant-encrypted data unreadable);
- Postgres and Redis keep the repository's fixed passwords or none (reachable only inside the
  compose network);
- the gateway uses the plain broker over a shared network namespace, not mTLS. It therefore sits
  in the api's network namespace: a gateway compromise reaches everything the api can (the stores,
  the broker, sandboxd's control port). If the api container is recreated or restarts, the gateway is
  left in the dead namespace: kido-deploy recreates it on every deploy, and otherwise its watchdog
  (`GATEWAY_WATCHDOG_URL`) exits after about 30 s without an answer from the api, so Docker restarts
  it into the api's live namespace. Docker makes that start once: if the api is not running at that
  moment (crash-looping), run `docker compose up -d gateway` once it is;
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
- Derived from `APP_HOST` by the overlay, nothing to set: `SANDBOXD_API_HOST` (the one BAIOS
  host agent homes may reach through the egress proxy), `AGENT_HOME_SERVER_URL=https://<APP_HOST>`
  (where a home's runner calls the api: proxy -> host's public address -> Caddy -> api) and
  `SANDBOX_CALLBACK_URL=https://<APP_HOST>/api/v1/internal/sandbox-callbacks` (project sandboxes
  reach it on the host's public address).
- `KEK_ENV_MASTER_KEY`, generated once: `openssl rand -base64 32`. Every tenant data key is
  wrapped with it: back it up with the database, and never change it on a stack that holds data
  (the data becomes unreadable).
- `PREVIEW_SIGNING_KEY`, `PREVIEW_SIGNING_KEY_ID`, `PREVIEW_PUBLIC_JWKS`, generated once:

      node -e "const c=require('crypto');const k=c.generateKeyPairSync('ed25519');const kid='vps-1';console.log('PREVIEW_SIGNING_KEY='+k.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'));console.log('PREVIEW_SIGNING_KEY_ID='+kid);const j=k.publicKey.export({format:'jwk'});console.log('PREVIEW_PUBLIC_JWKS='+JSON.stringify({keys:[{kty:'OKP',crv:'Ed25519',x:j.x,kid}]}))"

  Quote the JWKS line in `.env` with single quotes.

- `AGENT_HOME_CLAUDE_VERSION` (required by the overlay): an exact Claude Code version (e.g. `2.1.311`) for agent homes.
  The default `stable` installs whatever is current at template-publish time; pin it so the binary
  is one you chose, and bump it deliberately (a new value is a new template on the next publish).
- `SANDBOXD_DNS`, `SANDBOXD_MAX_RUNNING`, `SANDBOXD_MIN_MEM_AVAILABLE_MB` (optional): the
  sandbox resolvers and admission limits; compose passes them through with the defaults
  `1.1.1.1,9.9.9.9`, `22`, `1024`.
- No model key: platform credits are retired (spec 043). Runs are paid by the person's connected
  subscription or the organisation's own API key (Settings → Provider keys).

Staging mesh: [`infra/ansible/sandboxd.yml`](../ansible/sandboxd.yml) replaces the old `daytona`
host. It runs host-setup.sh and the container with `SANDBOXD_LISTEN` set to the host's WireGuard
address (never `0.0.0.0`), so the app and gateway hosts reach it over the mesh without TLS;
`firewall.sh` accepts the two listener ports on that address only from the interface that owns it
(found from the address at boot). The app pool mounts the key as a file
(`vault_sandboxd_api_key`) into both the worker and the api (whose preview route broker mints
preview upstreams; spec 013 R10 is amended for this, design §8). sandboxd is not in
`infra/deploy.sh`'s `CREDENTIAL_FREE_SERVICES_PATTERN`: that pattern names services of the rendered
app-pool stack (`compose.staging.yaml`) whose environment must carry no platform credential, and
sandboxd is never in that stack (its own Ansible play, its own host); its environment holds no
credential either (the key is a file), and deploy.sh is pinned byte-for-byte by `check-fr038.sh`. Release
publishes `ghcr.io/<owner>/forge-sandboxd` by digest (signed, like the other two images);
`forge_sandboxd_image` can be that `repository@digest`.

## Agent-home egress

Agent homes have no route out except sandboxd's egress proxy, which admits only
`SANDBOXD_API_HOST` (the BAIOS api) and `SANDBOXD_EGRESS_AGENT_DEFAULT`, by default:

| Host                  | Why                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `api.anthropic.com`   | Claude API, feature flags, telemetry events. Measured: the only host Claude Code 2.1.311 contacted (below).  |
| `platform.claude.com` | OAuth token exchange, refresh and revocation, also for claude.ai accounts (Anthropic's network-config docs). |
| `claude.ai`           | claude.ai account authentication (same docs).                                                                |

Sources: [code.claude.com/docs/en/network-config](https://code.claude.com/docs/en/network-config.md)
("Network access requirements"), and a measurement on the test VPS (2026-11-03): in an agent home
from the published `agent-home` template, `claude --version`, `claude auth login` (only until it
printed its sign-in URL; nothing was entered) and `claude -p hi` without credentials opened 7
tunnels, all to `api.anthropic.com:443`, and none was refused. The sign-in URL itself is
`claude.com/cai/oauth/authorize` with `redirect_uri=https://platform.claude.com/oauth/code/callback`;
`claude.com` and `sso.claude.com` are opened by the person's own browser, not by the CLI.

Deliberately not allowed: `statsig.anthropic.com` and `console.anthropic.com` (the old defaults; not
in Anthropic's list, not contacted, and statsig does not resolve), the Datadog telemetry intakes
(optional, disabled by failing closed), `downloads.claude.ai` (the binary is baked into the image
and `DISABLE_AUTOUPDATER=1`), `mcp-proxy.anthropic.com` (claude.ai connectors; homes only use
`mcp__baios__*` tools), plugin and marketplace hosts. **Not yet verified:** a full sign-in plus one
real turn, which needs a person with a real subscription; if it is refused, the refused host is in
sandboxd's log as `egress refused` with its reason.

## Capacity and operations

- sandboxd idles at about 40 MiB; its `mem_limit` is 768 MiB because a 64 MiB upload is buffered
  2-3x and downloads run concurrently, and an OOM kill would drop every live preview at once.
- 8 GB comfortably serves about 6-8 people actively building, about 10 at the limit with swap.
  Beyond that move to 16 GB or a second sandbox host. `SANDBOXD_MAX_RUNNING` and
  `SANDBOXD_MIN_MEM_AVAILABLE_MB` queue new sandboxes (they report `starting`) rather than refuse them.
- `GET /capacity` (bearer key) returns `running, queued, maxRunning, memAvailableBytes,
diskFreeBytes, diskUsedPct` (df's definition, of `SANDBOXD_DOCKER_ROOT`). **Alert at 70.** A root
  cron line that alerts past the threshold; the key is read by curl from the root-only header file
  `host-setup.sh` writes, so it never appears in a process list:

      */10 * * * * curl -fsS -H @/etc/sandboxd/capacity.header http://172.30.2.1:3986/capacity | jq -e '.diskUsedPct < 70' >/dev/null || echo 'sandboxd disk >= 70%' | mail -s sandboxd root

  With `--loop-size` the XFS data root is a sparse file on the root disk, which can fill before
  `diskUsedPct` says so; check the root disk too:

      */10 * * * * [ "$(df --output=pcent / | tail -1 | tr -dc 0-9)" -lt 70 ] || echo 'root disk >= 70%' | mail -s sandboxd root

  `/healthz` is unauthenticated.

- **Never run `docker system prune`** (or `docker image prune -a`, `docker volume prune`) on this
  host: it deletes template and checkpoint images (`forge-snap/*`) that stopped sandboxes depend on.
- Local development: `compose.override.yaml` runs sandboxd on the default network with
  `SANDBOXD_FIREWALL=off` and runc. Sandboxes are not isolated there, the preview proxy cannot
  reach sandbox IPs on Docker Desktop (the real suites' `preview-real` runs in CI on Linux), and
  **agent homes do not work**: their only way out is the egress proxy on the `sbx-agent` gateway,
  which sandboxd cannot bind without host networking, and with inter-container traffic off the
  bridge drops a home's packets to a sandboxd container attached to it. Use a Linux host for them.

### Running the real suites against a VPS

`sandbox-real`, `sandbox-lifecycle-real` (api) and `preview-real` (gateway) can run against the
compose stack from a throwaway Node 24 container attached to the compose network and `sbx-ctl`
(Postgres and Redis are not published). Use the compose hostnames for `DATABASE_*`/`REDIS_*_URL`,
`DAYTONA_API_URL=http://172.30.2.1:3986`, `PREVIEW_UPSTREAM_DIAL=http://172.30.2.1:3987` (the spec
dials that host and port), and read the key as gid 3986 (`docker exec -u 0:3986 ...`). Stop the
stack's worker for `sandbox-lifecycle-real`: it competes for the same pool and queue.

## Continuous deployment (kido.blinto.co)

The production VPS runs the overlay as compose project `kido`, driven by
[`deploy-vps.sh`](./deploy-vps.sh), installed as `/usr/local/bin/kido-deploy`:

| Path                       | What                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/opt/kido/kido.env`       | Host config and every secret (`KEK_ENV_MASTER_KEY`, `BROKER_SHARED_SECRET`, `PREVIEW_SIGNING_KEY`...), root `0600`, generated once on the host. CI never sees or renders it.                |
| `/opt/kido/releases/<id>/` | One per deploy: `compose.yaml`, `compose.vps.yaml`, `infra/`, `apps/web/dist/`, `release.env` (image refs only, no secrets). It is the compose project directory. The newest five are kept. |
| `/opt/kido/current`        | Symlink to the live release; `previous` to the one before.                                                                                                                                  |
| `/opt/kido/src/`           | A source tree for host builds (`git archive` of a commit).                                                                                                                                  |
| `/etc/sandboxd/api_key`    | sandboxd's key (host-setup.sh).                                                                                                                                                             |

A deploy (`kido-deploy deploy <id>`): optional GHCR login from stdin, pull, `docker logout`, the
`migrate` one-shot, `up -d --no-build --remove-orphans`, every service healthy, sandboxd
`/healthz` with `firewall: true`, then `https://APP_HOST/` and `/api/v1/health` through Caddy on
127.0.0.1 (`curl --resolve`). If any of that fails it re-deploys the previous release (migrations
already applied stay applied, so they must stay backward compatible for one release). Deploys
take a lock, and the workflow's `concurrency` also serialises them. Each deploy recreates Caddy
(its release directory is new) and, when its image changed, sandboxd, which drops live previews.

`kido.env` holds `COMPOSE_FILE`, `APP_HOST=kido.blinto.co`,
`HOOKS_HOST=hooks.kido.blinto.co` (it must differ from `APP_HOST`, and it must not sit under
`PREVIEW_DOMAIN`: Caddy would put it under the wildcard's on-demand TLS policy, whose `ask` only
approves preview labels, so it would never get a certificate),
`PREVIEW_DOMAIN=preview.kido.blinto.co`, `AGENT_HOME_CLAUDE_VERSION` and the secrets above, made
as in the overlay section above plus `BROKER_SHARED_SECRET=$(openssl rand -hex 32)`.

DNS: `kido.blinto.co` is Cloudflare-proxied (Caddy gets its certificate from Let's Encrypt over
HTTP-01 through the proxy, so Cloudflare must pass `/.well-known/acme-challenge/` on port 80 to
the origin). `*.preview.kido.blinto.co` and `hooks.kido.blinto.co` must be DNS-only (grey cloud)
`A` records to the VPS: Cloudflare's universal certificate covers `*.blinto.co` only, not these
deeper names, and Caddy issues their certificates itself (previews on demand).

Operator commands (as root on the VPS):

    kido-deploy build /opt/kido/src [id]    # build the three images and the web app here, deploy them
    kido-deploy rollback                    # re-deploy the previous release
    kido-deploy redeploy                    # re-deploy the current release (after editing kido.env or oauth.env)
    kido-deploy deploy <id>                 # re-deploy any kept release (its images are still local)
    d=/opt/kido/current; docker compose -p kido --project-directory $d --env-file /opt/kido/kido.env --env-file $d/release.env ps

Sign-in providers (optional): the api reads `/opt/kido/oauth.env` if it exists (`env_file` with
`required: false` in compose.vps.yaml; only the api runs OAuth). Create it root-only with both
lines of a provider, never a blank value (an empty value fails the api's config check):

    install -m 0600 /dev/null /opt/kido/oauth.env
    printf '%s\n' 'GOOGLE_OAUTH_CLIENT_ID=<client id>' 'GOOGLE_OAUTH_CLIENT_SECRET=<client secret>' >> /opt/kido/oauth.env
    kido-deploy redeploy

The Google OAuth client's authorised redirect URI is
`https://kido.blinto.co/api/v1/auth/oauth/google/callback` (`APP_URL`, which the overlay sets to
`https://APP_HOST`, plus `/api/v1/auth/oauth/google/callback`). GitHub sign-in works the same way
with `GITHUB_OAUTH_CLIENT_ID`/`GITHUB_OAUTH_CLIENT_SECRET`. Removing the file and redeploying
turns the provider off.

The GitHub connector (a GitHub App, root README "GitHub sync"; unrelated to GitHub sign-in) reads
`/opt/kido/github.env` in the api and the worker. Set `GITHUB_WEBHOOK_SECRET` (required,
`openssl rand -hex 32`) in `kido.env` and as the App's webhook secret; the App's webhook URL is
`https://HOOKS_HOST/github`. Then, root-only, all four or none:

    install -m 0600 /dev/null /opt/kido/github.env
    # GITHUB_APP_ID=<numeric id>  GITHUB_APP_CLIENT_ID=<Iv23...>  GITHUB_APP_SLUG=<slug>
    # GITHUB_APP_PRIVATE_KEY="<the .pem with newlines as \n>"  GITHUB_APP_CLIENT_SECRET=<optional>
    kido-deploy redeploy

To deploy a commit by hand without CI:
`git archive <commit> | ssh root@VPS 'rm -rf /opt/kido/src && mkdir /opt/kido/src && tar -x -C /opt/kido/src'`,
then `kido-deploy build /opt/kido/src`.

### Automatic deploys

`release.yml`'s `deploy` job runs after the three images of a green `main` commit are published.
It needs three repository secrets and skips with a notice while any is missing. The owner sets
them up once:

1. On your own machine, make a key used for nothing else (no passphrase: CI cannot type one):

       ssh-keygen -t ed25519 -N '' -C kido-deploy@github-actions -f kido_deploy

2. On the VPS, authorise it for exactly the deploy command by appending one line to
   `/root/.ssh/authorized_keys`:

       restrict,command="/usr/local/bin/kido-deploy" ssh-ed25519 AAAA...(the contents of kido_deploy.pub)

   `restrict` turns off pty, port, agent and X11 forwarding; `command=` makes the key run only
   `kido-deploy`, which reads `receive <id>` or `deploy <id> --registry-user <name>` from
   `SSH_ORIGINAL_COMMAND` and refuses anything else. A `from="..."` pin is not practical for
   GitHub-hosted runners (their addresses are many and change); add one if you move to a
   self-hosted runner. Trade-offs: whoever holds this key can still deploy arbitrary compose
   files, and the stack runs privileged containers, so the key is root-equivalent either way;
   `command=` narrows it to deploys and keeps it off a shell. A dedicated non-root `deploy` user
   in the `docker` group is no less powerful (the docker group is root-equivalent) and needs a
   sudoers rule (`deploy ALL=(root) NOPASSWD: /usr/local/bin/kido-deploy`) with the key line
   `restrict,command="sudo /usr/local/bin/kido-deploy $SSH_ORIGINAL_COMMAND" ssh-ed25519 ...`;
   what it adds is a separate login and audit trail, not containment. Root with
   `restrict,command=` is the simpler choice here.

3. Pin the host key (compare the fingerprint with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`
   run on the VPS), then set the secrets:

       ssh-keyscan -t ed25519 62.84.187.212 > kido_known_hosts
       ssh-keygen -lf kido_known_hosts
       gh secret set VPS_SSH_KEY -R teamblinto/kido-v2 < kido_deploy
       gh secret set VPS_KNOWN_HOSTS -R teamblinto/kido-v2 < kido_known_hosts
       gh secret set VPS_HOST -R teamblinto/kido-v2 --body 62.84.187.212

   Then delete the local private key `kido_deploy` (or keep it offline). `VPS_HOST` may be
   `user@host`; the default user is `root`.

The job builds the web app, sends a tarball of the release (compose files, `infra/`,
`apps/web/dist`, and a `release.env` with the three `ghcr.io/...@sha256:` digests) to
`kido-deploy receive`, then runs `kido-deploy deploy` with the job's own `GITHUB_TOKEN`
(`packages: read`, valid only while the job runs) on stdin; the server logs in with
`--password-stdin` and logs out right after the pull. To retry, re-run the `deploy` job from the
Actions page; to undo, `kido-deploy rollback` on the server.

### Other sites on the VPS

The edge Caddy holds 80 and 443, so another app on the host (Bee Bot at `beebot.blinto.co`)
is served through it. Its site block goes in `/etc/kido/caddy-sites.d/<name>.caddy` on the
host, never in a release directory, which the next deploy replaces. `kido-deploy` restarts the
edge on a deploy; to apply a change between deploys, `docker restart kido-caddy-1` (admin is
off, so there is no reload). Files must be readable by others (0644): the container runs
under Docker's remapped uids.

    beebot.blinto.co {
    	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
    	reverse_proxy 10.210.0.1:8480
    }

## Upgrade and rollback

On the kido VPS use `kido-deploy` (above). Elsewhere:

Upgrade: `git pull && docker compose up -d --build sandboxd`. Running sandboxes are plain Docker
containers, so they survive a sandboxd restart (it re-adopts them from its sqlite file), but every
live preview connection and Vite HMR WebSocket goes through sandboxd and is dropped: open previews
reconnect (HMR) or need a reload. Upgrade when nobody is mid-build.
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
