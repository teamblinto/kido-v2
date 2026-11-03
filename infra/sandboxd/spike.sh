#!/usr/bin/env bash
# Throwaway host checks for the Docker + gVisor sandbox design (spec 042 §7-§9).
# Read-only w.r.t. anything it didn't create: every resource is named sbxspike-$$-*
# and removed on exit. Never touches daemon config, iptables or existing containers.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash: stop /path args being rewritten

P="sbxspike-$$"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$HERE/../../apps/api/templates/vite-react/files"
NODE_IMG="node:24-slim"
command -v cygpath >/dev/null && TEMPLATE="$(cygpath -m "$TEMPLATE")" # Git Bash: docker.exe needs a Windows path
VITE="vite@6"
FAILS=0
IMG_COMMIT="$P-commit"
TMP="$(mktemp -d)"

cleanup() {
  docker ps -aq --filter "name=$P-" 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network ls -q --filter "name=$P-" 2>/dev/null | xargs -r docker network rm >/dev/null 2>&1 || true
  docker rmi -f "$IMG_COMMIT" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

pass() { echo "PASS $1"; }
fail() { echo "FAIL $1${2:+ ($2)}"; FAILS=$((FAILS + 1)); }
skip() { echo "SKIP $1 ($2)"; }

command -v docker >/dev/null && docker info >/dev/null 2>&1 || { echo "FAIL docker (daemon not reachable)"; exit 1; }

docker image inspect "$NODE_IMG" >/dev/null 2>&1 || docker pull -q "$NODE_IMG" >/dev/null # left in place: not ours to remove
HAVE_RUNSC=0
docker info --format '{{json .Runtimes}}' | grep -q runsc && HAVE_RUNSC=1
IS_LINUX=0
[ "$(docker info --format '{{.OSType}}')" = linux ] && [ "$(uname -s)" = Linux ] && IS_LINUX=1

# 1. runsc registered with --overlay2=none; writes survive docker commit
if [ $HAVE_RUNSC = 0 ]; then skip "1 runsc-commit" "runsc not registered"
else
  # shortcut: daemon.json is only readable when the script runs on the daemon host as a permitted user
  if [ -r /etc/docker/daemon.json ] && ! grep -q 'overlay2=none' /etc/docker/daemon.json; then
    fail "1 runsc-commit" "runsc runtimeArgs lack --overlay2=none"
  else
    if ! err=$(docker run -d --runtime=runsc --name "$P-c1" "$NODE_IMG" sleep 300 2>&1 >/dev/null &&
        docker exec "$P-c1" sh -c 'echo spike > /opt/spike.txt' 2>&1 &&
        docker commit "$P-c1" "$IMG_COMMIT" 2>&1 >/dev/null); then
      fail "1 runsc-commit" "runsc container/commit failed: $(echo "$err" | tail -1)"
    elif [ "$(docker run --rm --runtime=runc "$IMG_COMMIT" cat /opt/spike.txt 2>/dev/null)" = spike ]; then
      pass "1 runsc-commit"
    else fail "1 runsc-commit" "committed image lacks file"; fi
  fi
fi

# 2. storage-opt size=1G enforced (needs overlay2 on XFS pquota)
if [ $IS_LINUX = 0 ]; then skip "2 storage-quota" "not Linux"
elif ! docker create --name "$P-c2probe" --storage-opt size=1G "$NODE_IMG" true >/dev/null 2>&1; then
  skip "2 storage-quota" "--storage-opt unsupported (need overlay2 on xfs pquota)"
else
  docker rm -f "$P-c2probe" >/dev/null
  rt=(); [ $HAVE_RUNSC = 1 ] && rt=(--runtime=runsc)
  if docker run --rm --name "$P-c2" "${rt[@]}" --storage-opt size=1G "$NODE_IMG" \
      sh -c 'dd if=/dev/zero of=/big bs=1M count=1536 2>&1 | grep -qi "no space"' ; then
    pass "2 storage-quota"
  else fail "2 storage-quota" "1.5 GiB write was not stopped by ENOSPC"; fi
fi

# 3. vite under runsc: HTTP 200 + WS 101 via container IP
if [ $HAVE_RUNSC = 0 ] || [ $IS_LINUX = 0 ]; then skip "3 vite-preview" "needs runsc on a Linux host"
else
  docker run -d --runtime=runsc --name "$P-c3" "$NODE_IMG" sh -c \
    "mkdir /app && cd /app && echo '{\"name\":\"s\",\"private\":true}' > package.json && echo '<h1>ok</h1>' > index.html && exec npx --yes $VITE --host 0.0.0.0 --port 5173" >/dev/null &&
  ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$P-c3") || ip=""
  code=000
  [ -n "$ip" ] && for _ in $(seq 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://$ip:5173/" || true)
    [ "$code" = 200 ] && break; sleep 2
  done
  ws=""
  [ -n "$ip" ] && ws=$(curl -s -i -N -m 5 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Protocol: vite-hmr' \
    "http://$ip:5173/" | head -1 || true)
  if [ -z "$ip" ]; then fail "3 vite-preview" "runsc container failed to start"
  elif [ "$code" = 200 ] && echo "$ws" | grep -q 101; then pass "3 vite-preview"
  else fail "3 vite-preview" "http=$code ws='$ws'"; fi
fi

# 4. npm ci timing, runc vs runsc (informational)
t_ci() { # runtime
  local n="$P-c4-$1" s
  docker run -d --runtime="$1" --name "$n" "$NODE_IMG" sleep 600 >/dev/null
  docker cp "$TEMPLATE/." "$n:/app"
  s=$(date +%s)
  if docker exec -w /app "$n" npm ci --no-audit --no-fund >/dev/null 2>&1; then echo "$(( $(date +%s) - s ))s"; else echo "n/a (failed)"; fi
  docker rm -f "$n" >/dev/null
}
echo "INFO 4 npm-ci runc=$(t_ci runc)"
if [ $HAVE_RUNSC = 1 ]; then echo "INFO 4 npm-ci runsc=$(t_ci runsc)"; else skip "4 npm-ci runsc" "runsc not registered"; fi

# 5. icc=false bridge: A cannot reach B (works on Docker Desktop too: daemon runs in a Linux VM)
docker network create --driver bridge -o com.docker.network.bridge.enable_icc=false "$P-net" >/dev/null
docker run -d --name "$P-a" --network "$P-net" "$NODE_IMG" sleep 120 >/dev/null
docker run -d --name "$P-b" --network "$P-net" "$NODE_IMG" node -e "require('http').createServer((q,r)=>r.end('b')).listen(8080)" >/dev/null
bip=$(docker inspect -f '{{(index .NetworkSettings.Networks "'"$P-net"'").IPAddress}}' "$P-b")
sleep 2
reach() { # exits 0 if A can open a TCP connection to B:8080
  docker exec "$P-a" node -e "const s=require('net').connect(8080,'$bip');s.setTimeout(3000,()=>process.exit(1));s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1))"
}
# control: B itself must be listening, else a blocked connect proves nothing
if ! docker exec "$P-b" node -e "require('net').connect(8080,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"; then
  fail "5 icc-isolation" "control: B not listening"
elif reach; then fail "5 icc-isolation" "A reached B"
else pass "5 icc-isolation"; fi

# 6. metadata endpoint blocked after firewall.sh (only once Task 8 lands)
if [ ! -f "$HERE/firewall.sh" ]; then skip "6 metadata-block" "infra/sandboxd/firewall.sh not present yet"
elif [ $IS_LINUX = 0 ]; then skip "6 metadata-block" "not Linux"
else
  # shortcut: assumes `firewall.sh apply|check` interface and idempotent apply; it edits iptables, so run only on the VPS
  echo "NOTE 6 running firewall.sh apply (modifies iptables DOCKER-USER)"
  if ! bash "$HERE/firewall.sh" apply >/dev/null 2>&1; then fail "6 metadata-block" "firewall.sh apply failed"
  elif ! bash "$HERE/firewall.sh" check >/dev/null 2>&1; then fail "6 metadata-block" "firewall.sh check failed"
  elif docker run --rm --name "$P-c6" "$NODE_IMG" node -e "const s=require('net').connect(80,'169.254.169.254');s.setTimeout(3000,()=>process.exit(1));s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1))" >/dev/null 2>&1
  then fail "6 metadata-block" "169.254.169.254 reachable"; else pass "6 metadata-block"; fi
fi

# 7. idle memory runc vs runsc (informational)
mem() { # runtime
  docker run -d --runtime="$1" --name "$P-c7-$1" "$NODE_IMG" sleep 120 >/dev/null
  sleep 3
  docker stats --no-stream --format '{{.MemUsage}}' "$P-c7-$1" | cut -d/ -f1
  docker rm -f "$P-c7-$1" >/dev/null
}
echo "INFO 7 idle-mem runc=$(mem runc)"
if [ $HAVE_RUNSC = 1 ]; then echo "INFO 7 idle-mem runsc=$(mem runsc)"; else skip "7 idle-mem runsc" "runsc not registered"; fi

[ $FAILS -eq 0 ] || { echo "$FAILS check(s) FAILED"; exit 1; }
echo "all checks passed or skipped"
