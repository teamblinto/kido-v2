import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * Whether this run is the one that is not allowed to skip.
 *
 * CI sets it. `integration-database.ts` and `integration-redis.ts` read the same variable to turn
 * their loud skip into a throw; this module is the other half — the part that asks whether a suite
 * *could* have skipped for a reason those probes never see.
 */
export const INTEGRATION_EXPECTED = process.env.EXPECT_INTEGRATION === '1';

/** Where the guard looks, relative to `apps/api`. Both halves of the include pattern in the config. */
const SCANNED_DIRECTORIES = ['src', 'test'] as const;

const SPEC_FILE = /\.(?:spec|e2e-spec)\.ts$/;

/**
 * Ways a suite stops running that no reachability probe can detect.
 *
 * `describe.skip` and friends are the obvious one — a suite commented out with a keyword. The
 * constant `skipIf` is the subtle one, and the reason this scan exists at all: `describe.skipIf(true)`
 * reads exactly like the twenty legitimate `describe.skipIf(!postgres)` blocks in this repository,
 * runs never, and leaves no banner in the log for CI's `SKIPPING` grep to find.
 *
 * `.only` is caught here as well as by `--allowOnly=false`, because the two fail differently: the
 * flag fails the run that contains one, and this fails a run where somebody has taught the flag to
 * be absent.
 */
const FORBIDDEN = [
  { pattern: /\b(?:describe|it|test|suite)\.skip\s*\(/g, what: 'an unconditional .skip(' },
  { pattern: /\b(?:describe|it|test|suite)\.only\s*\(/g, what: 'a focused .only(' },
  {
    pattern: /\.skipIf\s*\(\s*(?:true|!\s*false)\s*[,)]/g,
    what: 'a .skipIf( that is constantly true',
  },
] as const;

/** One violation, as a line a person can act on without opening the file first. */
export interface SkipViolation {
  readonly file: string;
  readonly line: number;
  readonly what: string;
}

/**
 * Every suite in the repository that can never run, whatever the services are doing.
 *
 * Returned rather than thrown so the caller decides what a violation means. Today there is exactly
 * one caller and it always throws — but a listing is what makes this testable, and a scan whose only
 * observable behaviour is a process exit is a scan nobody can write a test for.
 */
export async function findUnconditionalSkips(apiRoot: string): Promise<SkipViolation[]> {
  const violations: SkipViolation[] = [];

  for (const directory of SCANNED_DIRECTORIES) {
    for (const file of await collectSpecFiles(join(apiRoot, directory))) {
      const source = await readFile(file, 'utf8');
      const lines = source.split('\n');

      for (const [index, line] of lines.entries()) {
        for (const { pattern, what } of FORBIDDEN) {
          // Counted rather than iterated, because two `.skip(` on one line are two violations and
          // `matchAll` is the only way to say so. The regexes are global literals; `matchAll`
          // builds its own iterator rather than advancing a shared `lastIndex`, so scanning one
          // line does not change where the next scan starts.
          const found = [...line.matchAll(pattern)].length;

          for (let occurrence = 0; occurrence < found; occurrence += 1) {
            violations.push({
              file: relative(apiRoot, file).split(sep).join('/'),
              line: index + 1,
              what,
            });
          }
        }
      }
    }
  }

  return violations;
}

/**
 * The assertion T33 asks for: in CI, the integration suites **ran**.
 *
 * Three things have to be true for that sentence to mean anything, and only the first is covered by
 * `EXPECT_INTEGRATION` on its own.
 *
 * 1. **The services answered.** The probes already throw on this, and it is re-checked here on
 *    purpose: deleting the throw from `integration-database.ts` is a two-line edit that turns every
 *    integration suite into a silent no-op, and nothing else in the repository would notice.
 * 2. **No suite is skipped for a reason the probes cannot see.** That is {@link findUnconditionalSkips}.
 * 3. **Nothing is focused.** `--allowOnly=false` is the primary control; the scan is the backstop.
 *
 * Outside CI this does nothing at all. The spec's whole point is that a laptop with no Docker still
 * gets a green `pnpm check`, with a banner saying what it did not prove.
 */
export async function assertIntegrationSuitesRan(
  apiRoot: string,
  probes: { readonly postgres: boolean; readonly redis: boolean },
): Promise<void> {
  if (!INTEGRATION_EXPECTED) {
    return;
  }

  const unreachable = Object.entries(probes)
    .filter(([, reachable]) => !reachable)
    .map(([service]) => service);

  if (unreachable.length > 0) {
    throw new Error(
      `EXPECT_INTEGRATION=1 but ${unreachable.join(' and ')} did not answer. ` +
        'Every integration suite would have skipped, and a skipped suite proves nothing — ' +
        'this run is a failure rather than a pass with a warning.',
    );
  }

  const violations = await findUnconditionalSkips(apiRoot);

  if (violations.length > 0) {
    const listed = violations.map(({ file, line, what }) => `  ${file}:${line} — ${what}`);

    throw new Error(
      [
        `EXPECT_INTEGRATION=1 but ${violations.length} suite(s) can never run:`,
        ...listed,
        'A suite that is skipped by construction leaves no SKIPPING banner for CI to grep, so it',
        'would otherwise pass by not running. Remove the skip, or gate it on service reachability',
        'the way every other integration suite here does.',
      ].join('\n'),
    );
  }
}

/** Every `*.spec.ts` and `*.e2e-spec.ts` under one directory. Missing directories are not an error. */
async function collectSpecFiles(directory: string): Promise<string[]> {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectSpecFiles(path)));
    } else if (SPEC_FILE.test(entry.name)) {
      files.push(path);
    }
  }

  return files;
}
