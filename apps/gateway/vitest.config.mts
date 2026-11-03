import { defineConfig } from 'vitest/config';

/**
 * Enforced exactly when the integration suites were required to run — the same variable CI sets
 * and the same rule as `apps/api/vitest.config.mts` (see the comment there). The number is always
 * reported; it only fails the run where the suites behind it are known to have executed.
 */
const COVERAGE_ENFORCED = process.env.EXPECT_INTEGRATION === '1';

/** No uncovered branch in the files that decide whether, and what, to dial or serve (T053, spec 027). */
const FULL_COVERAGE = {
  branches: 100,
  functions: 100,
  lines: 100,
  perFile: true,
  statements: 100,
} as const;

export default defineConfig({
  test: {
    allowOnly: false,
    coverage: {
      enabled: true,
      exclude: ['**/*.spec.ts'],
      // Only the gated files: route verification, the local grant check, and the proxy's header
      // sanitising; and from spec 027, the SigV4 signer and site serving (manifest check, path
      // resolution, generated headers); and from spec 028, the edge-origin check. Everything else
      // is reported nowhere rather than reported with no threshold.
      include: [
        'src/edge-origin.ts',
        'src/route-verify.ts',
        'src/grant-check.ts',
        'src/proxy.ts',
        'src/sigv4.ts',
        'src/site-serve.ts',
      ],
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportOnFailure: true,
      // **Never lower these to make a build pass.** An uncovered branch here is a route, grant or
      // header path nobody has exercised; delete the branch instead.
      thresholds: COVERAGE_ENFORCED ? FULL_COVERAGE : undefined,
    },
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
  },
});
