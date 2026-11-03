import { describe, expect, it } from 'vitest';

import {
  BIND_REQUEST_SCHEMAS,
  BINDING_PROVIDERS,
  bindingListSchema,
  bindingSchema,
  cloudflareOfferSchema,
  neonProjectPageSchema,
  netlifyBindRequestSchema,
  netlifyPublishRequestSchema,
  resendDomainPageSchema,
} from './bindings';

const UUID = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';

const neonBinding = {
  boundBy: { id: UUID, name: 'Ada' },
  config: {
    databaseName: 'neondb',
    parentBranchId: 'br-main-1',
    projectId: 'proj-1',
    roleName: 'neondb_owner',
  },
  connectionId: UUID,
  createdAt: '2026-09-23T10:00:00.000Z',
  id: UUID,
  latestOperation: null,
  projectId: UUID,
  provider: 'neon',
  resources: [{ kind: 'neon_branch', name: `forge-preview-${UUID}`, state: 'live' }],
  state: 'bound',
  updatedAt: '2026-09-23T10:00:00.000Z',
};

describe('bindings', () => {
  it('binds the four project providers, never GitHub or Cloudflare', () => {
    expect(BINDING_PROVIDERS).toEqual(['netlify', 'supabase', 'neon', 'resend']);
    expect(Object.keys(BIND_REQUEST_SCHEMAS).sort()).toEqual([
      'neon',
      'netlify',
      'resend',
      'supabase',
    ]);
  });

  it('parses a binding whose config matches its provider, and never a value', () => {
    expect(bindingSchema.parse(neonBinding)).toEqual(neonBinding);
    expect(bindingSchema.safeParse({ ...neonBinding, config: { projectRef: 'abc' } }).success).toBe(
      false,
    );
    expect(
      bindingSchema.safeParse({
        ...neonBinding,
        resources: [{ ...neonBinding.resources[0], value: 'postgres://u:p@h/db' }],
      }).success,
    ).toBe(false);
    expect(bindingListSchema.parse({ items: [neonBinding] }).items).toHaveLength(1);
  });

  it('takes a Netlify site by id or a new site by a valid name', () => {
    expect(netlifyBindRequestSchema.parse({ siteId: 'site-1' })).toEqual({ siteId: 'site-1' });
    expect(netlifyBindRequestSchema.parse({ createSite: { name: 'my-site' } })).toBeDefined();
    expect(netlifyBindRequestSchema.safeParse({ createSite: { name: 'My Site' } }).success).toBe(
      false,
    );
    expect(
      netlifyBindRequestSchema.safeParse({ createSite: { name: 'a' }, siteId: 'x' }).success,
    ).toBe(false);
  });

  it('refuses a Neon bind body missing a field', () => {
    expect(BIND_REQUEST_SCHEMAS.neon.safeParse({ projectId: 'p' }).success).toBe(false);
  });

  it('publishes a release by uuid', () => {
    expect(netlifyPublishRequestSchema.safeParse({ deploymentId: 'nope' }).success).toBe(false);
    expect(netlifyPublishRequestSchema.parse({ deploymentId: UUID })).toEqual({
      deploymentId: UUID,
    });
  });

  it('pages the bind form listings', () => {
    expect(
      neonProjectPageSchema.parse({
        items: [
          {
            branches: [{ default: true, id: 'br-1', name: 'main' }],
            databases: ['neondb'],
            id: 'proj-1',
            name: 'App',
            roles: ['neondb_owner'],
          },
        ],
      }).items,
    ).toHaveLength(1);
    expect(
      resendDomainPageSchema.parse({
        items: [{ id: 'd1', name: 'mail.acme.test', status: 'verified' }],
      }).items[0]?.status,
    ).toBe('verified');
  });

  it('describes the Cloudflare offer, with a conflicting record of any type', () => {
    expect(
      cloudflareOfferSchema.parse({
        conflict: { content: '192.0.2.1', name: 'www.acme.test', type: 'A' },
        records: [{ content: 'edge.forge.test', name: 'www.acme.test', type: 'CNAME' }],
        status: 'writable',
        zone: { id: 'z1', name: 'acme.test' },
      }).status,
    ).toBe('writable');
    expect(cloudflareOfferSchema.safeParse({ records: [], status: 'maybe' }).success).toBe(false);
  });
});
