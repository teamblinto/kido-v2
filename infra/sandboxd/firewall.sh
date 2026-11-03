#!/usr/bin/env bash
# Host firewall for the sandbox bridges. Usage: firewall.sh apply|check|remove
#
# Owns only chains SBX-FWD (jumped from DOCKER-USER, forwarded traffic) and SBX-IN (jumped from
# INPUT, traffic to the host itself). Every jump matches ONLY src/dst inside $SBX_ALL, so other
# traffic is never touched. Never flushes built-in or Docker chains, never changes policies.
# IPv6: sandboxes get none; belt and braces, drop everything forwarded from/to their bridges and
# everything they send to the host.
set -euo pipefail

SBX_AGENT_NET=${SBX_AGENT_NET:-172.30.0.0/24}
SBX_PROJ_NET=${SBX_PROJ_NET:-172.30.1.0/24}
SBX_ALL=${SBX_ALL:-172.30.0.0/23}
SBX_AGENT_IF=${SBX_AGENT_IF:-sbx-agent0}
SBX_PROJ_IF=${SBX_PROJ_IF:-sbx-proj0}
SBX_AGENT_GW=${SBX_AGENT_GW:-172.30.0.1}
SBX_EGRESS_PORT=${SBX_EGRESS_PORT:-3988}
SBX_HOST_ALLOW_TCP=${SBX_HOST_ALLOW_TCP:-443} # sbx-proj -> host (Caddy: callback/API), comma list
SNAP=${SBX_SNAPSHOT:-/run/sbx-firewall.snapshot}

DENY="0.0.0.0/8 240.0.0.0/4 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 127.0.0.0/8 224.0.0.0/4 $SBX_AGENT_NET $SBX_PROJ_NET"

ipt4() { iptables -w 5 "$@"; }
ipt6() { ip6tables -w 5 "$@"; }
have6() { command -v ip6tables >/dev/null 2>&1 && ipt6 -S >/dev/null 2>&1; }

# at <ipt> <chain> <pos> <rule...>: succeeds if the rule is exactly rule number <pos> of <chain>
at() {
  local ipt=$1 ch=$2 pos=$3
  shift 3
  [ "$($ipt -S "$ch" | grep '^-A' | sed -n "${pos}p")" = "-A $ch $*" ]
}
# pin: put the rule at <pos> (inserting it, then dropping a stale copy further down) unless there
pin() {
  local ipt=$1 ch=$2 pos=$3 n
  shift 3
  at "$ipt" "$ch" "$pos" "$@" && return 0
  $ipt -I "$ch" "$pos" "$@"
  n=$($ipt -S "$ch" | grep '^-A' | grep -nxF -e "-A $ch $*" | cut -d: -f1 | sed -n 2p)
  if [ -n "$n" ]; then $ipt -D "$ch" "$n"; fi
}
# unpin: delete every copy of the rule
unpin() {
  local ipt=$1 ch=$2
  shift 3
  while $ipt -C "$ch" "$@" 2>/dev/null; do $ipt -D "$ch" "$@"; done
}

# pins <pin|at|unpin>: every rule apply puts in a built-in/Docker chain, with its position
pins() {
  local f=$1 n=1 i d
  $f ipt4 DOCKER-USER 1 -s "$SBX_ALL" -j SBX-FWD || return 1
  $f ipt4 DOCKER-USER 2 -d "$SBX_ALL" -j SBX-FWD || return 1
  $f ipt4 INPUT 1 -s "$SBX_ALL" -j SBX-IN || return 1
  have6 || return 0
  for i in "$SBX_AGENT_IF" "$SBX_PROJ_IF"; do
    $f ipt6 INPUT "$n" -i "$i" -j DROP || return 1
    n=$((n + 1))
  done
  n=1
  for i in "$SBX_AGENT_IF" "$SBX_PROJ_IF"; do
    for d in -i -o; do
      $f ipt6 FORWARD "$n" "$d" "$i" -j SBX-FWD6 || return 1
      n=$((n + 1))
    done
  done
}

rules() {
  # --noflush + ":CHAIN -" resets just these chains, atomically (no unfiltered window on re-apply)
  cat <<EOF
*filter
:SBX-FWD - [0:0]
:SBX-IN - [0:0]
-A SBX-FWD -s $SBX_AGENT_NET -j DROP
-A SBX-FWD -d $SBX_AGENT_NET -j DROP
-A SBX-FWD -s $SBX_PROJ_NET -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A SBX-FWD -d $SBX_PROJ_NET -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A SBX-FWD -d $SBX_PROJ_NET -j DROP
EOF
  for n in $DENY; do echo "-A SBX-FWD -s $SBX_PROJ_NET -d $n -j DROP"; done
  cat <<EOF
-A SBX-FWD -s $SBX_PROJ_NET -p tcp -m multiport --dports 25,465,587 -j DROP
-A SBX-FWD -s $SBX_PROJ_NET -m conntrack --ctstate NEW -m hashlimit --hashlimit-name sbx-proj --hashlimit-mode srcip --hashlimit-above 20/second --hashlimit-burst 50 -j DROP
-A SBX-FWD -s $SBX_PROJ_NET -j ACCEPT
-A SBX-IN -s $SBX_ALL -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A SBX-IN -i $SBX_AGENT_IF -s $SBX_AGENT_NET -d $SBX_AGENT_GW -p tcp --dport $SBX_EGRESS_PORT -j ACCEPT
-A SBX-IN -i $SBX_PROJ_IF -s $SBX_PROJ_NET -p tcp -m multiport --dports $SBX_HOST_ALLOW_TCP -j ACCEPT
-A SBX-IN -s $SBX_ALL -j DROP
COMMIT
EOF
}

# What the kernel holds for everything apply owns; apply stores it, check compares against it.
snapshot() {
  ipt4 -S SBX-FWD
  ipt4 -S SBX-IN
  if have6; then ipt6 -S SBX-FWD6; fi
}

apply() {
  ipt4 -S DOCKER-USER >/dev/null 2>&1 || { echo "DOCKER-USER chain missing (is dockerd running?)" >&2; exit 1; }
  rules | iptables-restore -w 5 --noflush
  if have6; then
    ipt6 -N SBX-FWD6 2>/dev/null || true
    ipt6 -F SBX-FWD6
    ipt6 -A SBX-FWD6 -j DROP
  fi
  pins pin
  snapshot >"$SNAP"
}

# Exact comparison with what apply left: a flushed or edited chain, or a foreign rule above one of
# our jumps (they must stay first), fails. No snapshot (after reboot or remove) also fails.
check() {
  [ -s "$SNAP" ] && [ "$(snapshot)" = "$(cat "$SNAP")" ] && pins at
}

remove() {
  pins unpin
  for c in SBX-FWD SBX-IN; do { ipt4 -F "$c" && ipt4 -X "$c"; } 2>/dev/null || true; done
  if have6; then { ipt6 -F SBX-FWD6 && ipt6 -X SBX-FWD6; } 2>/dev/null || true; fi
  rm -f "$SNAP"
}

case "${1:-}" in
  apply) apply ;;
  check) check >/dev/null 2>&1 ;;
  remove) remove ;;
  *) echo "usage: $0 apply|check|remove" >&2; exit 2 ;;
esac
