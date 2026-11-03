#!/usr/bin/env bash
# Prepare an Ubuntu 24.04 host to run sandboxd (spec 042 §8, §14). Idempotent: every step checks
# before it acts, so a second run changes nothing.
#
#   sudo bash host-setup.sh                      print the plan, change nothing, exit 2
#   sudo bash host-setup.sh --yes                do it
#
# Options
#   --yes                 required to format/mount anything, write daemon.json or restart docker
#   --force               replace a differing daemon.json (backed up first); move the data root even if
#                         the old one holds containers or volumes
#   --data-disk DEV       format DEV as XFS (pquota) and mount it at the Docker data root
#   --loop-size SIZE      no data disk: back the data root with a sparse XFS loop file of SIZE
#                         (default 40G, e.g. 60G); 0 = no quota at all (SANDBOXD_STORAGE_QUOTA=0)
#   --data-root DIR       where the XFS volume is mounted (default /var/lib/docker-sbx)
#   --swap-size SIZE      swapfile size (default 4G)
#   --skip-image          do not build forge/sandbox-base:1 at the end
#
# `--storage-opt size=` (per-sandbox disk quota) only works on XFS mounted with pquota, which is why
# the Docker data root lives on its own XFS volume. Move the data root on a FRESH host: images and
# containers already under /var/lib/docker are not migrated.
set -euo pipefail

YES=0 FORCE=0 DATA_DISK="" LOOP_SIZE=40G DATA_ROOT=/var/lib/docker-sbx SWAP_SIZE=4G BUILD_IMAGE=1
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOOP_IMG=/var/lib/sbx-xfs.img
DAEMON=/etc/docker/daemon.json
SANDBOXD_GID=3986 # group that may read /etc/sandboxd/api_key (compose group_add: worker, VPS overlay api)

while (($#)); do
  case "$1" in
    --yes) YES=1 ;;
    --force) FORCE=1 ;;
    --data-disk) DATA_DISK=${2:?--data-disk needs a device}; shift ;;
    --loop-size) LOOP_SIZE=${2:?--loop-size needs a size}; shift ;;
    --data-root) DATA_ROOT=${2:?--data-root needs a path}; shift ;;
    --swap-size) SWAP_SIZE=${2:?--swap-size needs a size}; shift ;;
    --skip-image) BUILD_IMAGE=0 ;;
    -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 64 ;;
  esac
  shift
done

say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---- the plan, always printed ------------------------------------------------------------------
if [[ -n "$DATA_DISK" ]]; then
  STORAGE="format $DATA_DISK as XFS and mount it at $DATA_ROOT (pquota)"
elif [[ "$LOOP_SIZE" != 0 ]]; then
  STORAGE="create a sparse $LOOP_SIZE XFS loop file $LOOP_IMG, mounted at $DATA_ROOT (loop,pquota,nofail in /etc/fstab)"
else
  STORAGE="no XFS volume: Docker keeps /var/lib/docker, per-sandbox disk quotas are OFF (set SANDBOXD_STORAGE_QUOTA=0)"
fi
DR_NOTE=""
[[ -n "$DATA_DISK" || "$LOOP_SIZE" != 0 ]] && DR_NOTE=" (+ data-root $DATA_ROOT)"
cat <<EOF
sandboxd host setup will:
  1. install Docker CE and gVisor (runsc) from their official apt repositories, if missing
  2. storage: $STORAGE
  3. write $DAEMON from infra/sandboxd/daemon.json$DR_NOTE, back up any existing file, RESTART docker
     (an existing $DAEMON with different content is only replaced with --force)
  4. create a $SWAP_SIZE /swapfile and set vm.swappiness=10
  5. create /var/lib/sandboxd (0700) and /etc/sandboxd/api_key (0640, group = dockremap subgid base + $SANDBOXD_GID, generated once),
     and /etc/sandboxd/capacity.header (0600, the key as a curl header file for the disk alert)
  6. $([[ $BUILD_IMAGE == 1 ]] && echo "docker build forge/sandbox-base:1" || echo "(skip) base image")
EOF
if ((!YES)); then
  echo
  echo "Nothing was changed. Re-run with --yes to apply." >&2
  exit 2
