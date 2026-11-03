#!/usr/bin/env bash
# Deploy the single-VPS stack (compose.vps.yaml) from a release directory, with health checks, a
# local smoke test and an automatic rollback. Installed as /usr/local/bin/kido-deploy (every
# successful deploy re-installs it from the release it deployed). Run as root.
#
#   kido-deploy receive ID                      stdin: tar.gz of a release (compose.yaml,
#                                               compose.vps.yaml, infra/, apps/web/dist/, release.env)
#   kido-deploy deploy ID [--registry-user U]   deploy releases/ID; with --registry-user, stdin is a
#                                               GHCR pull token (docker login, pull, docker logout)
#   kido-deploy build SRC [ID]                  build the images and the web app from the source tree
#                                               SRC on this host (no registry), then deploy them
#   kido-deploy rollback                        deploy the previous release again
#
# Layout (KIDO_ROOT, default /opt/kido): kido.env (0600: secrets and host config, never shipped by
# CI), releases/<ID>/ (one per deploy; release.env pins the image refs, no secrets), current and
# previous (symlinks). The compose project is `kido`; the project directory is the release
# directory, so every deploy recreates Caddy on that release's Caddyfile and web build.
#
# As an authorized_keys `command=` it reads its arguments from SSH_ORIGINAL_COMMAND
# (infra/sandboxd/README.md, "Automatic deploys").
set -euo pipefail

ROOT=${KIDO_ROOT:-/opt/kido}
ENV_FILE=$ROOT/kido.env
RELEASES=$ROOT/releases
PROJECT=kido
KEEP=5
SERVICES=(postgres redis-session redis-cache redis-queue redis-stream api worker sandboxd gateway caddy)

if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  read -r -a argv <<<"$SSH_ORIGINAL_COMMAND"
  [[ "${argv[0]##*/}" == kido-deploy ]] && argv=("${argv[@]:1}")
  set -- "${argv[@]}"
fi

say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
valid_id() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] || die "bad release id '$1'"; }
envval() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | tr -d "'\""; }

dc() {
  local d=$1
  shift
  docker compose -p "$PROJECT" --project-directory "$d" -f "$d/compose.yaml" -f "$d/compose.vps.yaml" \
    --env-file "$ENV_FILE" --env-file "$d/release.env" "$@"
}

# Every long-running service healthy (each has a healthcheck), or report which are not.
wait_healthy() {
  local end=$((SECONDS + ${KIDO_HEALTH_TIMEOUT:-300})) ps bad s
  while :; do
    ps="$(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" \
      --format '{{.Label "com.docker.compose.service"}} {{.Status}}')"
    bad=""
    for s in "${SERVICES[@]}"; do
      grep -q "^$s Up .*(healthy)" <<<"$ps" || bad+=" $s"
    done
    [[ -z $bad ]] && return 0
    ((SECONDS < end)) || {
      printf 'not healthy:%s\n%s\n' "$bad" "$ps" >&2
      return 1
    }
    sleep 5
  done
}

# sandboxd with its firewall, then the app and the API through Caddy as a browser reaches them.
smoke() {
  local host end=$((SECONDS + 90)) why
  host="$(envval APP_HOST)"
  while :; do
    why=""
    curl -fsS --max-time 5 http://172.30.2.1:3986/healthz |
      jq -e '.ok == true and .firewall == true and .docker == true' >/dev/null || why="sandboxd /healthz"
    curl -fsSk --max-time 10 --resolve "$host:443:127.0.0.1" "https://$host/api/v1/health" >/dev/null ||
      why+=" api /api/v1/health via caddy"
    curl -fsSk --max-time 10 --resolve "$host:443:127.0.0.1" "https://$host/" | grep -q '<div id="root">' ||
      why+=" web app via caddy"
    [[ -z $why ]] && break
    ((SECONDS < end)) || {
      echo "smoke test failed:$why" >&2
      return 1
    }
    sleep 5
  done
  # A certificate problem is not fixed by rolling back, so it warns instead of failing.
  curl -fsS -o /dev/null --max-time 10 --resolve "$host:443:127.0.0.1" "https://$host/" ||
    echo "warning: https://$host does not present a valid certificate yet (see caddy's log)" >&2
  say "smoke test passed for https://$host"
}

activate() {
  local d=$1
  say "migrating ($(basename "$d"))"
  dc "$d" run --rm -T migrate </dev/null || return 1
  say "starting ($(basename "$d"))"
  dc "$d" up -d --no-build --remove-orphans </dev/null || return 1
  wait_healthy && smoke
}

# Keep the newest KEEP releases plus current and previous; drop the others and their images.
prune() {
  local cur prv r keep
  cur="$(readlink -f "$ROOT/current")"
  prv="$(readlink -f "$ROOT/previous" 2>/dev/null || true)"
  keep="$(cat "$cur/release.env" "${prv:-/dev/null}/release.env" 2>/dev/null || true)"
  while read -r r; do
    r=${r%/}
    [[ -z $r || $r == "$cur" || $r == "$prv" ]] && continue
    sed -n 's/^FORGE_[A-Z]*_IMAGE=//p' "$r/release.env" 2>/dev/null | while read -r img; do
      grep -qF "=$img" <<<"$keep" || docker image rm "$img" >/dev/null 2>&1 || true
    done
    rm -rf -- "$r"
  done < <(ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +$((KEEP + 1)))
}

