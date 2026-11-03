#!/usr/bin/env bash
#
# Deploy one published artifact to one environment (spec 025, contracts § 2).
#
#   infra/deploy.sh <environment> <forge-app digest> [forge-gateway digest]
#
# The digest is the full `sha256:…` printed in the release run's job summary, never a tag: a tag
# moves, and a deploy that can be re-pointed by a later push is not a deploy of a known artifact
# (FR-002). The steps run in this order and each one refuses rather than continuing:
#
#   1. verify the signature                                         (FR-005, FR-011)
#   2. render the environment's compose file, and assert the         (FR-002, FR-031)
#      credential-free pools really are credential-free
#   3. migrate the database on the new digest, under an advisory     (FR-025..FR-028)
#      lock, before anything starts
#   4. start the services and wait for health                       (FR-012)
#   5. confirm `GET /api/v1/version` reports the digest asked for    (FR-007)
#
# Verification is step one of *this script* rather than a step of the pipeline, deliberately
# (research R5). The pipeline calls this script; so does a person deploying by hand three weeks
# later against a digest they typed into a terminal. A check that only the pipeline performs proves
# nothing whatever about the second case, which is the case that goes wrong.
#
# Running it twice for the same digest lands the same state (SC-011): every step is a statement
# about the digest, not a mutation of what is already there.

set -euo pipefail

# --------------------------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------------------------

# The identity a signature must carry to be accepted. This is the whole of FR-005: a signature is
# not "a signature", it is *this repository's release workflow's* signature. Anything signed by
# another workflow, or by the same workflow in a fork, produces a different certificate identity
# and is refused below.
#
# Both are overridable so that a deploy of a tag-built image can name the tag ref it was built from
# (`…/release.yml@refs/tags/v1.2.3`), and so a fork can deploy its own artifacts without editing
# this file. They are never *widened* here: there is no regexp form and no unset default -- an
# empty value fails the check at the bottom of this block rather than matching everything.
COSIGN_CERTIFICATE_IDENTITY="${COSIGN_CERTIFICATE_IDENTITY:-https://github.com/teamblinto/baios-app/.github/workflows/release.yml@refs/heads/main}"
COSIGN_CERTIFICATE_OIDC_ISSUER="${COSIGN_CERTIFICATE_OIDC_ISSUER:-https://token.actions.githubusercontent.com}"

# Where the images live. Same lowercasing rule the release workflow applies.
FORGE_REGISTRY="${FORGE_REGISTRY:-ghcr.io/teamblinto}"
FORGE_APP_IMAGE="${FORGE_APP_IMAGE:-${FORGE_REGISTRY}/forge-app}"
FORGE_GATEWAY_IMAGE="${FORGE_GATEWAY_IMAGE:-${FORGE_REGISTRY}/forge-gateway}"

# The address the deployed edge answers on, used by the health and version steps only.
FORGE_BASE_URL="${FORGE_BASE_URL:-http://127.0.0.1:8080}"

# How long the stack is given to become healthy before the deploy is called failed (FR-012).
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-300}"
HEALTH_INTERVAL_SECONDS="${HEALTH_INTERVAL_SECONDS:-5}"

# The advisory lock the migration step takes, so two deploys against one environment cannot both
# migrate (FR-026). Same mechanism and same numbering family as the rest of the codebase's advisory
# locks -- `OUTBOX_RELAY_LOCK = 7_301_005n` in `apps/api/src/modules/outbox/outbox.constants.ts`,
# which is spec 005's single-leader election, plus `7_301_006` (the outbox suite lock),
# `RUN_REAPER_LOCK = 7_301_008n` and `MAINTENANCE_LOCK = 7_301_014n`. `7301025` is the next free
# number in that family and names this spec, so it can never serialise against any of them.
MIGRATION_LOCK_KEY="${MIGRATION_LOCK_KEY:-7301025}"

# §13's callout, made explicit (FR-027). `lock_timeout` bounds how long the migration will wait for
# the advisory lock and for any table lock a DDL statement needs -- a second deploy waits, and a
# migration queued behind a long read gives up instead of holding every write on the table behind
# it. `statement_timeout` bounds each statement once it has the lock, and is the backstop for the
# lock wait too, so the bound holds whichever of the two Postgres applies first. Both are Postgres
# interval strings and both are validated below rather than pasted into SQL.
MIGRATION_LOCK_TIMEOUT="${MIGRATION_LOCK_TIMEOUT:-30s}"
MIGRATION_STATEMENT_TIMEOUT="${MIGRATION_STATEMENT_TIMEOUT:-300s}"

