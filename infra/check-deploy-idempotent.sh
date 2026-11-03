#!/usr/bin/env bash
# T041 — confirm `infra/deploy.sh` run twice for the same digest lands the same state (SC-011).
#
# This is the check, not the claim. Run it from infra/:
#
#   ./check-deploy-idempotent.sh
#
# There is no bats in this repository and no vitest harness that drives shell, so this follows the
# idiom `infra/ansible/check-repo-sourced.sh` already set: a self-contained bash check that names
# each property, proves it, and fails loudly.
#
# Idempotence is proved the only way it can be without a daemon and a database: the deploy is run
# twice against stubbed `cosign`, `docker` and `curl` that record every invocation, and the two
# runs must issue byte-for-byte the same sequence of commands and render byte-for-byte the same
# environment. A second run that did something different from the first is the failure SC-011 is
# about; a second run that issues the same statements about the same digest lands the same state.
#
# `docker compose config` is NOT stubbed — it needs no daemon, so the real render, the real digest
# pin check and the real FR-031 assertion all execute here.
#
# What this cannot prove: that `docker compose up` and the migration are themselves idempotent
# against a real host. That is quickstart Walk 4.
set -euo pipefail
cd "$(dirname "$0")"

DIGEST="sha256:$(printf 'a%.0s' $(seq 1 64))"
OTHER="sha256:$(printf 'b%.0s' $(seq 1 64))"
WORK="$(mktemp -d -t forge-deploy-check-XXXXXX)"
trap 'rm -rf "${WORK}"' EXIT

fail=0
note() { printf '  %s\n' "$1"; }
bad() {
  printf '  FAIL: %s\n' "$1"
  fail=1
}

# --- the stubs --------------------------------------------------------------------------------
#
# Each one appends what it was called with to ${TRACE} and then answers the way the real tool would
# on a healthy host, so the deploy runs all five steps to completion.
mkdir -p "${WORK}/bin"

cat >"${WORK}/bin/cosign" <<'STUB'
#!/usr/bin/env bash
printf 'cosign %s\n' "$*" >>"${TRACE}"
exit 0
STUB

cat >"${WORK}/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"${TRACE}"
real="$(PATH=/usr/bin:/bin:/usr/local/bin command -v docker)"

if [[ "${1:-}" == 'compose' ]]; then
  for arg in "$@"; do
    case "${arg}" in
      config)
        # Not stubbed: the render needs no daemon, so the real one runs and the deploy's own
        # pin check and FR-031 assertion are exercised against real compose output.
        exec "${real}" "$@"
        ;;
      run) exit 0 ;;
      up) exit 0 ;;
      ps)
        printf 'container-id-for-api\n'
        exit 0
        ;;
    esac
  done
  exit 0
fi

if [[ "${1:-}" == 'inspect' ]]; then
  printf '%s %s\n' "${FORGE_STUB_DIGEST}" "ghcr.io/teamblinto/forge-app@${FORGE_STUB_DIGEST}"
  exit 0
fi
exit 0
STUB

cat >"${WORK}/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"${TRACE}"
for arg in "$@"; do
  case "${arg}" in
    */api/v1/health) exit 0 ;;
    */api/v1/version)
      printf '{"digest":"%s"}\n' "${FORGE_STUB_DIGEST}"
      exit 0
      ;;
  esac
done
exit 0
STUB

chmod +x "${WORK}/bin/"*

# A trace with the run-specific temp env file path folded away, so two runs are comparable.
run_deploy() {
  local label="$1" digest="$2" root="${3:-..}" out
  out="${WORK}/${label}"
  mkdir -p "${out}"

  TRACE="${out}/trace" FORGE_STUB_DIGEST="${digest}" \
    PATH="${WORK}/bin:${PATH}" \
    bash "${root}/infra/deploy.sh" staging "${digest}" >"${out}/stdout" 2>"${out}/stderr" &&
    printf '0' >"${out}/status" || printf '%s' "$?" >"${out}/status"

  sed -E 's#/[^ ]*forge-deploy-staging-[A-Za-z0-9]+\.env#ENV_FILE#g' \
    "${out}/trace" >"${out}/trace.normalised" 2>/dev/null || true
}

