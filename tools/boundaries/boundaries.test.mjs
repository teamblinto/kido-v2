// Proves each forbidden edge class in .dependency-cruiser.cjs (FR-002..006) by writing a one-line
// probe into the real tree, cruising that file alone, and removing it — research R4.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cruise } from 'dependency-cruiser';
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config';

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));

const WEB = 'apps/web/src/__boundary-probe__.ts';
const AGENT = 'apps/api/src/modules/agent/__boundary-probe__.ts';
const COMMON = 'apps/api/src/common/__boundary-probe__.ts';
const GATEWAY = 'apps/gateway/src/__boundary-probe__.ts';
const COMPANION = 'apps/companion/src/__boundary-probe__.ts';
const CHECKPOINTS = 'apps/api/src/modules/checkpoints/__boundary-probe__.ts';
const CONNECTORS = 'apps/api/src/modules/connectors/__boundary-probe__.ts';
const DEPLOY = 'apps/api/src/modules/deploy/__boundary-probe__.ts';
const IDENTITY = 'apps/api/src/modules/identity/__boundary-probe__.ts';
const MAIL = 'apps/api/src/modules/mail/__boundary-probe__.ts';
const RBAC = 'apps/api/src/modules/rbac/__boundary-probe__.ts';
const RBAC_REPO = 'apps/api/src/modules/rbac/__boundary-probe__.repository.ts';
const OUTBOX = 'apps/api/src/modules/outbox/__boundary-probe__.ts';
const PREVIEW = 'apps/api/src/modules/preview/__boundary-probe__.ts';
const OUTBOX_CONSUMER = 'apps/api/src/modules/outbox/__boundary-probe__.consumer.ts';
const SANDBOX = 'apps/api/src/modules/sandbox/__boundary-probe__.ts';
const TENANCY = 'apps/api/src/modules/tenancy/__boundary-probe__.ts';
const WEBHOOKS = 'apps/api/src/modules/webhooks/__boundary-probe__.ts';
// Spec 029 R1 names these two files; until they land, the probe writes a stand-in at each path.
const INBOUND_SERVICE = 'apps/api/src/modules/webhooks/inbound/inbound-delivery.service.ts';
const INBOUND_REPO = 'apps/api/src/modules/webhooks/inbound/inbound-delivery.repository.ts';

/** Cruises only `files`, the way check.mjs cruises the tree; returns the error-severity rule names. */
const cruiseOnly = async (files) => {
  const { forbidden, options } = createRequire(import.meta.url)('../../.dependency-cruiser.cjs');
  const knownViolations = JSON.parse(
    readFileSync('.dependency-cruiser-known-violations.json', 'utf8'),
  );
  const { output } = await cruise(
    files,
    {
      ...options,
      knownViolations,
      outputType: 'json',
      ruleSet: { forbidden, options },
      validate: true,
    },
    {},
    { tsConfig: extractTSConfig(options.tsConfig.fileName) },
  );
  const { violations } = JSON.parse(output).summary;
  return new Set(violations.filter((v) => v.rule.severity === 'error').map((v) => v.rule.name));
};

/** Writes each `{ path: source }`, runs `fn`, removes each probe even when `fn` throws. */
const withProbe = async (files, fn) => {
  try {
    // A module directory that exists only for the probe (connectors before spec 018 lands) is
    // created here and removed below.
    const created = Object.keys(files)
      .map(dirname)
      .filter((dir) => !existsSync(dir));
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source);
    }
    try {
      return await fn(Object.keys(files));
    } finally {
      for (const dir of created) rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    for (const path of Object.keys(files)) rmSync(path, { force: true });
  }
};

const fails = (title, files, rule) =>
  test(title, () =>
    withProbe(files, async (paths) => {
      const rules = await cruiseOnly(paths);
      assert.ok(rules.has(rule), `expected ${rule}, got ${[...rules].join(', ') || 'nothing'}`);
    }),
  );

