<!--
Sync Impact Report
- Version change: 1.0.0 → 1.1.0 (MINOR: Principle I materially widened — a new [E] rule for the
  API's module-to-module edges, shared layers and repositories, enforced by spec 004's gate)
- Modified principles: I. Package boundaries are a security boundary — bullets 1–2 now cite
  `.dependency-cruiser.cjs` and the ci.yml step "Check module boundaries" as the enforcing
  source; one [E] bullet added for API module edges, shared layers, foreign repositories and the
  known-violations list. Development Workflow: the merge-gate line gains `boundaries` between
  `lint` and `typecheck`.
- Added sections: none
- Removed sections: none
- Templates: .specify/templates/plan-template.md, spec-template.md, tasks-template.md,
  checklist-template.md read this file at runtime and were not modified.
- Follow-up TODOs: none. Spec 004 FR-016 called this a PATCH; it became MINOR because a rule was
  added, not only re-cited (spec 004 § Assumptions).
- Previous report (1.0.0): first ratification; all five template slots filled; Core Principles
  I–VII, Security and Tenancy Constraints, Development Workflow and Quality Gates, Governance
  added. create-new-feature.ps1 was repointed to `docs/specs/` and counts the existing
  `NNN-slug.md` files when numbering, so features 003+ continue the same sequence.
-->

# BAIOS Constitution

Every rule below cites the file that already enforces or states it. Rules marked **[E]** are
explicit — enforced by code, config, a test, or CI — and use MUST. Rules marked **[I]** are
inferred from a consistent pattern that nothing mechanically enforces, and use SHOULD.
Source ranking: `docs/codebase-analysis.md` → `docs/adr/` → `docs/architecture.html` →
`docs/specs/` → `.github/workflows/ci.yml` → `package.json`, `turbo.json`, ESLint/tsconfig.

## Core Principles

### I. Package boundaries are a security boundary

- `@repo/db` MUST NOT be a dependency of `@repo/web` or of any shared package **[E]** —
  `.dependency-cruiser.cjs` rules `web-imports-contracts-types-utils-only`, `no-package-to-app`,
  `no-package-to-package`, run by the `ci.yml` step "Check module boundaries";
  `docs/specs/001-authentication.md` § Boundaries / Never; `docs/codebase-analysis.md` §2.4.
- `@repo/contracts` is the only package both apps import; it MUST depend on `zod` alone, and
  `@repo/db` on `drizzle-orm` + `pg` alone **[E]** — `.dependency-cruiser.cjs` rules
  `contracts-runtime-deps`, `db-runtime-deps`, `types-runtime-deps`, `utils-runtime-deps`, run by
  the `ci.yml` step "Check module boundaries"; §2.4.
- API domain modules import each other only along the edges listed in `.dependency-cruiser.cjs`
  (`moduleEdges`); `common/`, `config/` and `database/` MUST NOT import a module; a module MUST
  NOT import another module's `*.repository.*`; known exceptions live in
  `.dependency-cruiser-known-violations.json`, each with an issue **[E]** —
  `tools/boundaries/check.mjs` (fails on a new edge and on a stale exception),
  `tools/boundaries/boundaries.test.mjs` (a probe per forbidden class); §02; ADR 028.
- Every dependency version lives in `pnpm-workspace.yaml` `catalog:`; manifests reference
  `catalog:` and internal packages use `workspace:*`; the root `package.json` MUST NOT hoist app
  dependencies **[E]** — §4.1, §4.4, `.npmrc` (`save-exact`, `strict-peer-dependencies`).
- Any new runtime dependency is an **ask-first** item **[E]** — spec 001 § Boundaries / Ask first.
- Library packages (`contracts`, `db`, `types`, `utils`) SHOULD keep the tsup dual ESM/CJS shape
  with an explicit `exports` map; config packages have no build step **[I]** — §2.3.

### II. Contracts first: one schema, both sides of the wire

