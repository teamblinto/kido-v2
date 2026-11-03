import { defineConfig } from 'vitest/config';

/**
 * Whether the coverage thresholds below are allowed to fail this run.
 *
 * They bind exactly when the integration suites were *required* to run, which is the same condition
 * `test/support/integration-guard.ts` enforces and the same variable CI sets. The coupling is not a
 * convenience — it is the only correct rule. Most of the branches in `rbac/` are reached through
 * suites that talk to Postgres and Redis, so on a laptop with no Docker those suites skip, coverage
 * drops, and a threshold that bound unconditionally would fail `pnpm check` there. The spec's
 * testing strategy promises the opposite: a green check on that machine, with a banner saying what
 * it did not prove.
 *
 * So the number is always *reported* — a developer sees it on every run — and is only *enforced*
 * where the suites behind it are known to have executed. A developer who wants the gate before
 * pushing runs `EXPECT_INTEGRATION=1 pnpm --filter @repo/api test`, which is the same command that
 * turns a skipped integration suite into a failure. The two belong together.
 */
const COVERAGE_ENFORCED = process.env.EXPECT_INTEGRATION === '1';

/** No uncovered branch, per spec 001's testing strategy. See the comment on `thresholds` below. */
const FULL_COVERAGE = {
  branches: 100,
  functions: 100,
  lines: 100,
  // Per file, so a failure names the file with the gap instead of reporting that the tree as a
  // whole is at 99.4%.
  perFile: true,
  statements: 100,
} as const;

export default defineConfig({
  test: {
    // A `.only` left in a commit silently narrows the run to one test, and every gate in this
    // repository then passes by not executing. Vitest's own default only refuses one when `CI` is
    // set; refused here as well, because the run that matters most is the one somebody does on
    // their own machine before pushing. Watch mode (`npx vitest`) is unaffected — this is the
    // `vitest run` config, and an interactive `.only` is what `.only` is for.
    allowOnly: false,
    coverage: {
      // On by default rather than behind `--coverage`. The spec's testing strategy asks for "no
      // uncovered branch in rbac/ or common/crypto/", and a threshold that only runs when somebody
      // remembers a flag is a number nobody fails on. The cost is small: the v8 provider reads the
      // engine's own counters, so there is no instrumentation pass to pay for.
      enabled: true,
      exclude: ['**/*.spec.ts'],
      // Deliberately only the two trees the spec gates. There is no repo-wide percentage target —
      // §17's answer to "is this tested?" is a named gate, not a ratio — so reporting on everything
      // would print a number with no threshold behind it, which is the thing this file is trying
      // not to do. `include` also means an *untouched* file in these trees is reported at 0% and
      // fails the gate, rather than being absent from the report and passing by omission.
      //
      // Spec 027 adds three files, not a tree: the tar reader, the artifact writer and the site-label
      // grammar. Each decides what an untrusted build output may become in the bucket or on a host,
      // and each was written test-first at 100%.
      //
      // Spec 028 adds four more, its pure primitives: the hostname normaliser (what may be claimed
      // at all), the check's state machine, its schedule and the CAA verdict. Each decides whether
      // a hostname serves or is released, and each is TDD with named tests (plan.md § Constraints).
      include: [
        'src/common/crypto/**/*.ts',
        'src/modules/rbac/**/*.ts',
        'src/modules/deploy/tar-reader.ts',
        'src/modules/deploy/artifact.ts',
        'src/modules/deploy/site-label.ts',
        'src/modules/deploy/domains/normalise-hostname.ts',
        'src/modules/deploy/domains/evaluate-check.ts',
        'src/modules/deploy/domains/check-schedule.ts',
        'src/modules/deploy/domains/caa.ts',
      ],
      // v8's own counters: no instrumentation pass, and the branch data is what the TDD-required
      // modules are judged on (spec 001, Testing strategy) rather than a line percentage.
      provider: 'v8',
      // `text` for whoever is watching the run, `json-summary` for the CI step that has to prove
      // the gate ran. The log is not enough on its own: the text reporter's table is width-derived
      // and comes out empty through a pipe, so a job that grepped it for a filename would be
      // asserting on the terminal rather than on the coverage.
      reporter: ['text', 'json-summary'],
      // Vitest withholds the report when the run failed. That is the wrong default here: the log is
      // the only artefact CI keeps, the step below reads it to prove the gate ran at all, and a
      // failing suite is exactly when somebody wants to know whether the gap is a broken test or a
      // branch nobody wrote one for.
      reportOnFailure: true,
      // The spec's requirement, exactly: no uncovered branch. The other three metrics are set to
      // 100 as well because these two trees already reach it — the policy engine and the envelope
      // are TDD-required and were written test-first — and a threshold set below what the code
      // already achieves is a ratchet that only ever turns the wrong way.
      //
      // **Never lower these to make a build pass.** An uncovered branch in `rbac/` is an
      // authorisation path nobody has exercised, and in `common/crypto/` it is a key-handling path
      // nobody has exercised. If a branch genuinely cannot be reached from a test, delete the
      // branch — that is a shorter diff than the argument for keeping it.
      //
      // `undefined` rather than lower numbers when unenforced: a threshold of 80 on a machine that
      // could not run the suites is a number that means nothing and reads like a standard.
      thresholds: COVERAGE_ENFORCED ? FULL_COVERAGE : undefined,
    },
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'],
    globals: true,
    /**
     * Vitest's defaults are 5 s per test and 10 s per hook, and both are too short for what the
     * integration suites in this workspace actually do.
     *
     * Nothing here is a unit test with a stubbed clock. `mfa.service.spec.ts` runs Argon2id at
     * 64 MB and t=3 several times per case; `no-plain-set.spec.ts` walks four directory trees of
     * the repository; every `*.e2e-spec.ts` boots a Nest application and talks to Postgres and two
     * Redis roles. On a quiet machine each finishes in well under a second, which is why the
     * defaults survived this long — but `pnpm check` runs the web suite on the other cores, and
     * under that contention all three have timed out while behaving perfectly.
     *
     * These are hang guards, not assertions: no property is relaxed by raising them, and a test
     * that genuinely deadlocks still fails within half a minute. The alternative — a per-test
     * timeout argument on each of the slow ones — puts the number in the place least likely to be
     * updated and says nothing about why. `password.e2e-spec.ts` keeps its own explicit 180 s
     * because that one really is a long measurement rather than a test absorbing noise.
     */
    hookTimeout: 60_000,
    testTimeout: 30_000,
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts', 'test/support/**/*.spec.ts'],
    restoreMocks: true,
    setupFiles: ['./test/setup-env.ts'],
  },
});
