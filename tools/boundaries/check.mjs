// Cruises apps/ and packages/ against .dependency-cruiser.cjs from source (no build), tolerating
// only the edges in .dependency-cruiser-known-violations.json — and failing when one of those
// entries no longer matches a real edge, which the tool itself does not do (research R3).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cruise, format } from 'dependency-cruiser';
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config';

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const { forbidden, options } = createRequire(import.meta.url)('../../.dependency-cruiser.cjs');
// BOUNDARIES_KNOWN_VIOLATIONS only redirects where the list is read from (the stale-entry test
// points it at a tampered copy); it cannot disable the check or the list — FR-008.
const knownViolations = JSON.parse(
  readFileSync(
    process.env.BOUNDARIES_KNOWN_VIOLATIONS || '.dependency-cruiser-known-violations.json',
    'utf8',
  ),
);

const cruised = await cruise(
  ['apps', 'packages'],
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
const result = JSON.parse(cruised.output);
const { summary } = result;
console.log((await format(result, { outputType: 'err-long' })).output);

if (summary.error > 0) {
  console.log(
    'The allowed-edge graph is .dependency-cruiser.cjs. Add an edge there (reviewed), or remove the import.',
  );
  process.exit(summary.error);
}
if (summary.ignore < knownViolations.length) {
  const ignored = summary.violations.filter((v) => v.rule.severity === 'ignore');
  for (const { from, to } of knownViolations) {
    if (!ignored.some((v) => v.from === from && v.to === to)) {
      console.log(`Stale known violation: ${from} → ${to} no longer exists.`);
    }
  }
  console.log(
    'Regenerate .dependency-cruiser-known-violations.json with `pnpm exec depcruise-baseline --config .dependency-cruiser.cjs apps packages` and remove its issue line from .dependency-cruiser.cjs.',
  );
  process.exit(1);
}