- Every request/response shape MUST be a Zod schema in `packages/contracts`; the API validates
  through `createZodDto` + the global `ZodValidationPipe`, and `class-validator` is banned **[E]** —
  ADR 006; `docs/codebase-analysis.md` §9.1–9.2.
- Request schemas MUST be `z.strictObject` (undeclared key → 422 `validation-failed`) **[E]** — §9.3.
- DTOs MUST be `class X extends createZodDto(schema)` and carry `@ApiZodSchema()` **[E]** — §9.2, §9.5.
- `packages/contracts/src/index.ts` MUST NOT use `export *` **[E]** — §9.6.
- The web client MUST parse every response through its contract schema (`apiRequest` requires
  `schema`) **[E]** — `apps/web/src/lib/api/client.ts`; §9.7.
- Every error MUST leave the API as an RFC 9457 problem document via `ProblemDetailsFilter`, with
  a slug from the frozen `PROBLEM_TYPES` catalogue; controllers never build error bodies **[E]** —
  §10.1–10.3, ADR 010. Adding a slug to the contract MUST come with a user-facing sentence in
  `apps/web/src/lib/api/problem.ts` (`MESSAGES` is exhaustive) **[E]** — §10.8.
- Routes are `/api/v1/...`; tenant-scoped routes MUST carry `:orgId` in the path **[E]** — §8.6.

### III. Secure by default: global guards, explicit opt-outs

- Authentication, step-up, permission, CSRF, idempotency, tenant transaction and validation are
  registered application-wide (`APP_GUARD` / `APP_INTERCEPTOR` / middleware / global pipe); a route
  opts **out** with `@Public()` etc., never opts in **[E]** — §8.2. The only per-route guard is
  `TurnstileGuard` **[E]** — ADR 021.
- Guard order `SessionGuard → StepUpGuard → RequirePermissionGuard` is asserted by
  `identity.module.spec.ts` and `rbac.module.spec.ts` and MUST NOT be reordered **[E]** — §8.1.
- Ports and adapters for anything external; adapters are named for the vendor; the clock is
  injected (`ClockPort`) and services MUST NOT call `new Date()` **[E]** — spec 001 § Code style;
  §8.3–8.4.
- Where two failure modes differ only in information the caller is not entitled to, they MUST
  collapse to one message (session, CSRF, permission denial, login, reset) **[E]** — §10.7.

### IV. Auth and session rules (spec 001, §11)

- The browser session is an opaque 32-byte token in Redis, never a JWT **[E]** — ADR 001.
- Cookie name MUST start with `__Host-`; `httpOnly`, `secure`, `sameSite: 'lax'`, `path: '/'`,
  no `Domain`; there is no `COOKIE_SECURE` switch and none may be added **[E]** — §14.2, §25.5.
- Native Nest guards, not Passport; the principal rides on the `AUTHENTICATED_USER` symbol, never
  `req.user` **[E]** — ADR 002.
- Unsafe methods MUST pass **both** the CSRF double-submit and an allowed `Origin`; safe methods
  are an allowlist; exempt paths are exact matches **[E]** — §14.7.
- Argon2id ≥ 64 MB / t=3 / p=1 outside `DEPLOY_ENV=local`; the env KEK provider is refused
  outside `local` **[E]** — ADR 003, ADR 009, `apps/api/src/config/environment.ts`.
- Secrets never reach a `toJSON`; only `fingerprint()` / `lastFour()` leave the API; no password,
  session token, DEK, MFA seed or reset token may be logged at any level **[E]** — spec 001
  § Boundaries / Never; §16.3; `test/log-redaction.e2e-spec.ts`.
- Any deviation from §11 (hash parameters, cookie attributes, session-not-JWT, role model) is
  **ask first** **[E]** — spec 001 § Boundaries.

### V. Tenant isolation is enforced by the database

- Three independent layers: `@RequirePermission()` guard, an explicit service check, and RLS
  underneath both **[E]** — §13.1.