fails(
  'web importing @repo/db fails web-imports-contracts-types-utils-only',
  { [WEB]: "import type { schema } from '@repo/db';\n" },
  'web-imports-contracts-types-utils-only',
);
fails(
  'an app importing the other app fails no-app-to-app',
  { [WEB]: "import '../../api/src/main';\n" },
  'no-app-to-app',
);
fails(
  'the gateway importing @repo/db fails gateway-imports-contracts-types-only',
  { [GATEWAY]: "import type { schema } from '@repo/db';\n" },
  'gateway-imports-contracts-types-only',
);
fails(
  // `pg` is not a gateway dependency, so from apps/gateway it is unresolvable and would fail
  // not-to-unresolvable instead — the wrong proof. `prettier` is hoisted to the root and resolves
  // from anywhere, which is exactly the transitive leak the rule refuses.
  'the gateway importing an npm package outside jose + zod fails gateway-runtime-deps',
  { [GATEWAY]: "import 'prettier';\n" },
  'gateway-runtime-deps',
);
fails(
  'the companion importing @repo/db fails companion-imports-contracts-types-only',
  { [COMPANION]: "import type { schema } from '@repo/db';\n" },
  'companion-imports-contracts-types-only',
);
fails(
  // `prettier` for the gateway probe's reason: hoisted to the root, so it resolves from here.
  'the companion importing an npm package outside zod fails companion-runtime-deps',
  { [COMPANION]: "import 'prettier';\n" },
  'companion-runtime-deps',
);
fails(
  'an app importing the companion fails no-app-to-app',
  { [WEB]: "import '../../companion/src/main';\n" },
  'no-app-to-app',
);
fails(
  'contracts importing a dev dependency at runtime fails contracts-runtime-deps',
  { 'packages/contracts/src/__boundary-probe__.ts': "import { describe } from 'vitest';\n" },
  'contracts-runtime-deps',
);
fails(
  'a shared layer importing a module fails shared-layers-never-import-modules',
  { [COMMON]: "import '../modules/mail/mail.module';\n" },
  'shared-layers-never-import-modules',
);
fails(
  "a module importing another module's repository fails no-foreign-repository",
  {
    [RBAC_REPO]: 'export const probe = 1;\n',
    [TENANCY]: "import '../rbac/__boundary-probe__.repository';\n",
  },
  'no-foreign-repository',
);
fails(
  "connectors importing checkpoints' repository fails no-foreign-repository",
  { [CONNECTORS]: "import '../checkpoints/checkpoint.repository';\n" },
  'no-foreign-repository',
);
fails(
  // Spec 026 R12 widens `connectors` by exactly one edge: `tenancy`, for project creation through
  // `ProjectService`. Everything else it did not have before, it still does not have.
  'connectors importing a module outside its edges fails module-connectors-edges',
  { [CONNECTORS]: "import '../agent/agent.module';\n" },
  'module-connectors-edges',
);
fails(
  'a module edge not in the graph fails module-mail-edges',
  { [MAIL]: "import '../identity/identity.module';\n" },
  'module-mail-edges',
);
fails(
  'a module importing outbox without an edge fails module-rbac-edges',
  // The target is a probe too: an unresolvable import fails not-to-unresolvable instead, which is
  // the wrong proof (FR-025 is about the edge, not the file). `rbac` rather than `identity`, which
  // has the edge since spec 006 — its producers append through `OutboxWriter`.
  { [OUTBOX]: 'export const probe = 1;\n', [RBAC]: "import '../outbox/__boundary-probe__';\n" },
  'module-rbac-edges',
);
fails(
  'outbox importing a module fails module-outbox-edges',
  { [OUTBOX]: "import '../identity/identity.module';\n" },
  'module-outbox-edges',
);
fails(
  // Spec 016 R4: `agent → checkpoints` is the edge; the reverse is the cycle the graph refuses.
  'checkpoints importing agent fails module-checkpoints-edges',
  { [CHECKPOINTS]: "import '../agent/agent.module';\n" },
  'module-checkpoints-edges',
);
// Spec 040: until the module lands, the probe writes a stand-in directory (withProbe removes it).
fails(
  // Spec 041 made `local-agent → sandbox` an edge (agent homes); `deploy` is still not one.
  'local-agent importing deploy fails module-local-agent-edges',
  {
    'apps/api/src/modules/local-agent/__boundary-probe__.ts': "import '../deploy/deploy.module';\n",
  },
  'module-local-agent-edges',
);
fails(
  'agent importing local-agent fails module-agent-edges',
  {
    'apps/api/src/modules/local-agent/__boundary-probe-target__.ts': 'export const probe = 1;\n',
    [AGENT]: "import '../local-agent/__boundary-probe-target__';\n",
  },
  'module-agent-edges',
);
fails(
  // Spec 017 contract § 9: `preview → tenancy` is the edge; the reverse is the cycle the graph refuses.
  'tenancy importing preview fails module-tenancy-edges',
  {
    [PREVIEW]: 'export const probe = 1;\n',
    [TENANCY]: "import '../preview/__boundary-probe__';\n",
  },
  'module-tenancy-edges',
);
fails(
  'preview importing a module outside its four edges fails module-preview-edges',
  { [PREVIEW]: "import '../agent/agent.module';\n" },
  'module-preview-edges',
);
fails(
  // Spec 011 R1: `agent/anthropic.adapter.ts` is the SDK's one importer.
  'a module file other than the Anthropic adapter importing @anthropic-ai/sdk fails anthropic.adapter-only-imports-sdk',
  { [AGENT]: "import '@anthropic-ai/sdk';\n" },
  'anthropic.adapter-only-imports-sdk',
);
fails(
  // Spec 020 R3: `agent/openai.adapter.ts` is the SDK's one importer.
  'a module file other than the OpenAI adapter importing openai fails openai.adapter-only-imports-sdk',
  { [AGENT]: "import 'openai';\n" },
  'openai.adapter-only-imports-sdk',
);
fails(
  'a consumer that imports a controller fails worker-actors-never-reach-request-facilities',
  { [OUTBOX_CONSUMER]: "import '../health/health.controller';\n" },
  'worker-actors-never-reach-request-facilities',
);

