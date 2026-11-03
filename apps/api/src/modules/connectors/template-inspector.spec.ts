import { describe, expect, it } from 'vitest';

import { inspectRoot, parseDependencies } from './template-inspector';

/**
 * Research R3's four rule sets, each read back through its **evidence** rather than its template:
 * the user is shown the signals, and a candidate whose evidence does not name the file that put
 * it there is a guess wearing a template's name.
 */
describe('inspectRoot', () => {
  it('a Next.js repository: the config file and the dependency are both named', () => {
    const inspection = inspectRoot({
      files: ['README.md', 'next.config.ts', 'package.json'],
      packageJson: JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0' } }),
    });

    expect(inspection.outcome).toBe('proposed');
    expect(inspection.candidates).toEqual([
      { evidence: ['next.config.ts', 'dependency: next'], template: 'nextjs' },
    ]);
  });

  it('a Next.js repository with no config file still matches on the dependency alone', () => {
    const inspection = inspectRoot({
      files: ['package.json'],
      packageJson: JSON.stringify({ dependencies: { next: '15.0.0' } }),
    });

    expect(inspection.candidates).toEqual([{ evidence: ['dependency: next'], template: 'nextjs' }]);
  });

  it('a Vite + React repository needs both signals, and names both', () => {
    const inspection = inspectRoot({
      files: ['index.html', 'package.json', 'vite.config.ts'],
      packageJson: JSON.stringify({ dependencies: { react: '19.0.0' } }),
    });

    expect(inspection.outcome).toBe('proposed');
    expect(inspection.candidates).toEqual([
      { evidence: ['vite.config.ts', 'dependency: react'], template: 'vite-react' },
    ]);
  });

  it('a Vite config without react is not vite-react — it falls through to node-api', () => {
    const inspection = inspectRoot({
      files: ['package.json', 'vite.config.js'],
      packageJson: JSON.stringify({ dependencies: { vue: '3.0.0' } }),
    });

    expect(inspection.candidates).toEqual([{ evidence: ['package.json'], template: 'node-api' }]);
  });

  it('a plain package.json with neither signal is node-api, evidenced by the manifest itself', () => {
    const inspection = inspectRoot({
      files: ['package.json', 'src'],
      packageJson: JSON.stringify({ dependencies: { fastify: '5.0.0' } }),
    });

    expect(inspection.outcome).toBe('proposed');
    expect(inspection.candidates).toEqual([{ evidence: ['package.json'], template: 'node-api' }]);
  });

  it('each of the three Python manifests is evidence, and every one found is listed', () => {
    expect(inspectRoot({ files: ['pyproject.toml'] }).candidates).toEqual([
      { evidence: ['pyproject.toml'], template: 'python' },
    ]);
    expect(inspectRoot({ files: ['requirements.txt'] }).candidates).toEqual([
      { evidence: ['requirements.txt'], template: 'python' },
    ]);
    expect(inspectRoot({ files: ['Pipfile', 'requirements.txt'] }).candidates[0]?.evidence).toEqual(
      ['requirements.txt', 'Pipfile'],
    );
  });

  it('a polyglot repository is ambiguous, with every candidate and its own evidence (FR-012)', () => {
    const inspection = inspectRoot({
      files: ['next.config.mjs', 'package.json', 'pyproject.toml'],
      packageJson: JSON.stringify({ dependencies: { next: '15.0.0' } }),
    });

    expect(inspection.outcome).toBe('ambiguous');
    expect(inspection.candidates).toEqual([
      { evidence: ['next.config.mjs', 'dependency: next'], template: 'nextjs' },
      { evidence: ['pyproject.toml'], template: 'python' },
    ]);
  });

  it('nothing recognisable is unrecognised with an empty array — never a default (FR-011)', () => {
    const inspection = inspectRoot({ files: ['main.go', 'go.mod', 'README.md'] });

    expect(inspection).toEqual({ candidates: [], outcome: 'unrecognised' });
  });

  it('a Go repository matches nothing at all: unrecognised, candidates empty (FR-011)', () => {
    const inspection = inspectRoot({
      files: ['go.mod'],
      packageJson: null,
    });

    // Not "node-api because it has to be something": the array is empty, so there is nothing for
    // the UI to pre-select and nothing for the wire to substitute (quickstart § 3).
    expect(inspection.outcome).toBe('unrecognised');
    expect(inspection.candidates).toEqual([]);
    expect(inspection.candidates).toHaveLength(0);
  });

  it('both a Next and a Vite config: ambiguous, two candidates, both evidence sets (FR-012)', () => {
    const inspection = inspectRoot({
      files: ['next.config.ts', 'package.json', 'vite.config.ts'],
      packageJson: JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0' } }),
    });

    expect(inspection.outcome).toBe('ambiguous');
    expect(inspection.candidates).toHaveLength(2);
    expect(inspection.candidates).toEqual([
      { evidence: ['next.config.ts', 'dependency: next'], template: 'nextjs' },
      { evidence: ['vite.config.ts', 'dependency: react'], template: 'vite-react' },
    ]);
    // `node-api` does not join them: a `package.json` is only a signal of its own when nothing
    // else on the list already explains it, and neither candidate wins for having been first.
    expect(inspection.candidates.map((candidate) => candidate.template)).not.toContain('node-api');
  });

  it('an empty repository is unrecognised rather than node-api', () => {
    expect(inspectRoot({ files: [] })).toEqual({ candidates: [], outcome: 'unrecognised' });
  });

  it('a nested config is not a root config: only the root list is read', () => {
    const inspection = inspectRoot({ files: ['packages'], packageJson: null });

    expect(inspection.candidates).toEqual([]);
  });

  it('a package.json that is not JSON costs the dependency signals, not the whole answer', () => {
    const inspection = inspectRoot({ files: ['package.json'], packageJson: '{ not json' });

    expect(inspection.candidates).toEqual([{ evidence: ['package.json'], template: 'node-api' }]);
  });
});

describe('parseDependencies', () => {
  it('reads dependencies and devDependencies, and nothing else', () => {
    const names = parseDependencies(
      JSON.stringify({
        dependencies: { next: '15' },
        devDependencies: { vitest: '4' },
        peerDependencies: { react: '19' },
      }),
    );

    expect([...names].sort()).toEqual(['next', 'vitest']);
  });

  it('a missing, empty or malformed manifest is an empty set, never a throw', () => {
    expect(parseDependencies(null).size).toBe(0);
    expect(parseDependencies(undefined).size).toBe(0);
    expect(parseDependencies('[]').size).toBe(0);
    expect(parseDependencies('nonsense').size).toBe(0);
  });
});