- Tenant context MUST be `set_config('app.org_id', $1, true)` inside the request transaction;
  a session-scoped `SET` anywhere in `.ts` or `.sql` fails `no-plain-set.spec.ts` **[E]** — ADR 005.
- The org MUST be derived from the resource in the path (`@ResourceOrg()`), never from a header
  or body; a `@RequirePermission()` route without `@ResourceOrg()` is refused **[E]** — §13.6.
- Every tenant-owned table MUST declare `unique (org_id, id)` and composite FKs on
  `(org_id, <child_id>)`; RLS MUST be `ENABLE` + `FORCE` with both `USING` and `WITH CHECK` **[E]**
  — §12.4, §13.5, `packages/db/src/schema/rls.spec.ts`.
- Containers get `deleted_at`; access grants are hard-deleted **[E]** — ADR 012, ADR 017.
- `audit_log` is append-only by grant (no `UPDATE`/`DELETE`); security-relevant mutations are
  audited in the same transaction; after-commit hooks run DB first, Redis second, and their
  failures are not caught **[E]** — §12.8, §13.4, spec 001 § Boundaries / Always.

### VI. Tests prove it, and CI proves the tests ran

- TDD is mandatory for: `rbac/resolver.ts`, `rbac/permission-cache.ts`, `identity/password/`,
  `common/crypto/`, `common/errors/`, `common/idempotency/`, `mfa.service.ts`, token
  issuance/consumption **[E]** — spec 001 § Testing strategy.
- Colocation: `*.spec.ts` beside the unit (API, packages), `*.test.ts(x)` in web,
  `*.e2e-spec.ts` in `apps/api/test/` **[E]** — `vitest.config.mts` `include`.
- 100% statements/branches/functions/lines on `src/common/crypto/**` and `src/modules/rbac/**`,
  binding when `EXPECT_INTEGRATION=1`; **never lower to make a build pass** — delete the
  unreachable branch instead **[E]** — `apps/api/vitest.config.mts`, ADR 022.
- `allowOnly: false`; no `describe.skip`, `.only`, or constant `.skipIf(true)` — the tree scanner
  fails the run **[E]** — §22.4, §22.6.
- Integration suites skip **loudly** without Docker; CI runs with `EXPECT_INTEGRATION=1` and
  fails on the `SKIPPING` banner **[E]** — `.github/workflows/ci.yml` steps "Refuse a silently
  skipped integration suite", "Refuse a run that measured no coverage".
- Never weaken a test to make it pass or delete a failing test without approval; never silently
  stub a requirement **[E]** — spec 001 § Boundaries / Never.
- Web tests intercept at the request layer with MSW (`onUnhandledRequest: 'error'`), answering
  with contract-valid bodies **[E]** — §22.9.

### VII. Decisions and specs are written down where they are cited

- `docs/architecture.html` is the authority, cited by `§NN`; it is Prettier-ignored and any
  change to it is **ask first** **[E]** — spec 001 § Boundaries; `.prettierignore`.
- Every decision with more than one defensible answer gets an ADR at `docs/adr/NNN-slug.md` with
  the shape `# NNN · Title` / `**Status**` / `**Context**` / Decision / Consequences **[E]** —
  spec 001 criterion 22; §27.1.
- A finished feature spec is persisted as `docs/specs/NNN-slug.md` and MUST open with `**Status**`
  (with date), `**Architecture reference**` (§ list), `**Depends on**`/`**Supersedes**`, and MUST
  close with a success-criteria matrix naming the test (exact `it(...)` title) that proves each
  row; an unproved criterion is marked ✗ with the reason, not smoothed over **[E]** —
  `docs/specs/001-authentication.md`, `002-web-api-integration.md`.
- Spec Kit features live at `docs/specs/<NNN-slug>/` (spec.md, plan.md, tasks.md), numbered in
  the same sequence as the pre-Spec-Kit `docs/specs/NNN-slug.md` files — one directory, one
  sequence **[E]** — `.specify/scripts/powershell/create-new-feature.ps1`.
