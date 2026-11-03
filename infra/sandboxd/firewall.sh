#!/usr/bin/env bash
# Host firewall for the sandbox bridges. Usage: firewall.sh apply|check|remove
#
# Owns only chains SBX-FWD (jumped from DOCKER-USER, forwarded traffic) and SBX-IN (jumped from
# INPUT, traffic to the host itself). Every jump matches ONLY src/dst inside $SBX_ALL, so other
# traffic is never touched. Never flushes built-in or Docker chains, never changes policies.
# IPv6: sandboxes get none; belt and braces, drop everything forwarded from/to their bridges.
set -euo pipefail

SBX_AGENT_NET=${SBX_AGENT_NET:-172.30.0.0/24}
SBX_PROJ_NET=${SBX_PROJ_NET:-172.30.1.0/24}
SBX_ALL=${SBX_ALL:-172.30.0.0/23}
SBX_AGENT_IF=${SBX_AGENT_IF:-sbx-agent0}
SBX_PROJ_IF=${SBX_PROJ_IF:-sbx-proj0}
SBX_AGENT_GW=${SBX_AGENT_GW:-172.30.0.1}
SBX_EGRESS_PORT=${SBX_EGRESS_PORT:-3988}
SBX_HOST_ALLOW_TCP=${SBX_HOST_ALLOW_TCP:-443} # sbx-proj -> host (Caddy: callback/API), comma list

IPT="iptables -w"
DENY="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 127.0.0.0/8 224.0.0.0/4 $SBX_AGENT_NET $SBX_PROJ_NET"

have6() { command -v ip6tables >/dev/null 2>&1 && ip6tables -w -S >/dev/null 2>&1; }

# jump <chain-from> <chain-to> <match...>: add the jump at the top unless present
jump() { local t=$1 c=$2; shift 2; $IPT -C "$t" "$@" -j "$c" 2>/dev/null || $IPT -I "$t" 1 "$@" -j "$c"; }
unjump() { local t=$1 c=$2; shift 2; while $IPT -C "$t" "$@" -j "$c" 2>/dev/null; do $IPT -D "$t" "$@" -j "$c"; done; }

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

apply() {
  $IPT -S DOCKER-USER >/dev/null 2>&1 || { echo "DOCKER-USER chain missing (is dockerd running?)" >&2; exit 1; }
  rules | iptables-restore -w --noflush
  jump DOCKER-USER SBX-FWD -d "$SBX_ALL"
  jump DOCKER-USER SBX-FWD -s "$SBX_ALL"
  jump INPUT SBX-IN -s "$SBX_ALL"
  if have6; then
    ip6tables -w -N SBX-FWD6 2>/dev/null || true
    ip6tables -w -F SBX-FWD6
    ip6tables -w -A SBX-FWD6 -j DROP
    for i in "$SBX_AGENT_IF" "$SBX_PROJ_IF"; do
      for d in -i -o; do
        ip6tables -w -C FORWARD "$d" "$i" -j SBX-FWD6 2>/dev/null || ip6tables -w -I FORWARD 1 "$d" "$i" -j SBX-FWD6
      done
    done
  fi
}

check() {
  $IPT -C DOCKER-USER -s "$SBX_ALL" -j SBX-FWD && $IPT -C DOCKER-USER -d "$SBX_ALL" -j SBX-FWD &&
    $IPT -C INPUT -s "$SBX_ALL" -j SBX-IN &&
    $IPT -C SBX-FWD -s "$SBX_PROJ_NET" -j ACCEPT && $IPT -C SBX-IN -s "$SBX_ALL" -j DROP || return 1
  if have6; then ip6tables -w -C FORWARD -i "$SBX_PROJ_IF" -j SBX-FWD6 && ip6tables -w -C SBX-FWD6 -j DROP || return 1; fi
}

remove() {
  unjump DOCKER-USER SBX-FWD -d "$SBX_ALL"
  unjump DOCKER-USER SBX-FWD -s "$SBX_ALL"
  unjump INPUT SBX-IN -s "$SBX_ALL"
  for c in SBX-FWD SBX-IN; do $IPT -F "$c" 2>/dev/null && $IPT -X "$c" || true; done
  if have6; then
    for i in "$SBX_AGENT_IF" "$SBX_PROJ_IF"; do
      for d in -i -o; do
        while ip6tables -w -C FORWARD "$d" "$i" -j SBX-FWD6 2>/dev/null; do ip6tables -w -D FORWARD "$d" "$i" -j SBX-FWD6; done
      done
    done
    ip6tables -w -F SBX-FWD6 2>/dev/null && ip6tables -w -X SBX-FWD6 || true
  fi
}

case "${1:-}" in
  apply) apply ;;
  check) check >/dev/null 2>&1 ;;
  remove) remove ;;
  *) echo "usage: $0 apply|check|remove" >&2; exit 2 ;;
esac
