import { describe, expect, it } from 'vitest';

import { siteResponseSchema, siteSchema, updateSiteRequestSchema } from './site';

const UUID = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';

const neverDeployed = { currentDeploymentId: null, deployable: true, offline: false, url: null };

describe('siteSchema', () => {
  it('accepts a never-deployed site and a live one', () => {
    expect(siteSchema.safeParse(neverDeployed).success).toBe(true);
    expect(
      siteSchema.safeParse({
        currentDeploymentId: UUID,
        deployable: true,
        offline: false,
        url: 'https://abc123.sites.example.test/',
      }).success,
    ).toBe(true);
  });

  it('refuses an undeclared key and a non-url', () => {
    expect(siteSchema.safeParse({ ...neverDeployed, label: 'abc' }).success).toBe(false);
    expect(siteSchema.safeParse({ ...neverDeployed, url: 'not a url' }).success).toBe(false);
  });

  it('is wrapped as { site }', () => {
    expect(siteResponseSchema.safeParse({ site: neverDeployed }).success).toBe(true);
    expect(siteResponseSchema.safeParse({ site: neverDeployed, x: 1 }).success).toBe(false);
  });
});

describe('updateSiteRequestSchema', () => {
  it('accepts release with a deployment id and a bare offline', () => {
    expect(
      updateSiteRequestSchema.safeParse({ action: 'release', deploymentId: UUID }).success,
    ).toBe(true);
    expect(updateSiteRequestSchema.safeParse({ action: 'offline' }).success).toBe(true);
  });

  it('refuses release without a deploymentId', () => {
    expect(updateSiteRequestSchema.safeParse({ action: 'release' }).success).toBe(false);
    expect(
      updateSiteRequestSchema.safeParse({ action: 'release', deploymentId: 'nope' }).success,
    ).toBe(false);
  });

  it('refuses offline with a deploymentId', () => {
    expect(
      updateSiteRequestSchema.safeParse({ action: 'offline', deploymentId: UUID }).success,
    ).toBe(false);
  });

  it('refuses an undeclared key or action', () => {
    expect(
      updateSiteRequestSchema.safeParse({ action: 'release', deploymentId: UUID, force: true })
        .success,
    ).toBe(false);
    expect(updateSiteRequestSchema.safeParse({ action: 'online' }).success).toBe(false);
    expect(updateSiteRequestSchema.safeParse({}).success).toBe(false);
  });
});