echo '1. The deploy runs to completion against stubbed tools.'
run_deploy first "${DIGEST}"
if [ "$(cat "${WORK}/first/status")" = '0' ]; then
  note 'exit 0, all five steps'
else
  bad "the first run exited $(cat "${WORK}/first/status"): $(tail -n 3 "${WORK}/first/stderr")"
fi

echo '2. The steps happen in the order the script promises.'
# Verification first (FR-005), the migration after the render and before the start (FR-028).
order="$(sed -n 's/^\(cosign\) verify.*/verify/p;s/^docker compose .*config.*/render/p;s/^docker compose .*run .*/migrate/p;s/^docker compose .*up .*/start/p' "${WORK}/first/trace" | awk '!seen[$0]++' | paste -sd, -)"
if [ "${order}" = 'verify,render,migrate,start' ]; then
  note "${order}"
else
  bad "the order was '${order}', not verify,render,migrate,start"
fi

echo '3. A second run for the same digest issues exactly the same commands.'
run_deploy second "${DIGEST}"
if diff -u "${WORK}/first/trace.normalised" "${WORK}/second/trace.normalised" >"${WORK}/trace.diff"; then
  note "$(wc -l <"${WORK}/first/trace.normalised" | tr -d ' ') identical invocations, in the same order"
else
  bad "the two runs differ:"
  sed 's/^/    /' "${WORK}/trace.diff"
fi

echo '4. Both runs report the same result.'
if [ "$(cat "${WORK}/first/status")" = "$(cat "${WORK}/second/status")" ] &&
  diff -q "${WORK}/first/stdout" "${WORK}/second/stdout" >/dev/null; then
  note 'same exit status and the same [deploy] log, line for line'
else
  bad 'the second run reported something the first did not'
fi

echo '5. A different digest produces a different deploy — the check above is not vacuous.'
run_deploy other "${OTHER}"
if diff -q "${WORK}/first/trace.normalised" "${WORK}/other/trace.normalised" >/dev/null; then
  bad 'a deploy of another digest issued the same commands, so the comparison proves nothing'
else
  note 'a deploy of another digest differs, so runs 1 and 2 matching is a fact about the digest'
fi

echo '6. The migration runs on the new digest, under the lock, with both timeouts.'
migrate_line="$(grep -m1 'compose .* run ' "${WORK}/first/trace" || true)"
for expected in '--rm' '--no-deps' 'FORGE_MIGRATION_LOCK_KEY=7301025' \
  'FORGE_MIGRATION_LOCK_TIMEOUT=' 'FORGE_MIGRATION_STATEMENT_TIMEOUT=' \
  "--file $(pwd)/compose.staging.yaml"; do
  case "${migrate_line}" in
    *"${expected}"*) note "one-shot container carries ${expected}" ;;
    *) bad "the migration invocation is missing ${expected}: ${migrate_line}" ;;
  esac
done
# The image is never named on the command line: it comes from the rendered compose file, which
# pins the digest — the artifact, not this checkout (research R8).
case "${migrate_line}" in
  *' api node --input-type=module'*) note 'it runs the api service, so the image is the rendered digest' ;;
  *) bad "the migration does not run on the api service: ${migrate_line}" ;;
esac

echo '7. The gateway reads sites with a key that is not the API'"'"'s write key (spec 027 T096).'
# The same key id on both sides means the gateway holds a key that can write, overwrite or delete
# every published site. Compose reads both from the deploy's own environment, so they are set here.
OBJECT_STORE_ACCESS_KEY_ID='AKIDSAMEFORBOTH' ARTIFACT_STORE_ACCESS_KEY_ID='AKIDSAMEFORBOTH' \
  run_deploy same-artifact-key "${DIGEST}"
