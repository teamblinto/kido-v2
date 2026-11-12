// The allowed-edge graph: who may import whom across apps, packages, the API's shared layers and
// its domain modules (architecture §02; constitution I). `pnpm boundaries` cruises the tree from
// source against these rules (tools/boundaries/check.mjs, then the probes in
// tools/boundaries/boundaries.test.mjs); a forbidden edge fails the merge gate between lint and
// typecheck. To answer "may X import Y?", find X's rule: apps in the first three rules (and the
// gateway's runtime allowlist beside them), packages in
// `libraryRuntime`, API modules in the `moduleEdges` table.
//
// Adding an edge (spec 004, contracts/boundaries-command.md § Changing the graph):
//   1. Add it to the module's `allowed` list here, or add a rule.
//   2. `pnpm boundaries` green locally.
//   3. The PR diff shows the graph change beside the import that needed it. That is the point.
//
// Do not put `node_modules` in `options.exclude`: it drops every npm edge, and the runtime
//   allowlists go green while checking nothing (`doNotFollow` keeps the edge) — research R4.
// Do not exclude an unanchored `dist`: packages whose entry lives under a dist/ (vitest, and every
//   `@repo/*` once built) vanish from the graph too — research R4.
// Do not add to .dependency-cruiser-known-violations.json by hand, add `severity: 'warn'`, or put
//   an `if` or env check on the CI step — FR-008.

/** Test files may reach across module and layer lines to set up a scenario (FR-007). */
const TESTS = String.raw`(\.(e2e-)?spec\.ts|\.test\.tsx?)$|^apps/api/test/|^apps/web/src/test/`;
const MOD = 'apps/api/src/modules';
const NPM = ['npm', 'npm-dev', 'npm-peer', 'npm-optional', 'npm-no-pkg', 'npm-unknown'];

/** A domain module may import itself and the listed modules; every other module edge fails. */
const moduleEdges = (name, allowed) => ({
  comment: `§02: ${name} may import ${allowed.length ? allowed.join(', ') : 'no other module'} — add an edge here, reviewed, or use the module's service interface / a domain event.`,
  from: { path: `^${MOD}/${name}/`, pathNot: TESTS },
  name: `module-${name}-edges`,
  severity: 'error',
  to: { path: `^${MOD}/`, pathNot: `^${MOD}/(${[name, ...allowed].join('|')})/` },
});

/** A library package's runtime code may import only the listed npm packages (and their @types). */
const libraryRuntime = (name, allowed) => ({
  comment: `constitution I: @repo/${name} depends on ${allowed.length ? allowed.join(' + ') : 'nothing'} at runtime; anything else is a new runtime dependency of both apps.`,
  from: { path: `^packages/${name}/src/`, pathNot: TESTS },
  name: `${name}-runtime-deps`,
  severity: 'error',
  to: {
    dependencyTypes: NPM,
    pathNot: allowed.length ? `node_modules/(@types/)?(${allowed.join('|')})/` : '^$',
  },
});

// Known violations — .dependency-cruiser-known-violations.json (generated, never hand-edited), one
// line per entry. Both are layering inversions under shared-layers-never-import-modules:
//   apps/api/src/common/idempotency/idempotency.interceptor.ts
//     → apps/api/src/modules/identity/services/session.service.ts · issue #22 · the interceptor
//     keys idempotency records to the principal, whose symbol and type live in identity; hoisting
//     them to common/ is a src/ change spec 004 forbids.
//   apps/api/src/database/database.module.ts
//     → apps/api/src/modules/rbac/resource-org.resolver.ts · issue #23 · the tenant-transaction
//     middleware asks the RBAC resolver which org a request belongs to (@ResourceOrg(),
//     constitution V); a shared concern that happens to live in rbac.

