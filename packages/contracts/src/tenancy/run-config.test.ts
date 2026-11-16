import { describe, expect, it } from 'vitest';

import { runConfigInputSchema, runConfigSchema } from './run-config';

const valid = {
  build: null,
  dev: 'npm run dev',
  install: 'npm ci',
  port: 3000,
  source: 'detected',
  stack: { framework: 'nextjs', language: 'typescript', packageManager: 'npm' },
};

/** Spec 047: a run profile reaches the sandbox as lines of an env file, so its shape is a guard. */
describe('runConfigSchema', () => {
  it('fills the defaults a stored profile may omit', () => {
    expect(runConfigSchema.parse(valid)).toMatchObject({ env: [], repairs: 0, root: '.' });
  });

  it('refuses a command with a line break or NUL: it would add a line to the env file', () => {
    for (const dev of ['npm run dev\nFORGE_CALLBACK_URL=evil', 'npm\rrun', 'a\0b']) {
      expect(runConfigSchema.safeParse({ ...valid, dev }).success).toBe(false);
    }
  });

  it('refuses a root that climbs out of the workspace or is absolute', () => {
    for (const root of ['..', 'apps/../..', '/etc', 'a b']) {
      expect(runConfigSchema.safeParse({ ...valid, root }).success).toBe(false);
    }
    expect(runConfigSchema.safeParse({ ...valid, root: 'apps/web' }).success).toBe(true);
  });

  it('declares dev and port together, and only unprivileged ports', () => {
    expect(runConfigSchema.safeParse({ ...valid, port: null }).success).toBe(false);
    expect(runConfigSchema.safeParse({ ...valid, dev: null, port: null }).success).toBe(true);
    expect(runConfigSchema.safeParse({ ...valid, port: 80 }).success).toBe(false);
  });

  it('the agent input has no source or repairs of its own', () => {
    const input = { build: null, dev: valid.dev, install: valid.install, port: valid.port };

    expect(runConfigInputSchema.safeParse(input).success).toBe(true);
    expect(runConfigInputSchema.safeParse({ ...input, source: 'agent' }).success).toBe(false);
    expect(runConfigInputSchema.safeParse({ ...input, repairs: 0 }).success).toBe(false);
  });
});
