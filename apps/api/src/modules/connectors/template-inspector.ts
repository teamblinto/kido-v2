import { type ImportCandidate, type ImportOutcome, outcomeFor } from '@repo/contracts';

/**
 * Classifying a repository against spec 015's four templates (research R3, spec 026 FR-010–FR-012).
 *
 * Pure: a root file list and, when there is one, the raw `package.json`. No I/O, no GitHub client,
 * no clock — `import.service.ts` makes the two calls and hands the answer here, which is what lets
 * every rule of R3 be read back in a unit test rather than through a fixture server.
 *
 * The rules are evaluated **independently and all reported**. Nothing scores, nothing ranks and
 * nothing wins a tie: two matches are `ambiguous` and the user picks (FR-012), zero are
 * `unrecognised` and the user picks (FR-011). A confidence number would need a threshold, and a
 * threshold is the silent default those two requirements exist to forbid.
 *
 * Evidence is the file name or the dependency that fired the rule, in the order the rule looked,
 * because the point of showing it is that the user can check it against their own repository.
 */
export interface RepositoryRoot {
  /** The names directly at the branch head's root — no path separators, blobs and trees alike. */
  readonly files: readonly string[];
  /** The root `package.json` as GitHub served it, or null/undefined when there is none. */
  readonly packageJson?: string | null;
}

export interface Inspection {
  readonly candidates: readonly ImportCandidate[];
  readonly outcome: ImportOutcome;
}

/** R3: a root `next.config` in any of the three extensions git repositories actually use. */
const NEXT_CONFIGS = ['next.config.js', 'next.config.mjs', 'next.config.ts'] as const;
const VITE_CONFIGS = ['vite.config.js', 'vite.config.ts'] as const;
/** Looked at in this order, so the evidence reads in a fixed order whatever the tree's. */
const PYTHON_MANIFESTS = ['pyproject.toml', 'requirements.txt', 'Pipfile'] as const;

/**
 * The declared dependency names, runtime and dev. A manifest that is missing, empty, not JSON or
 * not an object yields an empty set rather than a throw: a repository whose `package.json` this
 * code cannot read still has a root `package.json`, which is itself a signal, and losing the whole
 * inspection to a syntax error would refuse an import over a file the import does not need.
 */
export function parseDependencies(raw: string | null | undefined): ReadonlySet<string> {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return new Set();
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return new Set();
  }

  const record = parsed as Record<string, unknown>;
  const names = new Set<string>();

  for (const field of ['dependencies', 'devDependencies'] as const) {
    const block = record[field];

    if (typeof block === 'object' && block !== null && !Array.isArray(block)) {
      for (const name of Object.keys(block)) names.add(name);
    }
  }

  return names;
}

/** R3's four rule sets, each reported with the signals that fired it. */
export function inspectRoot(root: RepositoryRoot): Inspection {
  const files = new Set(root.files);
  const dependencies = parseDependencies(root.packageJson);
  const candidates: ImportCandidate[] = [];

  const nextConfig = NEXT_CONFIGS.find((name) => files.has(name));
  const viteConfig = VITE_CONFIGS.find((name) => files.has(name));
  const hasReact = dependencies.has('react');
  const hasNext = dependencies.has('next');
  const hasManifest = files.has('package.json');

  // `PROJECT_TEMPLATES` order is not R3's reading order; the reading order is the one below, and
  // the candidate list follows it so two inspections of the same tree never disagree on order.
  const nextEvidence = [nextConfig, hasNext ? 'dependency: next' : undefined].filter(
    (signal): signal is string => signal !== undefined,
  );

  if (nextEvidence.length > 0) {
    candidates.push({ evidence: nextEvidence, template: 'nextjs' });
  }

  if (viteConfig !== undefined && hasReact) {
    candidates.push({ evidence: [viteConfig, 'dependency: react'], template: 'vite-react' });
  }

  // "Neither of the above" is read off this repository's own signals: a `package.json` that put
  // nothing else on the list is a Node service, and one that did is already represented.
  if (hasManifest && candidates.length === 0) {
    candidates.push({ evidence: ['package.json'], template: 'node-api' });
  }

  const pythonEvidence = PYTHON_MANIFESTS.filter((name) => files.has(name));

  if (pythonEvidence.length > 0) {
    candidates.push({ evidence: pythonEvidence, template: 'python' });
  }

  return { candidates, outcome: outcomeFor(candidates.length) };
}