fails(
  // Spec 027 R1: `preview → deploy` is the edge (the broker route stays with the listener and the
  // signer); the reverse is the cycle the graph refuses.
  'deploy importing preview fails module-deploy-edges',
  { [DEPLOY]: "import '../preview/preview.module';\n" },
  'module-deploy-edges',
);
fails(
  // Spec 027 R1: a deployment builds a checkpoint; it never reaches a connector.
  'deploy importing connectors fails module-deploy-edges',
  { [DEPLOY]: "import '../connectors/connectors.module';\n" },
  'module-deploy-edges',
);
fails(
  // Spec 027 R1: `deploy → checkpoints` is an edge, but only to its exported services.
  "deploy importing checkpoints' repository fails no-foreign-repository",
  { [DEPLOY]: "import '../checkpoints/checkpoint.repository';\n" },
  'no-foreign-repository',
);

// Spec 028 R1, R14: a domain's notices are mailed through the `Mailer` port — the one edge 028 adds.
test('deploy importing the mailer port passes module-deploy-edges', () =>
  withProbe({ [DEPLOY]: "import '../mail/mailer.port';\n" }, async (paths) =>
    assert.deepEqual(await cruiseOnly(paths), new Set()),
  ));

// Spec 027 R1: the broker route that answers the gateway for a site lives in `preview` and reads
// the release through an exported `deploy` service — the one new edge into `deploy`.
test('preview importing deploy passes module-preview-edges', () =>
  withProbe(
    {
      [DEPLOY]: 'export const probe = 1;\n',
      [PREVIEW]: "import '../deploy/__boundary-probe__';\n",
    },
    async (paths) => assert.deepEqual(await cruiseOnly(paths), new Set()),
  ));

// Spec 026 R12: the other half of the probe above — the one edge that was added is permitted.
test('connectors importing tenancy passes module-connectors-edges', () =>
  withProbe({ [CONNECTORS]: "import '../tenancy/tenancy.module';\n" }, async (paths) =>
    assert.deepEqual(await cruiseOnly(paths), new Set()),
  ));

