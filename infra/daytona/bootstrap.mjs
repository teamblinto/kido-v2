// One-shot bootstrap for the local Daytona stack (infra/daytona/compose.yaml). Runs in
// `node:24-alpine` after `api`, `proxy` and `runner` are healthy, and again on every `up`.
//
// What it leaves behind, idempotently:
//   - one API key named API_KEY_NAME with API_KEY_PERMISSIONS, minted once and kept in STATE_FILE
//     (a named volume) because Daytona shows a key's value only at creation — re-minted when a
//     stored key lacks a permission this list has since gained (spec 015 added the snapshot pair);
//   - one sandbox named SANDBOX_NAME from SNAPSHOT with auto-stop off, started;
//   - OUTPUT_FILE with the three variables `apps/api/.env` needs.
//
// Only fetch and fs: no dependency to install, nothing to build.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const API = env('DAYTONA_API_URL');
const PUBLIC_API_URL = env('PUBLIC_API_URL');
const SNAPSHOT = env('SNAPSHOT');
const SANDBOX_NAME = env('SANDBOX_NAME');
const API_KEY_NAME = env('API_KEY_NAME');
/** The sandbox pair (010/014) plus the snapshot pair the template publisher needs (015 R1). */
const API_KEY_PERMISSIONS = [
  'write:sandboxes',
  'delete:sandboxes',
  'write:snapshots',
  'delete:snapshots',
];
const STATE_FILE = env('STATE_FILE');
const OUTPUT_FILE = env('OUTPUT_FILE');

const log = (message) => console.log(`[daytona-bootstrap] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `fetch` that throws on a non-2xx with the status and the body's first line, and parses JSON. */
async function call(url, { headers = {}, method = 'GET', body } = {}) {
  const response = await fetch(url, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
    method,
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${method} ${url} -> ${response.status} ${text.split('\n')[0]}`);
    error.status = response.status;
    throw error;
  }
  return text ? JSON.parse(text) : undefined;
}

/** Poll `probe` until it returns a truthy value, or give up after `timeoutMs`. */
async function until(what, probe, { everyMs = 5_000, timeoutMs = 15 * 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
    log(`waiting for ${what}…`);
    await sleep(everyMs);
  }
}

function readState() {
  try {
    return Object.fromEntries(
      readFileSync(STATE_FILE, 'utf8')
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => line.split(/=(.*)/s).slice(0, 2)),
    );
  } catch {
    return {};
  }
}

function writeEnvFile(path, values) {
  mkdirSync(dirname(path), { recursive: true });
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o644 });
}

