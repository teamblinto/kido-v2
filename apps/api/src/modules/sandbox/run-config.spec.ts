import type { RunConfig } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { resolveBuild, resolveDevPort, resolveDevServer } from './run-config';
import type { TemplateCatalogue } from './template-catalogue';

const catalogue = {
  get: (id: string) => ({
    manifest:
      id === 'python'
        ? {}
        : {
            build: { command: 'npm run build', output: 'dist' },
            devCommand: 'npm run dev',
            devPort: '3000',
          },
  }),
} as unknown as TemplateCatalogue;

const profile: RunConfig = {
  build: null,
  dev: 'corepack pnpm run dev',
  env: [],
  install: 'corepack pnpm install',
  port: 4321,
  repairs: 0,
  root: 'apps/web',
  source: 'detected',
  stack: { framework: 'astro', language: 'typescript', packageManager: 'pnpm' },
};

/** Spec 047: the one reading of how a project runs. Template projects must not notice it exists. */
describe('resolveDevServer', () => {
  it('a template project resolves to its manifest, exactly as before run profiles', () => {
    expect(resolveDevServer(catalogue, { runConfig: null, template: 'vite-react' })).toEqual({
      command: 'npm run dev',
      port: '3000',
    });
    expect(resolveDevPort(catalogue, { runConfig: null, template: 'vite-react' })).toBe(3000);
    expect(resolveBuild(catalogue, { runConfig: null, template: 'vite-react' })).toEqual({
      command: 'npm run build',
      output: 'dist',
    });
  });

  it('a template with no dev server, an unknown template and no template have none', () => {
    for (const template of ['python', 'rails', null]) {
      expect(resolveDevServer(catalogue, { runConfig: null, template })).toBeUndefined();
      expect(resolveDevPort(catalogue, { runConfig: null, template })).toBeUndefined();
    }
  });

  it('a run profile wins over the template and carries its install, root and profile flag', () => {
    expect(resolveDevServer(catalogue, { runConfig: profile, template: 'vite-react' })).toEqual({
      command: 'corepack pnpm run dev',
      install: 'corepack pnpm install',
      port: '4321',
      profile: true,
      root: 'apps/web',
    });
    expect(resolveDevPort(catalogue, { runConfig: profile, template: 'vite-react' })).toBe(4321);
    // The profile's own `build: null` is the answer, not a reason to fall back to the template's.
    expect(resolveBuild(catalogue, { runConfig: profile, template: 'vite-react' })).toBeUndefined();
  });

  it('a profile with nothing to serve declares no dev server, even over a template that has one', () => {
    const library = { ...profile, dev: null, port: null };

    expect(
      resolveDevServer(catalogue, { runConfig: library, template: 'vite-react' }),
    ).toBeUndefined();
    expect(
      resolveDevPort(catalogue, { runConfig: library, template: 'vite-react' }),
    ).toBeUndefined();
  });

  it('a stored profile that no longer parses is treated as absent, never thrown', () => {
    expect(
      resolveDevServer(catalogue, { runConfig: { dev: 'x\ny' }, template: 'vite-react' }),
    ).toEqual({ command: 'npm run dev', port: '3000' });
  });
});