module.exports = {
  forbidden: [
    {
      comment:
        'constitution I: @repo/db is never a dependency of the web app; the browser talks to the API through @repo/contracts.',
      from: { path: '^apps/web/src/' },
      name: 'web-imports-contracts-types-utils-only',
      severity: 'error',
      to: { path: '^packages/', pathNot: '^packages/(contracts|types|utils)/' },
    },
    {
      comment:
        'constitution I: the API imports @repo/contracts, @repo/db and @repo/types; @repo/utils is browser-side.',
      from: { path: '^apps/api/(src|test)/' },
      name: 'api-imports-contracts-db-types-only',
      severity: 'error',
      to: { path: '^packages/', pathNot: '^packages/(contracts|db|types)/' },
    },
    {
      comment:
        'spec 017 FR-006 (R1, R15): the gateway holds no database credential, so it imports @repo/contracts and @repo/types and nothing else from packages/.',
      from: { path: '^apps/gateway/(src|test)/' },
      name: 'gateway-imports-contracts-types-only',
      severity: 'error',
      to: { path: '^packages/', pathNot: '^packages/(contracts|types)/' },
    },
    {
      comment:
        'spec 017 FR-006 (R15): the gateway links jose and zod at runtime; pg, ioredis, drizzle-orm and any future connector cannot reach its node, even transitively.',
      from: { path: '^apps/gateway/src/', pathNot: TESTS },
      name: 'gateway-runtime-deps',
      severity: 'error',
      to: { dependencyTypes: NPM, pathNot: 'node_modules/(@types/)?(jose|zod)/' },
    },
    {
      comment:
        "spec 041: the companion is the runner BAIOS uploads into a person's agent home; it holds no server credential, so it imports @repo/contracts and @repo/types and nothing else from packages/.",
      from: { path: '^apps/companion/(src|test)/' },
      name: 'companion-imports-contracts-types-only',
      severity: 'error',
      to: { path: '^packages/', pathNot: '^packages/(contracts|types)/' },
    },
    {
      comment:
        'spec 041: the runner bundle links zod and node builtins at runtime and nothing else, so what ships into an agent home stays auditable.',
      from: { path: '^apps/companion/src/', pathNot: TESTS },
      name: 'companion-runtime-deps',
      severity: 'error',
      to: { dependencyTypes: NPM, pathNot: 'node_modules/(@types/)?zod/' },
    },
    {
      // `$1` covers apps/gateway too: it may not import apps/api (017 R1). And apps/companion:
      // it imports no app, and no app imports it (040 § 7).
      comment: '§02: apps share code through packages/, never by importing each other.',
      from: { path: '^apps/([^/]+)/' },
      name: 'no-app-to-app',
      severity: 'error',
      to: { path: '^apps/', pathNot: '^apps/$1/' },
    },
    {
      comment: '§02: a package that imports an app is not a package; the edge only points down.',
      from: { path: '^packages/[^/]+/src/' },
      name: 'no-package-to-app',
      severity: 'error',
      to: { path: '^apps/' },
    },
    {
      comment:
        'constitution I: shared packages do not depend on each other (and never on @repo/db), so each stays importable alone.',
      from: { path: '^packages/([^/]+)/src/' },
      name: 'no-package-to-package',
      severity: 'error',
      to: { path: '^packages/', pathNot: '^packages/$1/' },
    },
    libraryRuntime('contracts', ['zod']),
    libraryRuntime('db', ['drizzle-orm', 'pg']),
    libraryRuntime('types', []),
    libraryRuntime('utils', []),
    {
      comment:
        '§02: common/, config/ and database/ sit below the domain modules; the reverse edge is a layering inversion (FR-004).',
      from: { path: '^apps/api/src/(common|config|database)/', pathNot: TESTS },
      name: 'shared-layers-never-import-modules',
      severity: 'error',
      to: { path: `^${MOD}/` },
    },
    {
      comment:
        "§02: a module never imports another module's repository or touches its tables; go through its service interface (FR-005).",
      from: { path: `^${MOD}/([^/]+)/`, pathNot: TESTS },
      name: 'no-foreign-repository',
      severity: 'error',
      to: { path: `^${MOD}/.+\.repository\.`, pathNot: `^${MOD}/$1/` },
    },
    ...[
      ['@anthropic-ai/sdk', 'anthropic.adapter'],
      ['openai', 'openai.adapter'],
    ].map(([pkg, file]) => ({
      comment: `spec 011 R1 / 020 R3: ${pkg} is reached through ${MOD}/agent/${file}.ts alone; every other consumer goes through the LlmProvider port.`,
      from: { path: '^apps/api/src/', pathNot: [TESTS, `^${MOD}/agent/${file}\\.ts$`] },
      name: `${file}-only-imports-sdk`,
      severity: 'error',
      to: { path: `node_modules/${pkg}/` },
    })),
    // `identity` for `@CurrentUser()` on the run routes, as `tenancy` has it (spec 008).
    // `mail` for the BYOS account notice (032 R1): the module's mail stays next to the module, the
    // edge `identity`, `tenancy` and `webhooks` already have.
    moduleEdges('agent', [
      'audit',
      'checkpoints',
      'identity',
      'mail',
      'outbox',
      'rbac',
      'sandbox',
      'tenancy',
    ]),
    moduleEdges('audit', []),
    // `agent → checkpoints` is the turn-end commit; the reverse would be a cycle, so the revert
    // reads `agent_runs` through the shared schema instead (spec 016 R4). `rbac` for the route
    // decorators, as every tenant-scoped controller has it; `identity` for `@CurrentUser()` on
    // the revert route, as `agent` has it for the run routes.
    moduleEdges('checkpoints', ['sandbox', 'outbox', 'audit', 'rbac', 'identity']),
    // Spec 026 R12: import creates the project, so `connectors → tenancy` is the one new edge —
    // through `ProjectService`, never `projects`' repository (no-foreign-repository still holds).
    moduleEdges('connectors', [
      'checkpoints',
      'sandbox',
      'tenancy',
      'outbox',
      'audit',
      'rbac',
      'identity',
      // Spec 029 R1: the GitHub inbound route records its delivery through `webhooks/inbound`'s
      // exported service, never its repository.
      'webhooks',
      // Spec 030 contracts/provider-adapters.md § 8: a Netlify publish reads the release through
      // `deploy`'s exported `ReleaseReader`, the Cloudflare write its `DomainRecordsReader`. The
      // reverse edge never exists: `deploy` and `sandbox` do not import `connectors`.
      'deploy',
    ]),
    // Spec 027 R1: a deployment builds a checkpoint's bundle (`checkpoints`) in a build sandbox
    // (`sandbox`), for a project row (`tenancy`), re-checking the go-live permission (`rbac`). Each
    // through an exported service, never a repository. `outbox`, `audit` and `identity` as every
    // tenant-scoped producer with routes has them. Nothing here reaches `preview`: the broker route
    // that answers the gateway for a site stays with the listener and the signer. Spec 028 R1, R14:
    // custom domains live in `deploy/domains/` and mail their notices through the `Mailer` port
    // (`mail`), the one edge 028 adds.
    moduleEdges('deploy', [
      'audit',
      'checkpoints',
      'identity',
      'mail',
      'outbox',
      'rbac',
      'sandbox',
      'tenancy',
    ]),
    moduleEdges('health', ['identity']),
    moduleEdges('identity', ['mail', 'outbox']),
    // Spec 040 § 3 (local devices retired by 041; the runner wire remains): the module registers its
    // executor with `agent` (the run port, the run store's exported services), sits behind session
    // and step-up (`identity`, `rbac`, `tenancy`), and audits (`audit`, `outbox`). The reverse edge
    // is refused: `agent` selects the executor through a registry it exports, so it never imports
    // this module and the graph stays acyclic, as `agent → checkpoints` does. `mail` is sent
    // through the outbox as the BYOS notice is. This is an allowlist; edges the API no longer uses
    // after the local-device removal can be dropped once that work lands.
    // Spec 041 adds `sandbox`: a person's agent home is a Daytona sandbox created from the
    // `agent-home` system template, through `SandboxModule`'s exported `DaytonaAdapter` and
    // `TemplateVersions` (never its repository). The reverse edge is refused: `sandbox` knows
    // nothing of homes, and its reconciler leaves them alone (they carry no `forge.owner` label).
    moduleEdges('local-agent', ['agent', 'audit', 'identity', 'rbac', 'sandbox', 'tenancy']),
    // Spec 046: the MCP surface calls the product's services; nothing imports it back.
    moduleEdges('mcp', [
      'agent',
      'audit',
      'checkpoints',
      'connectors',
      'deploy',
      'identity',
      'preview',
      'rbac',
      'sandbox',
      'tenancy',
    ]),
    moduleEdges('mail', []),
    moduleEdges('outbox', []),
    // Spec 017 contract § 9: the four edges the route broker needs; `tenancy → preview` is not
    // one, so rotation reaches this module as an outbox event and the graph stays acyclic. `rbac`
    // for the route decorators on `PreviewController`, as every tenant-scoped controller has it;
    // `identity` for `@CurrentUser()` on `preview/authorize`, as `agent` and `checkpoints` have it.
    //
    // Spec 027 R1 adds `deploy`: the broker route for a site stays with the listener and the signer
    // in this module, and reads the release through `deploy`'s exported `SiteRouteService`. The
    // reverse edge is refused, so the signer is never exported.
    moduleEdges('preview', ['sandbox', 'tenancy', 'outbox', 'audit', 'rbac', 'identity', 'deploy']),
    moduleEdges('rbac', ['identity']),
    // Spec 022 gives sandbox its first tenant-scoped controller (`FilesController`), so it needs
    // `rbac` for the route decorators, as every tenant-scoped controller has it. The templates
    // route is deployment-wide and is why this edge was not needed before.
    moduleEdges('sandbox', ['tenancy', 'audit', 'outbox', 'rbac']),
    moduleEdges('tenancy', ['identity', 'rbac', 'audit', 'mail', 'outbox']),
    // Spec 029 R1: endpoints are tenant-owned (`tenancy`), managed behind route decorators (`rbac`,
    // `identity`), audited (`audit`), fed by domain events (`outbox`) and notify owners on a pause
    // (`mail`). Never `connectors`: that edge runs the other way, for inbound deliveries.
    moduleEdges('webhooks', ['audit', 'identity', 'mail', 'outbox', 'rbac', 'tenancy']),
    ...[
      {
        // `local-agent` (spec 040): its executor runs in the `agent` profile beside these.
        path: `^${MOD}/(agent|sandbox|outbox|local-agent)/`,
        pathNot: `controllers/|dto/|\\.module\\.ts$|${TESTS}`,
      },
      { path: `^${MOD}/.+\\.consumer\\.ts$`, pathNot: TESTS },
    ].map((from) => ({
      comment:
        'ADR 026 (spec 013 R9): what a standalone worker runs — the actors under agent, sandbox, outbox and every consumer — never reaches a controller, a DTO, CSRF, idempotency, bootstrap or Express; that is the 013 blocker as a build failure. The one root module registers controllers for every profile (R2), so the module files themselves are the seam and are exempt.',
      from,
      name: 'worker-actors-never-reach-request-facilities',
      severity: 'error',
      to: {
        path: [
          '^apps/api/src/(modules/[^/]+/(controllers|dto)/|.*\\.controller\\.ts$|common/(csrf|idempotency)/|bootstrap\\.ts)',
          'node_modules/(express|@nestjs/platform-express|@nestjs/swagger)/',
        ],
      },
    })),
    {
      comment:
        'FR-010: an import the tool cannot resolve is an edge it cannot check, so it fails rather than passes.',
      from: {},
      name: 'not-to-unresolvable',
      severity: 'error',
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // The tool's defaults ignore `exports` maps and omit `.d.ts`, which leaves exports-only
    // packages (@vitejs/plugin-react, typescript-eslint) and `vite/client` unresolvable.
    enhancedResolveOptions: {
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      exportsFields: ['exports'],
      extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.d.ts'],
    },
    // Only workspace build outputs — see the "do not" lines at the head of this file.
    exclude: {
      // The template scaffolds are shipped as files, not compiled: their imports resolve inside a
      // sandbox, never here (015 R2).
      path: '^(apps|packages)/[^/]+/(dist|coverage)/|^apps/api/templates/[^/]+/files/',
    },
    tsConfig: { fileName: 'tsconfig.boundaries.json' },
    tsPreCompilationDeps: true,
  },
};
