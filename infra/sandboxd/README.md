# sandboxd

## Spike

`spike.sh` is a throwaway host check for the Docker + gVisor design (spec 042 §7-§9). It prints
`PASS`/`FAIL`/`SKIP`/`INFO` per check and exits 1 if any check FAILs. It only creates resources
named `sbxspike-<pid>-*` and removes them on exit; it never edits daemon config or iptables
(except check 6, which runs `firewall.sh` once that exists, so run it only on the VPS). The
`node:24-slim` image is pulled if missing and left in place.

Run on the VPS (as a user in the `docker` group, gVisor installed and registered):

    bash infra/sandboxd/spike.sh

Local Docker Desktop (runc only) expected: 1, 2, 3, 6 SKIP; 5 PASS; exit 0.

| Check | If it FAILs, the spec changes |
|-------|-------------------------------|
| 1 runsc + `--overlay2=none`, `docker commit` keeps writes | Template snapshots cannot use `docker commit`; build templates with `docker build` and drop snapshot-from-sandbox |
| 2 `--storage-opt size=1G` returns ENOSPC | Disk quota fallback (loop-mounted per-sandbox volumes or XFS project quotas by hand); SKIP means Docker data root is not XFS+pquota, fix the host first |
| 3 Vite on 5173 returns 200 and WS 101 over the container IP | Preview proxying design (§ preview) must change, e.g. publish ports or use a different runtime for dev servers |
| 4 `npm ci` runc vs runsc | Informational: use the ratio to size build timeouts |
| 5 `enable_icc=false` blocks A to B | Network isolation falls back to per-sandbox networks or iptables rules |
| 6 `169.254.169.254` unreachable after `firewall.sh` | Egress firewall rules are wrong; fix `firewall.sh` before any sandbox runs |
| 7 idle memory runc vs runsc | Informational: adjust per-host sandbox density |