if [ "$(cat "${WORK}/same-artifact-key/status")" != '0' ] &&
  grep -q 'ARTIFACT_STORE_ACCESS_KEY_ID' "${WORK}/same-artifact-key/stderr" &&
  ! grep -q 'compose .* run ' "${WORK}/same-artifact-key/trace"; then
  note 'one key id on both sides is refused at the render, before the migration'
else
  bad "a gateway read key equal to the API's write key was not refused at the render: $(tail -n 2 "${WORK}/same-artifact-key/stderr")"
fi
OBJECT_STORE_ACCESS_KEY_ID='AKIDAPIWRITEKEY' ARTIFACT_STORE_ACCESS_KEY_ID='AKIDGATEWAYREAD' \
  run_deploy distinct-artifact-keys "${DIGEST}"
if [ "$(cat "${WORK}/distinct-artifact-keys/status")" = '0' ] &&
  grep -q 'differs from the api' "${WORK}/distinct-artifact-keys/stdout"; then
  note 'two distinct key ids deploy, so the refusal above is not vacuous'
else
  bad "two distinct key ids did not deploy: $(tail -n 2 "${WORK}/distinct-artifact-keys/stderr")"
fi

echo '8. The API'"'"'s object-store variables never reach the gateway by name (spec 027 T096).'
mkdir -p "${WORK}/stray/infra"
cp deploy.sh "${WORK}/stray/infra/deploy.sh"
sed 's/^      - SITE_DOMAIN$/      - SITE_DOMAIN\n      - OBJECT_STORE_SECRET_ACCESS_KEY/' \
  compose.staging.yaml >"${WORK}/stray/infra/compose.staging.yaml"
if ! grep -A12 '^  gateway:' "${WORK}/stray/infra/compose.staging.yaml" | grep -q OBJECT_STORE_SECRET_ACCESS_KEY; then
  bad 'the fixture did not place OBJECT_STORE_SECRET_ACCESS_KEY on the gateway; the check below would prove nothing'
fi
run_deploy stray-write-key "${DIGEST}" "${WORK}/stray"
if [ "$(cat "${WORK}/stray-write-key/status")" != '0' ] &&
  grep -q "OBJECT_STORE_SECRET_ACCESS_KEY" "${WORK}/stray-write-key/stderr"; then
  note 'an OBJECT_STORE_* variable on the gateway service is refused'
else
  bad "the gateway was given OBJECT_STORE_SECRET_ACCESS_KEY and the deploy did not refuse: $(tail -n 2 "${WORK}/stray-write-key/stderr")"
fi

echo '9. A failed migration stops the deploy before anything starts (FR-028).'
cat >"${WORK}/bin/docker" <<'STUB'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"${TRACE}"
real="$(PATH=/usr/bin:/bin:/usr/local/bin command -v docker)"
if [[ "${1:-}" == 'compose' ]]; then
  for arg in "$@"; do
    case "${arg}" in
      config) exec "${real}" "$@" ;;
      run) exit 1 ;;
      up) exit 0 ;;
      ps) printf 'container-id-for-api\n'; exit 0 ;;
    esac
  done
fi
exit 0
STUB
chmod +x "${WORK}/bin/docker"
run_deploy failed-migration "${DIGEST}"
if [ "$(cat "${WORK}/failed-migration/status")" != '0' ] &&
  grep -q 'REFUSED' "${WORK}/failed-migration/stderr" &&
  ! grep -q 'compose .* up ' "${WORK}/failed-migration/trace"; then
  note 'refused, and the start step was never reached'
else
  bad 'a failed migration did not stop the deploy before the start step'
fi

echo
if [ "${fail}" -eq 0 ]; then
  echo 'PASS — two deploys of one digest are the same deploy, and a failed migration starts nothing.'
else
  echo 'FAIL — see above.'
  exit 1
fi