fi
[[ $EUID -eq 0 ]] || die "run as root (sudo)"
[[ -r /etc/os-release ]] && . /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] || say "warning: tested on Ubuntu 24.04, this is ${PRETTY_NAME:-unknown}"

# ---- the desired daemon.json, and the refusal to overwrite a different one -----------------------
# Checked before anything is formatted or mounted, so a refusal leaves the host untouched.
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg jq xfsprogs >/dev/null
USE_DATA_ROOT=0
[[ -n "$DATA_DISK" || "$LOOP_SIZE" != 0 ]] && USE_DATA_ROOT=1
want="$(mktemp)"
trap 'rm -f "$want"' EXIT
if ((USE_DATA_ROOT)); then
  jq -S --arg r "$DATA_ROOT" '. + {"data-root": $r}' "$REPO/infra/sandboxd/daemon.json" >"$want"
else
  jq -S . "$REPO/infra/sandboxd/daemon.json" >"$want"
fi
DAEMON_SAME=0
if [[ -e "$DAEMON" ]]; then
  if cmp -s <(jq -S . "$DAEMON" 2>/dev/null || cat "$DAEMON") "$want"; then
    DAEMON_SAME=1
  else
    ((FORCE)) || die "$DAEMON exists with different content; review it, or re-run with --force (it is backed up first)"
  fi
fi

# ---- 1. Docker CE + gVisor ---------------------------------------------------------------------
if ! command -v docker >/dev/null; then
  say "installing Docker CE"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing (apt install docker-compose-plugin)"
if ! command -v runsc >/dev/null; then
  say "installing gVisor"
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    >/etc/apt/sources.list.d/gvisor.list
  apt-get update -qq
  apt-get install -y -qq runsc >/dev/null
fi
# daemon.json names /usr/local/bin/runsc; the apt package installs /usr/bin/runsc.
[[ -e /usr/local/bin/runsc ]] || ln -s "$(command -v runsc)" /usr/local/bin/runsc

