#!/usr/bin/env bash
# Spec 027 T097 — confirm FR-038 holds: deploys and releases did not change the platform's own
# release path (spec 025's images, workflow and deploy script) or the gateway's preview routing
# (SC-013).
#
# Run it from anywhere:
#
#   infra/check-fr038.sh
#
# The same idiom as `check-deploy-idempotent.sh` and `ansible/check-repo-sourced.sh`: a
# self-contained bash check that names each property, proves it, and fails loudly.
#
# "Unchanged" is measured against FR038_BASE, the commit that added spec 027's documents and
# before any of its code (`739f693`, "docs(027): the spec, plan and tasks for deploys and
# releases"). If history is rewritten, set FR038_BASE to the rewritten equivalent; a base that
# does not exist fails the check rather than passing it.
#
# What it checks:
#   1. `.github/workflows/release.yml` and both Dockerfiles are byte-identical to the base.
#   2. `infra/deploy.sh` is byte-identical to the base once spec 027 T096's assertion is removed:
#      the block between the `spec 027 T096 begin`/`end` markers and the one call line tagged
#      `# spec 027 T096`. So the steps, their order and every existing check are untouched.
#      Spec 028 T006's change is restored too: its `# spec 028 T006:` comment lines are dropped,
#      and the one FORBIDDEN_ENV_KEYS line tagged `# spec 028 T006` loses the tag and exactly the
#      `|CLOUDFLARE_API_TOKEN` it added. Any other edit to that line still shows in the diff.
#   3. That comparison is not vacuous: the markers are present exactly once, and a deploy.sh with
#      one line outside them changed is caught, as is any other change to 028's tagged line.
#   4. The gateway's preview e2e suites are byte-identical to the base and pass as they are.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

FR038_BASE="${FR038_BASE:-739f693}"
BEGIN_MARKER='^# --- spec 027 T096 begin '
END_MARKER='^# --- spec 027 T096 end '
CALL_TAG=' # spec 027 T096$'
T006_COMMENT='^# spec 028 T006: '
T006_TAG=' # spec 028 T006$'

WORK="$(mktemp -d -t forge-fr038-XXXXXX)"
trap 'rm -rf "${WORK}"' EXIT

fail=0
note() { printf '  %s\n' "$1"; }
bad() {
  printf '  FAIL: %s\n' "$1"
  fail=1
}

git rev-parse --verify --quiet "${FR038_BASE}^{commit}" >/dev/null || {
  printf 'FAIL — FR038_BASE %s is not a commit in this repository; nothing can be compared.\n' \
    "${FR038_BASE}"
  exit 1
}

# deploy.sh with spec 027 T096's lines taken out, and spec 028 T006's restored to their base form.
strip_t096() {
  awk -v begin="${BEGIN_MARKER}" -v end="${END_MARKER}" -v tag="${CALL_TAG}" \
    -v t006_comment="${T006_COMMENT}" -v t006_tag="${T006_TAG}" '
    $0 ~ begin { skipping = 1; next }
    skipping && $0 ~ end { skipping = 0; dropped_blank = 1; next }
    dropped_blank { dropped_blank = 0; if ($0 == "") next }
    $0 ~ tag { next }
    $0 ~ t006_comment { next }
    $0 ~ t006_tag {
      sub(t006_tag, "")
      if (index($0, "FORBIDDEN_ENV_KEYS=") == 1) sub(/\|CLOUDFLARE_API_TOKEN\|/, "|")
    }
    !skipping { print }
  ' "$1"
}

echo "1. Spec 025's workflow and images are byte-identical to ${FR038_BASE}."
for path in .github/workflows/release.yml apps/api/Dockerfile apps/gateway/Dockerfile; do
  if git diff --quiet "${FR038_BASE}" -- "${path}" && [ -z "$(git status --porcelain -- "${path}")" ]; then
    note "${path} unchanged"
  else
    bad "${path} differs from ${FR038_BASE} (FR-038)"
  fi
done