/** Dex's resource-owner password grant for the static dev user; the id token is what the API verifies. */
async function signIn() {
  const response = await fetch(env('DEX_TOKEN_URL'), {
    body: new URLSearchParams({
      client_id: 'daytona',
      grant_type: 'password',
      password: env('DEX_PASSWORD'),
      scope: 'openid email profile',
      username: env('DEX_EMAIL'),
    }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  });
  if (!response.ok)
    throw new Error(`Dex sign-in failed: ${response.status} ${await response.text()}`);
  const { id_token: idToken } = await response.json();
  return idToken;
}

/** The dev user's personal organization, and headers that act as the user inside it. */
async function signInToOrganization() {
  const idToken = await signIn();
  const user = { authorization: `Bearer ${idToken}` };
  const organizations = await call(`${API}/organizations`, { headers: user });
  const organization = organizations.find((o) => o.personal) ?? organizations[0];
  if (!organization) throw new Error('the Dex user has no organization');
  return { organization, scoped: { ...user, 'x-daytona-organization-id': organization.id } };
}

/** A fresh organization has no default region and refuses to create a sandbox until it has one. */
async function ensureDefaultRegion({ organization, scoped }) {
  if (organization.defaultRegionId) return;
  const regions = await call(`${API}/regions`, { headers: scoped });
  const region = regions.find((r) => r.regionType === 'shared') ?? regions[0];
  if (!region) throw new Error('Daytona has no region; is the runner registered?');
  await call(`${API}/organizations/${organization.id}/default-region`, {
    body: { defaultRegionId: region.id },
    headers: scoped,
    method: 'PATCH',
  });
  log(`set "${region.id}" as the default region of organization "${organization.name}"`);
}

async function ensureApiKey({ organization, scoped }) {
  const state = readState();
  if (state.DAYTONA_API_KEY) {
    try {
      const current = await call(`${API}/api-keys/current`, {
        headers: { authorization: `Bearer ${state.DAYTONA_API_KEY}` },
      });
      const granted = new Set(current?.permissions ?? []);
      const missing = API_KEY_PERMISSIONS.filter((permission) => !granted.has(permission));
      if (missing.length === 0) {
        log(`API key "${API_KEY_NAME}" is still valid`);
        return state.DAYTONA_API_KEY;
      }
      log(`stored API key lacks ${missing.join(', ')}; minting a new one`);
    } catch (error) {
      log(`stored API key no longer works (${error.message}); minting a new one`);
    }
  }

  // A key of that name from an earlier volume is unusable — its value was shown once — so replace it.
  await call(`${API}/api-keys/${encodeURIComponent(API_KEY_NAME)}`, {
    headers: scoped,
    method: 'DELETE',
  }).catch((error) => {
    if (error.status !== 404) throw error;
  });
  const created = await call(`${API}/api-keys`, {
    body: { name: API_KEY_NAME, permissions: API_KEY_PERMISSIONS },
    headers: scoped,
    method: 'POST',
  });
  log(`minted API key "${API_KEY_NAME}" in organization "${organization.name}"`);
  writeEnvFile(STATE_FILE, { DAYTONA_API_KEY: created.value });
  return created.value;
}

async function ensureSandbox(apiKey) {
  const headers = { authorization: `Bearer ${apiKey}` };
  const lookup = () =>
    call(`${API}/sandbox/${encodeURIComponent(SANDBOX_NAME)}`, { headers }).catch((error) => {
      if (error.status === 404) return undefined;
      throw error;
    });

  let sandbox = await lookup();
  if (!sandbox) {
    // The runner pulls the default snapshot on first boot; a sandbox cannot be created before that.
    await until(`snapshot ${SNAPSHOT} to be active`, async () => {
      const { items } = await call(`${API}/snapshots?limit=100`, { headers });
      return items.find((s) => s.name === SNAPSHOT && s.state === 'active');
    });
    sandbox = await call(`${API}/sandbox`, {
      body: { autoStopInterval: 0, name: SANDBOX_NAME, snapshot: SNAPSHOT },
      headers,
      method: 'POST',
    });
    log(`created sandbox "${SANDBOX_NAME}" (${sandbox.id})`);
  } else if (['stopped', 'archived'].includes(sandbox.state)) {
    await call(`${API}/sandbox/${sandbox.id}/start`, { headers, method: 'POST' });
    log(`starting sandbox "${SANDBOX_NAME}" (${sandbox.id}) from ${sandbox.state}`);
  }

  await until(
    `sandbox ${sandbox.id} to be started`,
    async () => {
      const current = await call(`${API}/sandbox/${sandbox.id}`, { headers });
      if (['error', 'build_failed'].includes(current.state)) {
        throw new Error(
          `sandbox ${sandbox.id} is in state ${current.state}: ${current.errorReason ?? ''}`,
        );
      }
      return current.state === 'started';
    },
    { everyMs: 3_000 },
  );
  return sandbox.id;
}

const session = await signInToOrganization();
await ensureDefaultRegion(session);
const apiKey = await ensureApiKey(session);
const sandboxId = await ensureSandbox(apiKey);

const output = {
  DAYTONA_API_URL: PUBLIC_API_URL,
  DAYTONA_API_KEY: apiKey,
  DAYTONA_TEST_SANDBOX_ID: sandboxId,
};
writeEnvFile(OUTPUT_FILE, output);
log(`ready — sandbox "${SANDBOX_NAME}" is started. Wrote ${OUTPUT_FILE}:`);
for (const [key, value] of Object.entries(output)) {
  console.log(`  ${key}=${key === 'DAYTONA_API_KEY' ? `${value.slice(0, 8)}…` : value}`);
}