- Comments state what was rejected and why, not what the code does **[I]** — §27.3.

## Security and Tenancy Constraints

- Configuration MUST pass the Zod environment schema at boot; `DEPLOY_ENV` is required and
  separate from `NODE_ENV` **[E]** — ADR 009, §25.1–25.3.
- Never commit a real secret; `.env.example` carries placeholders only; never put a secret in a
  `VITE_*` variable **[E]** — spec 001 § Boundaries / Never; `README.md`.
- Trusted proxy hops, `PROBLEM_TYPE_BASE_URI`, and cookie `Secure` are constants, not
  configuration **[E]** — §25.5.
- Cache keys go through `OrgCacheKey.build()`; `OrgCache.set()` requires a TTL; an invalidation
  failure propagates **[E]** — ADR 018, §15.4, §17.2.
- Failure-mode asymmetry is decided and stated beside the code: breach check fails open
  (ADR 008), Turnstile fails closed (ADR 021), cache reads degrade, cache invalidation throws **[E]**.
- Adding a service to `compose.yaml` beyond Postgres and the two Redis instances is **ask first**
  **[E]** — spec 001 § Boundaries.

## Development Workflow and Quality Gates

- The merge gate is `.github/workflows/ci.yml`, mirrored locally by `pnpm check` =
  `format:check && lint && boundaries && typecheck && test && build` in that order **[E]** —
  `package.json`.
  CI additionally runs `db:migrate` from empty first, and `TURBO_FORCE=true` on the test step only
  **[E]** — ADR 014.
- Lint is type-aware (`recommendedTypeChecked` + `stylisticTypeChecked`); inline type imports;
  `_`-prefixed unused args **[E]** — `packages/eslint-config/base.mjs`. TS is `strict` +
  `noUncheckedIndexedAccess` + `noImplicitReturns` + `noImplicitOverride` **[E]** —
  `packages/typescript-config/base.json`.
- Style: 100-column Prettier, single quotes, trailing commas, explicit return types,
  alphabetically-ordered object literals and decorator options, kebab-case filenames, `node:`
  protocol on builtins, LF line endings **[E]** — spec 001 § Code style; `.gitattributes`;
  `packages/prettier-config`.
- Migration policy: schema changes go through `pnpm --filter @repo/db db:generate`; policies,
  grants and anything drizzle-kit cannot diff are hand-written SQL migrations named for what they
  do and opened with a rationale block; table grants live in migrations, not `init-roles.sql`
  **[E]** — §12.6–12.7. Migrations MUST apply from empty (CI does exactly that) **[E]**.
- Conventional commits, small and individually green **[E]** — spec 001 § Boundaries / Always.
  Subjects SHOULD be declarative sentences describing the resulting state **[I]** — §26.1.
- Import order (node → external → `@repo/*` → relative) SHOULD be kept by hand; nothing lints it
  **[I]** — §29.4.
- `apps/web` has no coverage threshold and the ~90% of `apps/api/src` outside the two named trees
  has no floor **[E]** — §31; this is a known gap, not a licence.

## Governance

- This constitution restates enforced rules; it does not create new ones. Where it disagrees
  with `docs/architecture.html`, an ADR, or a CI step, the cited source wins and this file is
  amended.
- Amendment: a PR that changes the rule at its source (code, config, CI, ADR) and updates the
  citation here in the same change. A new **[E]** rule requires the enforcing test or CI step to
  land with it; an **[I]** rule may be promoted to **[E]** only when something mechanical enforces
  it.
- Versioning: MAJOR for removing or redefining a principle; MINOR for adding a principle or
  materially widening one; PATCH for wording and citation fixes.
- Compliance review: `/speckit-plan` and `/speckit-analyze` check a feature against Principles
  I–VII; every spec's success-criteria matrix is the compliance record for Principle VI.

**Version**: 1.1.0 | **Ratified**: 2026-09-13 | **Last Amended**: 2026-09-13