echo "2. infra/deploy.sh is ${FR038_BASE}'s, apart from T096's assertion and 028 T006's key."
git show "${FR038_BASE}:infra/deploy.sh" >"${WORK}/deploy.base"
strip_t096 infra/deploy.sh >"${WORK}/deploy.stripped"
if diff -u "${WORK}/deploy.base" "${WORK}/deploy.stripped" >"${WORK}/deploy.diff"; then
  note "$(wc -l <"${WORK}/deploy.base" | tr -d ' ') lines identical, the five steps in the same order"
else
  bad 'deploy.sh changed outside the T096 assertion and the 028 T006 key:'
  sed 's/^/    /' "${WORK}/deploy.diff"
fi

echo '3. The comparison above is not vacuous.'
begins="$(grep -c "${BEGIN_MARKER}" infra/deploy.sh || true)"
ends="$(grep -c "${END_MARKER}" infra/deploy.sh || true)"
calls="$(grep -c -- "${CALL_TAG}" infra/deploy.sh || true)"
t006_lines="$(grep -c -- "${T006_TAG}" infra/deploy.sh || true)"
if [ "${begins}" = 1 ] && [ "${ends}" = 1 ] && [ "${calls}" = 1 ] && [ "${t006_lines}" = 1 ]; then
  note 'one T096 block, one tagged call line and one 028 T006 line, and nothing else is excused'
else
  bad "expected one T096 begin, end and call line and one 028 T006 line; found ${begins}, ${ends}, ${calls} and ${t006_lines}"
fi
# A change outside the block: swap the migration step's advisory-lock default for another number.
sed 's/MIGRATION_LOCK_KEY:-7301025/MIGRATION_LOCK_KEY:-7301026/' infra/deploy.sh >"${WORK}/deploy.mutated"
if cmp -s infra/deploy.sh "${WORK}/deploy.mutated"; then
  bad 'the mutation did not apply, so the check below would prove nothing'
elif strip_t096 "${WORK}/deploy.mutated" | diff -q "${WORK}/deploy.base" - >/dev/null; then
  bad 'a deploy.sh changed outside the T096 block compared equal to the base'
else
  note 'a deploy.sh changed outside the T096 block is caught'
fi
# A change to 028's tagged line beyond its one key: drop another forbidden key from it.
sed '/ # spec 028 T006$/s/|SESSION_SECRET|/|/' infra/deploy.sh >"${WORK}/deploy.mutated028"
if cmp -s infra/deploy.sh "${WORK}/deploy.mutated028"; then
  bad 'the 028 mutation did not apply, so the check below would prove nothing'
elif strip_t096 "${WORK}/deploy.mutated028" | diff -q "${WORK}/deploy.base" - >/dev/null; then
  bad "a further change to 028 T006's tagged line compared equal to the base"
else
  note "a further change to 028 T006's tagged line is caught"
fi

echo "4. The gateway's preview e2e suites are ${FR038_BASE}'s, and pass unchanged."
suites=(apps/gateway/test/preview-proxy.e2e-spec.ts apps/gateway/test/preview-real.e2e-spec.ts)
for path in "${suites[@]}"; do
  if git diff --quiet "${FR038_BASE}" -- "${path}" && [ -z "$(git status --porcelain -- "${path}")" ]; then
    note "${path} unchanged"
  else
    bad "${path} differs from ${FR038_BASE}; preview routing's own tests were edited (FR-038)"
  fi
done
# preview-real skips itself without DAYTONA_API_URL/DAYTONA_API_KEY and says so on stderr.
if (cd apps/gateway && pnpm exec vitest run --coverage.enabled=false \
  test/preview-proxy.e2e-spec.ts test/preview-real.e2e-spec.ts) >"${WORK}/vitest.log" 2>&1; then
  note "$(grep -E '^ +Tests ' "${WORK}/vitest.log" | sed 's/^ *//')"
else
  bad 'the preview e2e suites did not pass:'
  tail -n 30 "${WORK}/vitest.log" | sed 's/^/    /'
fi

echo
if [ "${fail}" -eq 0 ]; then
  echo "PASS — spec 025's release path and the gateway's preview routing are as ${FR038_BASE} left them (FR-038)."
else
  echo 'FAIL — see above.'
  exit 1
fi