# The environment variable the migration connects as. The migrator role, not the application role:
# the application role has no DDL rights, which is the point of having two.
MIGRATION_URL_VARIABLE="${MIGRATION_URL_VARIABLE:-DATABASE_MIGRATION_URL}"

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_ROOT

# --------------------------------------------------------------------------------------------
# Plumbing
# --------------------------------------------------------------------------------------------

log() { printf '[deploy] %s\n' "$*"; }

# Every refusal goes through here, so a failure is always a sentence naming the step that refused
# rather than a bare non-zero exit from some tool (FR-005's "fail loudly").
die() {
  printf '[deploy] REFUSED: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
usage: infra/deploy.sh <environment> <forge-app digest> [forge-gateway digest]

  <environment>          staging | production -- a name with a compose file, not a host
  <forge-app digest>     sha256:<64 hex>, copied from the release run's job summary
  [forge-gateway digest] the same, for forge-gateway; omitted leaves that pool untouched
EOF
  exit 2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is not installed; $2"
}

# A digest, and nothing that is merely digest-shaped. `forge-app:latest`, `main`, a short sha and an
# empty string all land here and all are refused: FR-002 is about what a deploy is *allowed to be
# pointed at*, and the check belongs before anything is fetched rather than in the registry's error
# message afterwards.
require_digest() {
  local label="$1" value="$2"
  [[ -n "${value}" ]] || die "${label} is empty; a deploy takes a digest, not a default"
  [[ "${value}" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    die "${label} '${value}' is not a digest. Deploys take the full sha256:… from the release run's job summary, never a tag (FR-002)"
}

# --------------------------------------------------------------------------------------------
# Input
# --------------------------------------------------------------------------------------------

[[ $# -ge 2 && $# -le 3 ]] || usage

ENVIRONMENT="$1"
APP_DIGEST="$2"
GATEWAY_DIGEST="${3:-}"

case "${ENVIRONMENT}" in
  staging | production) ;;
  *) die "unknown environment '${ENVIRONMENT}'; expected staging or production" ;;
esac

COMPOSE_FILE="${REPO_ROOT}/infra/compose.${ENVIRONMENT}.yaml"
[[ -f "${COMPOSE_FILE}" ]] || die "no compose file for '${ENVIRONMENT}' at ${COMPOSE_FILE}"

require_digest 'the forge-app digest' "${APP_DIGEST}"
[[ -z "${GATEWAY_DIGEST}" ]] || require_digest 'the forge-gateway digest' "${GATEWAY_DIGEST}"

[[ -n "${COSIGN_CERTIFICATE_IDENTITY}" ]] ||
  die 'COSIGN_CERTIFICATE_IDENTITY is empty; a deploy will not accept a signature from an unnamed identity'
[[ -n "${COSIGN_CERTIFICATE_OIDC_ISSUER}" ]] ||
  die 'COSIGN_CERTIFICATE_OIDC_ISSUER is empty; a deploy will not accept a signature from an unnamed issuer'

# The two timeouts reach Postgres through `set_config($1, $2, false)` rather than string
# interpolation, so this is not what stops an injection -- it is what stops a typo. `30` is not a
# Postgres interval and `SELECT` is not a timeout; both would be accepted by the parameter and then
# refused by the server, in the middle of a deploy, after the artifact was pulled.
require_interval() {
  local label="$1" value="$2"
  [[ "${value}" =~ ^[0-9]+(ms|s|min|h)?$ ]] ||
    die "${label} '${value}' is not a Postgres interval; expected something like 30s, 500ms or 5min"
}
require_interval 'MIGRATION_LOCK_TIMEOUT' "${MIGRATION_LOCK_TIMEOUT}"
require_interval 'MIGRATION_STATEMENT_TIMEOUT' "${MIGRATION_STATEMENT_TIMEOUT}"
[[ "${MIGRATION_LOCK_KEY}" =~ ^-?[0-9]+$ ]] ||
  die "MIGRATION_LOCK_KEY '${MIGRATION_LOCK_KEY}' is not a bigint; an advisory lock key is a number"

# --------------------------------------------------------------------------------------------
# Step 1 -- verify the signature (T037, FR-005, FR-011)
# --------------------------------------------------------------------------------------------
#
# First, before the compose file is rendered and before anything is pulled or started. An artifact
# nobody signed, or one signed by somebody else, stops the deploy here with nothing changed on the
# host.

verify_signature() {
  local image="$1" digest="$2"
  log "verifying ${image}@${digest}"
  cosign verify \
    --certificate-identity "${COSIGN_CERTIFICATE_IDENTITY}" \
    --certificate-oidc-issuer "${COSIGN_CERTIFICATE_OIDC_ISSUER}" \
    "${image}@${digest}" >/dev/null ||
    die "no valid signature for ${image}@${digest} from ${COSIGN_CERTIFICATE_IDENTITY} via ${COSIGN_CERTIFICATE_OIDC_ISSUER}"
}

step_verify() {
  log 'step 1/5: verify signatures'
  require_command cosign 'a deploy cannot verify a signature without it, and an unverified deploy is not one this script performs'
  verify_signature "${FORGE_APP_IMAGE}" "${APP_DIGEST}"
  [[ -z "${GATEWAY_DIGEST}" ]] || verify_signature "${FORGE_GATEWAY_IMAGE}" "${GATEWAY_DIGEST}"
  log 'signatures verified'
}

# --------------------------------------------------------------------------------------------
# Step 2 -- render the environment's compose file (T038, FR-002)
# --------------------------------------------------------------------------------------------
#
# The compose file pins `${FORGE_APP_DIGEST}` into an `image:` that is already `…@` -- so a value
# that is not a digest cannot produce a valid reference, and `docker compose config` says so. The
# render is also where the digest becomes `BUILD_DIGEST` in the container's environment: the image
# cannot carry its own digest (baking it would change it), so the deploy tells the container which
# artifact it is, and step 4 then checks the answer against the image the container is actually
# running rather than trusting that statement on its own.

render_environment() {
  cat <<EOF
FORGE_APP_IMAGE=${FORGE_APP_IMAGE}
FORGE_APP_DIGEST=${APP_DIGEST}
FORGE_GATEWAY_IMAGE=${FORGE_GATEWAY_IMAGE}
FORGE_GATEWAY_DIGEST=${GATEWAY_DIGEST:-${APP_DIGEST}}
BUILD_DIGEST=${APP_DIGEST}
EOF
}

step_render() {
  log 'step 2/5: render the compose file'
  require_command docker 'the deploy renders and starts the environment with it'

  RENDER_ENV_FILE="$(mktemp -t "forge-deploy-${ENVIRONMENT}-XXXXXX.env")"
  readonly RENDER_ENV_FILE
  trap 'rm -f "${RENDER_ENV_FILE}"' EXIT
  render_environment >"${RENDER_ENV_FILE}"

  local rendered
  rendered="$(compose config)" ||
    die "${COMPOSE_FILE} does not render for ${ENVIRONMENT} with the given digests"

  # `docker compose config` interpolates and validates the schema; it does not care whether an
  # image reference names a digest or a tag, and would happily hand `forge-app@latest` to the
  # daemon to fail on later. The pin is checked here, against the rendered text, because that is
  # the only place the values and the file are both known (FR-002).
  local unpinned
  unpinned="$(printf '%s\n' "${rendered}" | grep -E '^\s+image:' | grep -v '@sha256:[0-9a-f]\{64\}$' || true)"
  [[ -z "${unpinned}" ]] ||
    die "the rendered ${ENVIRONMENT} stack has an image that is not pinned to a digest:${unpinned}"

  assert_credential_free_pools "${rendered}"
  assert_artifact_read_key_distinct "${rendered}" # spec 027 T096

  log "rendered ${COMPOSE_FILE}, every image pinned by digest"
}

# --------------------------------------------------------------------------------------------
# T048 -- the gateway and daytona pools carry no credential (FR-031)
# --------------------------------------------------------------------------------------------
#
# §01's hard rule: nothing holding a database credential, a platform API key or a tenant secret
# runs on a gateway or a daytona node. `infra/compose.staging.yaml` says so in a comment and
# `infra/ansible/gateway.yml` asserts it on a converge; this is the same assertion on the path a
# deploy actually takes, so a variable added to the wrong service block fails here, before the
# artifact is started, rather than on a node.
#
# The vocabulary is deliberately the same as that play's -- `gateway_forbidden_env_keys` and
# `gateway_forbidden_env_values` in `infra/ansible/inventories/*/group_vars/gateway.yml`. Two
# lists that drift are worse than one, and the weaker of the two would be the one that passes.
# spec 028 T006: CLOUDFLARE_API_TOKEN is spec 028's platform credential (FR-032). The gateway
# spec 028 T006: checks the edge's EDGE_ORIGIN_SECRET and never registers a hostname, so the token
# spec 028 T006: is absent from its environment. These lines and the tagged FORBIDDEN_ENV_KEYS
# spec 028 T006: line are the whole of 028's change here (`infra/check-fr038.sh` restores them).
CREDENTIAL_FREE_SERVICES_PATTERN='^(gateway|daytona)'

FORBIDDEN_ENV_KEYS='^(DATABASE_|POSTGRES_|PGBOUNCER_|REDIS_|KEK_|OPENBAO_|VAULT_|PLATFORM_API_KEY|ANTHROPIC_|OPENAI_|DAYTONA_API_KEY|GITHUB_APP_PRIVATE_KEY|CLOUDFLARE_API_TOKEN|SESSION_SECRET|PREVIEW_SIGNING|PREVIEW_PRIVATE)' # spec 028 T006

# The key name is the easy half; this catches a connection string or a secret-store token smuggled
# in under an innocent key.
FORBIDDEN_ENV_VALUES='(postgres(ql)?://|redis(s)?://|amqp(s)?://|mysql://|mongodb(\+srv)?://|(^|[^A-Za-z0-9])(s\.|hvs\.|bao_)[A-Za-z0-9]{16,})'

# The services in the rendered stack, one per line. `docker compose config` normalises the file, so
# a service is a two-space-indented key and nothing else is.
rendered_services() {
  printf '%s\n' "$1" | sed -n 's/^  \([A-Za-z0-9_.-]*\):$/\1/p'
}

# One service's environment as `KEY: value` lines. Also from the normalised render, which always
# writes the mapping form at six spaces under `    environment:` -- never the list form the source
# file uses, and never an anchor, because compose has already resolved both.
service_environment() {
  printf '%s\n' "$1" | awk -v svc="$2" '
    /^  [A-Za-z0-9_.-]+:$/ { in_service = ($0 == "  " svc ":"); in_env = 0; next }
    in_service && /^    [A-Za-z0-9_.-]+:/ { in_env = ($0 == "    environment:"); next }
    in_service && in_env && /^      / { line = $0; sub(/^      /, "", line); print line }
  '
}

assert_credential_free_pools() {
  local rendered="$1" service checked=0

  while IFS= read -r service; do
    [[ -n "${service}" ]] || continue
    [[ "${service}" =~ ${CREDENTIAL_FREE_SERVICES_PATTERN} ]] || continue
    checked=$((checked + 1))

    local line key value
    while IFS= read -r line; do
      [[ -n "${line}" ]] || continue
      key="${line%%:*}"
      value="${line#*: }"

      [[ ! "${key}" =~ ${FORBIDDEN_ENV_KEYS} ]] ||
        die "the rendered ${ENVIRONMENT} stack gives '${service}' the variable '${key}'. Nothing holding a database credential, a platform API key or a secret-store token runs on the gateway or daytona pools (§01, FR-031); move the privileged half onto the app pool and expose a broker call"

      # `null` is compose's rendering of a variable that is declared and unset. Declaring the name
      # is not carrying the credential, and a deploy that refused it would refuse every stack.
      [[ "${value}" == 'null' ]] && continue

      [[ ! "${value}" =~ ${FORBIDDEN_ENV_VALUES} ]] ||
        die "the rendered ${ENVIRONMENT} stack gives '${service}' a value under '${key}' that looks like a credential -- a postgres://, redis://, amqp://, mysql:// or mongodb:// URL, or a bao/vault token. §01 forbids it on this pool (FR-031)"
    done < <(service_environment "${rendered}" "${service}")
  done < <(rendered_services "${rendered}")

  ((checked > 0)) ||
    die "the rendered ${ENVIRONMENT} stack has no gateway or daytona service to check; FR-031's assertion would pass vacuously, which is not the same as passing"

  log "${checked} credential-free service(s) carry no database URL, platform API key or secret-store token"
}

# --- spec 027 T096 begin ---------------------------------------------------------------------
#
# The gateway serves deployed sites from the artifacts bucket with a key of its own (spec 027 R11,
# ask-first item 1): read-only, scoped to that bucket, holding nothing that was not served
# publicly. The api and worker write the same bucket with OBJECT_STORE_*. Were the two one key,
# the internet-facing pool would hold a credential that can overwrite or delete every published
# site and read every repository mirror -- exactly what §01 keeps off it. So, on the rendered
# stack: no OBJECT_STORE_* variable on the gateway by name, and the gateway's
# ARTIFACT_STORE_ACCESS_KEY_ID never equal to the api's or worker's OBJECT_STORE_ACCESS_KEY_ID.
# `infra/ansible/gateway.yml` asserts the same on a converge. This block and the one call line
# tagged `spec 027 T096` are the whole of 027's change to this file (FR-038, checked by
# `infra/check-fr038.sh`).
ARTIFACT_READ_SERVICES_PATTERN='^gateway'
OBJECT_STORE_WRITE_SERVICES_PATTERN='^(api|worker)'

# `null` (declared, unset) and empty are no key at all; quotes are compose's, not the value's.
rendered_key_value() {
  local value="$1"
  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"
  if [[ "${value}" == 'null' ]]; then value=''; fi
  printf '%s' "${value}"
}

assert_artifact_read_key_distinct() {
  local rendered="$1" service line key value read_key write_key
  local -a read_keys=() write_keys=()

  while IFS= read -r service; do
    [[ -n "${service}" ]] || continue
    while IFS= read -r line; do
      [[ -n "${line}" ]] || continue
      key="${line%%:*}"
      value="$(rendered_key_value "${line#*: }")"

      if [[ "${service}" =~ ${ARTIFACT_READ_SERVICES_PATTERN} ]]; then
        [[ ! "${key}" =~ ^OBJECT_STORE_ ]] ||
          die "the rendered ${ENVIRONMENT} stack gives '${service}' the variable '${key}'. OBJECT_STORE_* is the api's write access to the object store; the gateway reads sites with its own read-only ARTIFACT_STORE_* key (spec 027 R11)"
        if [[ "${key}" == 'ARTIFACT_STORE_ACCESS_KEY_ID' && -n "${value}" ]]; then
          read_keys+=("${value}")
        fi
      elif [[ "${service}" =~ ${OBJECT_STORE_WRITE_SERVICES_PATTERN} ]]; then
        if [[ "${key}" == 'OBJECT_STORE_ACCESS_KEY_ID' && -n "${value}" ]]; then
          write_keys+=("${value}")
        fi
      fi
    done < <(service_environment "${rendered}" "${service}")
  done < <(rendered_services "${rendered}")

  if ((${#read_keys[@]} == 0)); then
    log 'no artifact read key rendered for the gateway; this stack does not serve deployed sites'
    return 0
  fi

  for read_key in "${read_keys[@]}"; do
    for write_key in "${write_keys[@]}"; do
      [[ "${read_key}" != "${write_key}" ]] ||
        die "the rendered ${ENVIRONMENT} stack gives the gateway an ARTIFACT_STORE_ACCESS_KEY_ID equal to the api's OBJECT_STORE_ACCESS_KEY_ID. The gateway's key must be a separate read-only key scoped to the artifacts bucket, never the api's write key (spec 027 R11, T096)"
    done
  done

  log "the gateway's artifact read key differs from the api's object-store write key"
}
# --- spec 027 T096 end -----------------------------------------------------------------------

# Every later docker call goes through this, so the file, project name and rendered environment can
# never drift between the render, the migration step and the start.
compose() {
  docker compose \
    --project-name "forge-${ENVIRONMENT}" \
    --env-file "${RENDER_ENV_FILE}" \
    --file "${COMPOSE_FILE}" \
    "$@"
}

# --------------------------------------------------------------------------------------------
# Step 3 -- migrate the database (T043-T046, FR-025..FR-028, research R8)
# --------------------------------------------------------------------------------------------
#
# After the render and before anything starts. Four properties, each of which is a requirement:
#
#   * it runs as a one-shot container **on the new digest** (T043). `compose run` on the `api`
#     service uses the image the render pinned, so the migrations applied are the migrations that
#     shipped with the code about to serve them. The `compose` CI job migrates from the runner's
#     checkout, which is right for an empty database and wrong here: the runner's tree is not the
#     artifact, and a deploy of a digest built last week from a tree that has since moved would
#     otherwise apply a schema nothing is going to run (research R8).
#   * it holds `pg_advisory_lock` for the whole migration (T044, FR-026), so two deploys against
#     one environment cannot both migrate. Session-scoped rather than `_xact_`, because a
#     migration is many transactions -- the shape `apps/api/test/support/outbox-suite-lock.ts`
#     already uses for exactly that reason -- on a connection of its own, direct, never through a
#     pooler. The key is the outbox relay's family; see MIGRATION_LOCK_KEY above.
#   * it sets `lock_timeout` and `statement_timeout` first (T045, FR-027), so the second deploy
#     waits a bounded time and then fails loudly, rather than queueing behind a long read and
#     stalling every write on the table behind it.
#   * a failure stops the deploy here, with nothing started (T046, FR-028). `step_start` is not
#     reached, so no version ever serves against a partially-applied schema.
#
# FR-029's long-running data changes are explicitly *not* this step. A backfill that takes hours
# does not belong in a deploy, and putting one here is how a deploy becomes an outage: it runs
# outside the deploy as its own resumable job, restartable from where it stopped, with the schema
# change that enables it shipped here and the data change following separately. Nothing in the tree
# needs one yet -- this paragraph exists so the first one is not put here (see quickstart.md and
# research R8).
#
# The program below is the artifact's own `drizzle-orm` migrator rather than `drizzle-kit`:
# `drizzle-kit` is a devDependency and `pnpm deploy --prod` does not put it in the image, while
# `drizzle-orm`, `pg` and `@repo/db`'s `migrations/` directory are all in it. Same migrations, same
# journal table, from the image instead of from a checkout.

migration_program() {
  cat <<'JS'
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const fail = (message) => {
  console.error(`migration: ${message}`);
  process.exit(1);
};

const urlVariable = process.env.FORGE_MIGRATION_URL_VARIABLE;
const url = process.env[urlVariable];
if (!url) {
  fail(`${urlVariable} is not set in the deployed environment; there is nothing to migrate against`);
}

// The migrations directory inside the image, never a path from the host.
const require_ = createRequire(import.meta.url);
const candidates = [];
try {
  candidates.push(path.join(path.dirname(require_.resolve('@repo/db')), '..', 'migrations'));
} catch {
  // Resolved below from the deploy layout instead.
}
candidates.push('/app/node_modules/@repo/db/migrations');

const migrationsFolder = candidates.find((candidate) => existsSync(candidate));
if (!migrationsFolder) {
  fail('this image carries no @repo/db/migrations directory; it is not a forge-app image');
}

const client = new pg.Client({ connectionString: url });
await client.connect();

// `set_config($1, $2, false)` and not an interpolated SET: the values arrive from the deploy's
// environment, and a timeout is a parameter, not a fragment of SQL.
const lockTimeout = process.env.FORGE_MIGRATION_LOCK_TIMEOUT;
const statementTimeout = process.env.FORGE_MIGRATION_STATEMENT_TIMEOUT;
await client.query('select set_config($1, $2, false)', ['lock_timeout', lockTimeout]);
await client.query('select set_config($1, $2, false)', ['statement_timeout', statementTimeout]);

const key = process.env.FORGE_MIGRATION_LOCK_KEY;
try {
  await client.query('select pg_advisory_lock($1::bigint)', [key]);
} catch (error) {
  fail(
    `could not take advisory lock ${key} within lock_timeout=${lockTimeout} / ` +
      `statement_timeout=${statementTimeout}: ${error.message}. Another deploy is migrating this ` +
      `environment; nothing was applied and nothing was started.`,
  );
}
console.log(`migration: holding advisory lock ${key}`);

try {
  await migrate(drizzle(client), { migrationsFolder });
  console.log(`migration: applied from ${migrationsFolder}`);
} finally {
  // Released explicitly rather than left to the session ending, so the log says it happened.
  await client.query('select pg_advisory_unlock($1::bigint)', [key]);
  await client.end();
}
JS
}

step_migrate() {
  log 'step 3/5: migrate the database on the new digest'
  log "advisory lock ${MIGRATION_LOCK_KEY}, lock_timeout=${MIGRATION_LOCK_TIMEOUT}, statement_timeout=${MIGRATION_STATEMENT_TIMEOUT}"

  local program
  program="$(migration_program)"

  # `--no-deps` so the migration does not start the stack it is supposed to precede, and `--rm` so
  # running the deploy twice for the same digest leaves no second container behind (SC-011).
  compose run --rm --no-deps -T \
    --env "FORGE_MIGRATION_URL_VARIABLE=${MIGRATION_URL_VARIABLE}" \
    --env "FORGE_MIGRATION_LOCK_KEY=${MIGRATION_LOCK_KEY}" \
    --env "FORGE_MIGRATION_LOCK_TIMEOUT=${MIGRATION_LOCK_TIMEOUT}" \
    --env "FORGE_MIGRATION_STATEMENT_TIMEOUT=${MIGRATION_STATEMENT_TIMEOUT}" \
    api node --input-type=module --eval "${program}" ||
    die "the migration failed against ${ENVIRONMENT}; nothing has been started, so no version is serving against a partially-applied schema (FR-028). Fix the migration or the database and run this script again -- it is safe to repeat"

  log 'the database is migrated'
}

# --------------------------------------------------------------------------------------------
# Step 4 -- start the services and wait for health (T039, FR-012)
# --------------------------------------------------------------------------------------------

step_start() {
  log 'step 4/5: start the services and wait for health'
  compose up --detach --wait --wait-timeout "${HEALTH_TIMEOUT_SECONDS}" ||
    die "the ${ENVIRONMENT} stack did not become healthy within ${HEALTH_TIMEOUT_SECONDS}s"

  # `--wait` covers the containers' own healthchecks; this covers the edge in front of them, which
  # is the surface anything outside the host actually reaches.
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  until curl --fail --silent --show-error --max-time 10 "${FORGE_BASE_URL}/api/v1/health" >/dev/null 2>&1; do
    ((SECONDS < deadline)) ||
      die "${FORGE_BASE_URL}/api/v1/health did not answer within ${HEALTH_TIMEOUT_SECONDS}s"
    sleep "${HEALTH_INTERVAL_SECONDS}"
  done
  log 'the stack is healthy'
}

# --------------------------------------------------------------------------------------------
# Step 5 -- confirm what is actually running (T039, FR-007)
# --------------------------------------------------------------------------------------------
#
# Two checks, because they fail differently and both matter:
#
#   * the container's image reference, read from the daemon, must be the digest that was asked for.
#     This is the one that catches "the old container is still serving" -- a start that silently
#     left yesterday's artifact up passes a health check perfectly.
#   * `GET /api/v1/version` must report the same digest. This is the one that catches "something
#     else is answering on this address": a load balancer still pointing at another pool, an
#     unrelated process holding port 8080.
#
# Success is reported only when both agree with the argument this script was given.

confirm_running_image() {
  local service="$1" expected="$2" container image_ref
  container="$(compose ps --quiet "${service}")" ||
    die "cannot inspect the ${service} service after starting it"
  [[ -n "${container}" ]] || die "the ${service} service is not running after the start step"

  image_ref="$(docker inspect --format '{{index .Image}}{{range .RepoDigests}} {{.}}{{end}}' "${container}")" ||
    die "cannot read the image of the running ${service} container"
  [[ "${image_ref}" == *"${expected}"* ]] ||
    die "the running ${service} container is '${image_ref}', not the requested ${expected}"
  log "${service} is running ${expected}"
}

step_confirm() {
  log 'step 5/5: confirm the running artifact'
  require_command curl 'the version confirmation is an HTTP request'

  confirm_running_image api "${APP_DIGEST}"

  local reported
  reported="$(curl --fail --silent --show-error --max-time 10 "${FORGE_BASE_URL}/api/v1/version" |
    sed -n 's/.*"digest"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')" ||
    die "${FORGE_BASE_URL}/api/v1/version did not answer; what is running cannot be confirmed"

  [[ -n "${reported}" ]] ||
    die "${FORGE_BASE_URL}/api/v1/version answered without a digest field"
  [[ "${reported}" == "${APP_DIGEST}" ]] ||
    die "${FORGE_BASE_URL}/api/v1/version reports ${reported}, but this deploy asked for ${APP_DIGEST}"

  log "the version endpoint reports ${reported}"
}

# --------------------------------------------------------------------------------------------

main() {
  log "deploying ${APP_DIGEST} to ${ENVIRONMENT}"
  step_verify
  step_render
  step_migrate
  step_start
  step_confirm
  printf '[deploy] OK: %s is running %s\n' "${ENVIRONMENT}" "${APP_DIGEST}"
}

main "$@"
