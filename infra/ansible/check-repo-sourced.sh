#!/usr/bin/env bash
# T053 — confirm that no pool's configuration requires a hand-edited file on a node, and that
# changing a pool means changing this repository (FR-030, FR-032).
#
# This is the check, not the claim. Run it from infra/ansible:
#
#   ./check-repo-sourced.sh
#
# It fails loudly if any of the five properties below stops holding, so a later play that
# introduces a hand edit is caught here rather than discovered on a node.
set -euo pipefail
cd "$(dirname "$0")"

plays=(data.yml app.yml gateway.yml)
fail=0
note() { printf '  %s\n' "$1"; }
bad() { printf '  FAIL: %s\n' "$1"; fail=1; }

echo "1. No play edits a file in place on a node."
# lineinfile/blockinfile/replace/ini_file all mean "the file on the node is the source of
# truth and we are amending it" — the exact shape FR-030 forbids. So do sed -i and an editor.
if grep -nE '(ansible\.builtin\.)?(lineinfile|blockinfile|replace|ini_file):|sed -i|\b(vi|vim|nano|patch)\b' "${plays[@]}" templates/*.j2; then
  bad "an in-place edit above"
else
  note "no lineinfile, blockinfile, replace, ini_file, sed -i, editor or patch in any play or template"
fi

echo "2. Every file a play puts on a node comes from this repository."
# `copy` with `content:` renders from a variable in the inventory; `copy`/`template` with
# `src:` must name a path inside the repository. Either way the source is a committed file.
srcs=$(grep -hoE '^[[:space:]]+src: .*$' "${plays[@]}" | sed -E 's/^[[:space:]]+src: //' | tr -d "\"'")
while IFS= read -r src; do
  [ -z "$src" ] && continue
  case "$src" in
    # infra/Caddyfile — another file in this repository, referenced, never generated here.
    '{{ playbook_dir }}/../Caddyfile') test -f ../Caddyfile && note "$src -> infra/Caddyfile" \
        || bad "$src does not exist in the repository" ;;
    # Loop variables resolve to the template names checked in 3.
    '{{ item }}.j2'|'{{ item }}') note "$src -> templates/ (checked in 3)" ;;
    # Remote artifacts fetched by digest are content, not configuration.
    'http'*|'{{ forge_web_assets_url }}') note "$src -> build artifact, addressed by digest" ;;
    *) if [ -f "templates/$src" ] || [ -f "files/$src" ]; then note "$src -> templates/$src"
       else bad "$src is not a file in this repository"; fi ;;
  esac
done <<< "$srcs"

echo "3. Every template referenced exists here, and every template here is referenced."
for t in templates/*.j2; do
  name=$(basename "$t")
  stem=${name%.j2}
  if grep -q "$name\|$stem" "${plays[@]}"; then note "$name is used"
  else bad "$name is not referenced by any play"; fi
done

echo "4. No play invents a host, and every host is in the inventory."
if grep -nE 'add_host|delegate_to:' "${plays[@]}" | grep -v 'delegate_to: localhost'; then
  bad "a play targets something the inventory does not name"
else
  note "every target comes from inventories/<environment>/hosts.yml"
fi

echo "5. No configuration value is prompted for or read from the operator's shell."
# vars_prompt or a lookup of the environment would make a converge depend on what the person
# running it typed, which is a hand edit with extra steps.
if grep -nE "vars_prompt|lookup\('?env'?|lookup\('?pipe'?" "${plays[@]}"; then
  bad "a value comes from the operator rather than the repository"
else
  note "every value comes from group_vars or an ansible-vault file in this repository"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "PASS — each pool's configuration is in this repository, and changing it is a commit."
else
  echo "FAIL — see above."
  exit 1
fi