// Spec 029 R1: `connectors → webhooks` is the one new edge, through the inbound service only.
// The module probe rides along so a `webhooks/` directory made only for the stand-in is removed.
const orStandIn = (path) => ({
  [WEBHOOKS]: 'export const probe = 1;\n',
  ...(existsSync(path) ? {} : { [path]: 'export const probe = 1;\n' }),
});
test('connectors importing the inbound delivery service passes module-connectors-edges', () =>
  withProbe(
    {
      ...orStandIn(INBOUND_SERVICE),
      [CONNECTORS]: "import '../webhooks/inbound/inbound-delivery.service';\n",
    },
    async (paths) => assert.deepEqual(await cruiseOnly(paths), new Set()),
  ));
test('connectors importing the inbound delivery repository fails no-foreign-repository', () =>
  withProbe(
    {
      ...orStandIn(INBOUND_REPO),
      [CONNECTORS]: "import '../webhooks/inbound/inbound-delivery.repository';\n",
    },
    async (paths) => {
      const rules = await cruiseOnly(paths);
      assert.ok(rules.has('no-foreign-repository'), `got ${[...rules].join(', ') || 'nothing'}`);
    },
  ));
fails(
  // Spec 029 R1: the reverse of the edge above is the cycle the graph refuses.
  'webhooks importing connectors fails module-webhooks-edges',
  { [WEBHOOKS]: "import '../connectors/connectors.module';\n" },
  'module-webhooks-edges',
);

test("an edge in the graph and a module's own repository pass", () =>
  withProbe(
    {
      [RBAC_REPO]: 'export const probe = 1;\n',
      [RBAC]: "import './__boundary-probe__.repository';\n",
      [TENANCY]: "import '../rbac/rbac.module';\n",
    },
    async (paths) => assert.deepEqual(await cruiseOnly(paths), new Set()),
  ));

test('a known-violation entry whose edge no longer exists fails as stale', () => {
  const check = (env) =>
    spawnSync(process.execPath, ['tools/boundaries/check.mjs'], { encoding: 'utf8', env });
  const known = JSON.parse(readFileSync('.dependency-cruiser-known-violations.json', 'utf8'));
  const stale = { ...known[0], from: 'apps/api/src/common/clock/clock.port.ts' };
  const copy = 'tools/boundaries/__stale-known-violations__.json';
  assert.equal(check(process.env).status, 0);
  return withProbe({ [copy]: JSON.stringify([...known, stale]) }, () => {
    const { status, stdout } = check({ ...process.env, BOUNDARIES_KNOWN_VIOLATIONS: copy });
    assert.notEqual(status, 0);
    assert.ok(stdout.includes('Stale known violation: apps/api/src/common/clock/clock.port.ts'));
  });
});

test('no probe file is left in the tree', () => {
  const skip = (path) => /(^|[\\/])(node_modules|dist)$/.test(path);
  assert.deepEqual(globSync('{apps,packages}/**/*__boundary-probe__*', { exclude: skip }), []);
});

// Spec 030 contracts/provider-adapters.md § 8: `connectors → deploy` is the one new edge, and the
// reverse (and `sandbox → connectors`, where the preview env source is a port) is refused.
test('connectors importing deploy passes module-connectors-edges', () =>
  withProbe(
    {
      [DEPLOY]: 'export const probe = 1;\n',
      [CONNECTORS]: "import '../deploy/__boundary-probe__';\n",
    },
    async (paths) => assert.deepEqual(await cruiseOnly(paths), new Set()),
  ));
fails(
  'deploy importing connectors fails module-deploy-edges',
  { [DEPLOY]: "import '../connectors/connectors.module';\n" },
  'module-deploy-edges',
);
fails(
  'sandbox importing connectors fails module-sandbox-edges',
  { [SANDBOX]: "import '../connectors/connectors.module';\n" },
  'module-sandbox-edges',
);