# ---- 2. XFS data volume ------------------------------------------------------------------------
# Moving the data root orphans whatever the old one holds: refuse unless the old one is empty.
if ((USE_DATA_ROOT && !DAEMON_SAME && !FORCE)); then
  cur="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
  if [[ -n "$cur" && "$cur" != "$DATA_ROOT" && "$cur" != "$DATA_ROOT"/* ]]     && [[ -n "$(docker ps -aq 2>/dev/null)$(docker volume ls -q 2>/dev/null)" ]]; then
    die "docker at $cur holds containers or volumes that would be orphaned by moving the data root to $DATA_ROOT; migrate or remove them, or re-run with --force"
  fi
fi
if [[ -n "$DATA_DISK" ]]; then
  [[ -b "$DATA_DISK" ]] || die "$DATA_DISK is not a block device"
  if ! mountpoint -q "$DATA_ROOT"; then
    if [[ "$(blkid -o value -s TYPE "$DATA_DISK" 2>/dev/null || true)" != xfs ]]; then
      [[ -z "$(blkid "$DATA_DISK" 2>/dev/null || true)" ]] || die "$DATA_DISK already holds a filesystem; wipe it yourself if that is intended"
      say "formatting $DATA_DISK as XFS"
      mkfs.xfs -q "$DATA_DISK"
    fi
    mkdir -p "$DATA_ROOT"
    uuid="$(blkid -o value -s UUID "$DATA_DISK")"
    grep -q "UUID=$uuid" /etc/fstab || echo "UUID=$uuid $DATA_ROOT xfs defaults,pquota,nofail 0 2" >>/etc/fstab
    mount "$DATA_ROOT"
  fi
elif [[ "$LOOP_SIZE" != 0 ]]; then
  if ! mountpoint -q "$DATA_ROOT"; then
    if [[ ! -e "$LOOP_IMG" ]]; then
      have="$(df --output=avail -B1 "$(dirname "$LOOP_IMG")" | tail -1 | tr -d ' ')"
      need="$(numfmt --from=iec "$LOOP_SIZE")"
      ((have >= need)) || die "$LOOP_SIZE requested for $LOOP_IMG but only $(numfmt --to=iec "$have") is free; pass a smaller --loop-size"
      say "creating sparse $LOOP_SIZE $LOOP_IMG"
      truncate -s "$LOOP_SIZE" "$LOOP_IMG"
      mkfs.xfs -q "$LOOP_IMG"
    fi
    mkdir -p "$DATA_ROOT"
    grep -q "^$LOOP_IMG " /etc/fstab || echo "$LOOP_IMG $DATA_ROOT xfs loop,pquota,nofail 0 0" >>/etc/fstab
    mount "$DATA_ROOT"
  fi
fi
if ((USE_DATA_ROOT)); then
  findmnt -no OPTIONS "$DATA_ROOT" | grep -Eq '(^|,)(pquota|prjquota)(,|$)' || die "$DATA_ROOT is not mounted with pquota"
fi

# ---- 3. daemon.json ----------------------------------------------------------------------------
# dockerd must never start on an unmounted data root (it would silently fill the root disk).
if ((USE_DATA_ROOT)); then
  dropin=/etc/systemd/system/docker.service.d/sandboxd.conf
  install -d /etc/systemd/system/docker.service.d
  printf '[Unit]\nRequiresMountsFor=%s\n' "$DATA_ROOT" >"$dropin.new"
  if ! cmp -s "$dropin.new" "$dropin" 2>/dev/null; then
    mv -f "$dropin.new" "$dropin"
    systemctl daemon-reload
  else
    rm -f "$dropin.new"
  fi
fi
if ((DAEMON_SAME)); then
  say "$DAEMON already up to date"
else
  if [[ -e "$DAEMON" ]]; then
    backup="$DAEMON.bak.$(date +%Y%m%d%H%M%S)"
    cp -a "$DAEMON" "$backup"
    say "backed up the old $DAEMON to $backup"
  fi
  install -m 0644 "$want" "$DAEMON"
  say "restarting docker"
  systemctl restart docker
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker info --format '{{.Runtimes}}' | grep -q runsc || die "docker does not list the runsc runtime"

# ---- 4. swap -----------------------------------------------------------------------------------
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  if [[ ! -e /swapfile ]]; then
    say "creating $SWAP_SIZE /swapfile"
    fallocate -l "$SWAP_SIZE" /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
echo 'vm.swappiness=10' >/etc/sysctl.d/99-sandboxd.conf
sysctl -q -p /etc/sysctl.d/99-sandboxd.conf

# ---- 5. sandboxd state and key -----------------------------------------------------------------
install -d -m 0700 /var/lib/sandboxd
install -d -m 0755 /etc/sandboxd
# dockerd's remap: container gid N is host gid <dockremap subgid base> + N (created when dockerd
# started with userns-remap above).
sub_base="$(awk -F: '$1 == "dockremap" { print $2; exit }' /etc/subgid)"
[[ -n "$sub_base" ]] || die "no dockremap entry in /etc/subgid; did docker start with userns-remap?"
KEY_GID=$((sub_base + SANDBOXD_GID))
if [[ ! -s /etc/sandboxd/api_key ]]; then
  say "generating /etc/sandboxd/api_key"
  (umask 077 && openssl rand -hex 32 >/etc/sandboxd/api_key)
fi
# 0640 rather than 0600: the worker container (non-root, remapped) reads it through the
# supplementary gid 3986 compose gives it, which the host sees as $KEY_GID; sandboxd is real root.
chown root:"$KEY_GID" /etc/sandboxd/api_key
chmod 0640 /etc/sandboxd/api_key
# For `curl -H @file` (README disk alert): the key never appears in a process's argv.
(umask 077 && printf 'authorization: Bearer %s\n' "$(cat /etc/sandboxd/api_key)" >/etc/sandboxd/capacity.header)

# ---- 6. base image -----------------------------------------------------------------------------
if ((BUILD_IMAGE)); then
  say "building forge/sandbox-base:1"
  docker build -t forge/sandbox-base:1 "$REPO/infra/sandboxd/images/base"
fi

say "done. Next: set SANDBOXD_API_HOST (and SANDBOXD_DOCKER_ROOT=$DATA_ROOT) and 'docker compose up -d --build'. See infra/sandboxd/README.md."