cmd_receive() {
  local id=${1:?release id}
  valid_id "$id"
  local d=$RELEASES/$id
  [[ -e $d ]] && die "$d already exists"
  rm -rf -- "$d.partial"
  mkdir -p "$d.partial"
  tar -xzf - -C "$d.partial" --no-same-owner
  mv -T "$d.partial" "$d"
  say "received $d"
}

cmd_deploy() {
  local id=${1:?release id} user="" prev=""
  shift
  valid_id "$id"
  while (($#)); do
    case $1 in
      --registry-user) user=${2:?--registry-user needs a name}; shift ;;
      *) die "unknown option $1" ;;
    esac
    shift
  done
  local d=$RELEASES/$id
  [[ -f $d/release.env && -f $d/compose.vps.yaml && -f $d/apps/web/dist/index.html ]] ||
    die "$d is not a complete release"
  [[ -f $ENV_FILE && "$(stat -c %a "$ENV_FILE")" == 600 ]] || die "$ENV_FILE must exist with mode 0600"
  exec 9>"$ROOT/.deploy.lock"
  flock -n 9 || die "another deploy is running"
  [[ -e $ROOT/current ]] && prev="$(basename "$(readlink -f "$ROOT/current")")"

  if [[ -n $user ]]; then
    # The token arrives on stdin only: never in argv, the environment or a file we write.
    trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
    docker login ghcr.io -u "$user" --password-stdin >/dev/null
    say "pulling $id"
    dc "$d" pull --quiet api gateway sandboxd </dev/null
    docker logout ghcr.io >/dev/null
  fi

  if activate "$d"; then
    [[ -n $prev && $prev != "$id" ]] && ln -sfn "$RELEASES/$prev" "$ROOT/previous"
    ln -sfn "$d" "$ROOT/current"
    install -m 0755 "$d/infra/sandboxd/deploy-vps.sh" /usr/local/bin/kido-deploy
    prune
    say "deployed $id"
    return 0
  fi
  if [[ -n $prev && $prev != "$id" ]]; then
    say "deploy of $id FAILED; rolling back to $prev"
    activate "$RELEASES/$prev" || die "deploy of $id failed and the rollback to $prev failed too"
    die "deploy of $id failed; rolled back to $prev (migrations it applied stay applied)"
  fi
  die "deploy of $id failed (no previous release to roll back to)"
}

cmd_build() {
  local src id
  src="$(cd "${1:?source tree}" && pwd)"
  id=${2:-local-$(date -u +%Y%m%d%H%M%S)}
  valid_id "$id"
  say "building forge-app, forge-gateway, forge-sandboxd :$id from $src"
  FORGE_APP_IMAGE=forge-app:$id FORGE_GATEWAY_IMAGE=forge-gateway:$id FORGE_SANDBOXD_IMAGE=forge-sandboxd:$id \
    docker compose -p "$PROJECT" --project-directory "$src" -f "$src/compose.yaml" -f "$src/compose.vps.yaml" \
    --env-file "$ENV_FILE" build api gateway sandboxd
  say "building the web app"
  # --userns=host: under userns-remap a container's root cannot write the root-owned checkout.
  docker run --rm --userns=host -v "$src":/repo -w /repo node:24-bookworm-slim sh -c \
    'corepack enable && CI=1 pnpm install --frozen-lockfile && pnpm --filter "@repo/web..." build'
  local d=$RELEASES/$id
  rm -rf -- "$d.partial"
  mkdir -p "$d.partial"
  (cd "$src" && tar -cf - compose.yaml compose.vps.yaml infra apps/web/dist) | tar -xf - -C "$d.partial"
  printf 'FORGE_APP_IMAGE=forge-app:%s\nFORGE_GATEWAY_IMAGE=forge-gateway:%s\nFORGE_SANDBOXD_IMAGE=forge-sandboxd:%s\n' \
    "$id" "$id" "$id" >"$d.partial/release.env"
  mv -T "$d.partial" "$d"
  cmd_deploy "$id"
}

cmd_rollback() {
  [[ -e $ROOT/previous ]] || die "no previous release"
  cmd_deploy "$(basename "$(readlink -f "$ROOT/previous")")"
}

[[ $EUID -eq 0 ]] || die "run as root"
mkdir -p "$RELEASES"
case "${1:-}" in
  receive) shift; cmd_receive "$@" ;;
  deploy) shift; cmd_deploy "$@" ;;
  build) shift; cmd_build "$@" ;;
  rollback) shift; cmd_rollback ;;
  *) sed -n '2,20p' "$0"; exit 64 ;;
esac
