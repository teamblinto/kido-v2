# sandboxd

sandboxd (`apps/sandboxd`, spec 042) is the sandbox control plane that replaced Daytona. It speaks
Daytona's wire protocol, so the API's adapter just points `DAYTONA_API_URL` at it. Design:
[docs/specs/042-docker-sandboxes/design.md](../../docs/specs/042-docker-sandboxes/design.md).

## Architecture in one screen

- One container per host, `network_mode: host`, the only holder of `/var/run/docker.sock`. It runs as
  root (socket + iptables) with `userns_mode: host`, `NET_ADMIN`/`NET_RAW`, a read-only root fs.
- **Control API and preview proxy listen on `sbx-ctl`**, a small internal bridge
  (`172.30.2.0/24`, gateway `172.30.2.1`, created by compose) that only the worker is attached to:
  `172.30.2.1:3986` (bearer key) and `172.30.2.1:3987` (signed preview tokens). Not `127.0.0.1`
  (containers cannot reach the host's loopback) and not `0.0.0.0` (the public interface).
  Sandboxes are never on `sbx-ctl`, and `firewall.sh` denies them all of `172.16.0.0/12` anyway.
  Check on the real host that a container on `sbx-ctl` reaches `172.30.2.1` before relying on it.
- Sandboxes live on `sbx-agent` (`172.30.0.0/24`, internal, egress proxy only) and `sbx-proj`
  (`172.30.1.0/24`, filtered); `firewall.sh` owns the iptables chains. Project sandboxes run under
  gVisor (`runsc`), agent homes under hardened runc. Docker uses `userns-remap`.
- Secrets: the API key is the file `/etc/sandboxd/api_key` (`SANDBOXD_API_KEY_FILE`; the worker reads
  the same file as `DAYTONA_API_KEY_FILE`). The preview secret is generated into `/var/lib/sandboxd`.
- Because of userns-remap, `api`/`worker` also use `userns_mode: host` and the supplementary gid 3986
  so a non-root container can read the key (file is `0640 root:3986`, not `0600`). Only sandboxes
  stay remapped.

## Deploy (single 8 GB VPS, Ubuntu 24.04)

1. `sudo bash infra/sandboxd/host-setup.sh` prints the plan and changes nothing. Review it, then
   re-run with `--yes`. It installs Docker CE and gVisor from their apt repositories, writes
   [`daemon.json`](./daemon.json) (runsc with `--overlay2=none`, `userns-remap`, `local` log driver,
   `live-restore`, address pools away from `172.30.0.0/23`), adds a 4 GiB swapfile with
   `vm.swappiness=10`, creates `/var/lib/sandboxd` (0700) and `/etc/sandboxd/api_key`, and builds
   `forge/sandbox-base:1`. It refuses to replace a different `/etc/docker/daemon.json` unless
   `--force` (the old one is backed up first).
2. Disk quotas need XFS with `pquota`. Either pass a real data disk (`--data-disk /dev/sdb`: formatted
   and mounted at `/var/lib/docker-sbx`), or let it create a sparse loop file
   (`--loop-size 40G` is the default: `/var/lib/sbx-xfs.img`, `loop,pquota,nofail` in fstab).
   `--loop-size 0` skips XFS, and then you must set `SANDBOXD_STORAGE_QUOTA=0` (quotas off; weaker).
   Do this on a fresh host: images already under `/var/lib/docker` are not migrated.
3. Set `SANDBOXD_API_HOST` (the BAIOS API hostname agent homes may reach; sandboxd refuses to boot
   without it) and, if you used another data root, `SANDBOXD_DOCKER_ROOT`. Remove `compose.override.yaml`
   on the server, then `docker compose up -d --build`.
4. `bash infra/sandboxd/spike.sh` (below) as a final check; `curl` `/healthz` on `172.30.2.1:3986`.

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
diskFreeBytes, diskUsedPct`. **Alert at `diskUsedPct` 70.** `/healthz` is unauthenticated.
- **Never run `docker system prune`** (or `docker image prune -a`, `docker volume prune`) on this
  host: it deletes template and checkpoint images (`forge-snap/*`) that stopped sandboxes depend on.
- Local development: `compose.override.yaml` runs sandboxd on the default network with
  `SANDBOXD_FIREWALL=off` and runc. Sandboxes are not isolated there, and the preview proxy cannot
  reach sandbox IPs on Docker Desktop (the real suites' `preview-real` runs in CI on Linux).

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

Local Docker Desktop (runc only) expected: 1, 2, 3, 6 SKIP; 5 PASS; exit 0.

| Check                                                       | If it FAILs, the spec changes                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 runsc + `--overlay2=none`, `docker commit` keeps writes   | Template snapshots cannot use `docker commit`; build templates with `docker build` and drop snapshot-from-sandbox                                       |
| 2 `--storage-opt size=1G` returns ENOSPC                    | Disk quota fallback (loop-mounted per-sandbox volumes or XFS project quotas by hand); SKIP means Docker data root is not XFS+pquota, fix the host first |
| 3 Vite on 5173 returns 200 and WS 101 over the container IP | Preview proxying design (§ preview) must change, e.g. publish ports or use a different runtime for dev servers                                          |
| 4 `npm ci` runc vs runsc                                    | Informational: use the ratio to size build timeouts                                                                                                     |
| 5 `enable_icc=false` blocks A to B                          | Network isolation falls back to per-sandbox networks or iptables rules                                                                                  |
| 6 `169.254.169.254` unreachable after `firewall.sh`         | Egress firewall rules are wrong; fix `firewall.sh` before any sandbox runs                                                                              |
| 7 idle memory runc vs runsc                                 | Informational: adjust per-host sandbox density                                                                                                          |
