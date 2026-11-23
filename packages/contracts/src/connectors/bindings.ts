import { z } from 'zod';

import { cursorSchema } from '../common/cursor';
import { actorSchema } from './connection';
import { operationSchema } from './operations';

/**
 * Project bindings (spec 030, contracts/bindings.md § 2, data-model §§ 3–4): a project's link to
 * one provider resource, and what the platform created in the provider for it. A binding carries
 * its resources' `{ kind, state, name }` — never a value — and its latest operation.
 */

/** The providers a project binds to; Cloudflare is offered per domain (§ 3), GitHub is 018's link. */
export const BINDING_PROVIDERS = ['netlify', 'supabase', 'neon', 'resend'] as const;

export const bindingProviderSchema = z.enum(BINDING_PROVIDERS);

export type BindingProvider = z.output<typeof bindingProviderSchema>;

export const BINDING_STATES = ['bound', 'disconnected'] as const;

export const bindingStateSchema = z.enum(BINDING_STATES);

export const RESOURCE_KINDS = [
  'neon_branch',
  'resend_sending_key',
  'supabase_publishable_key',
  'cloudflare_dns_record',
] as const;

export const resourceKindSchema = z.enum(RESOURCE_KINDS);

export type ResourceKind = z.output<typeof resourceKindSchema>;

export const RESOURCE_STATES = ['provisioning', 'live', 'releasing', 'released', 'failed'] as const;

export const resourceStateSchema = z.enum(RESOURCE_STATES);

export type ResourceState = z.output<typeof resourceStateSchema>;

const idSchema = z.string().min(1).max(256);

// Per-provider `config` — the jsonb column, Zod-parsed on every read.

export const neonBindingConfigSchema = z.strictObject({
  databaseName: idSchema,
  parentBranchId: idSchema,
  projectId: idSchema,
  roleName: idSchema,
});

export const supabaseBindingConfigSchema = z.strictObject({ projectRef: idSchema });

export const netlifyBindingConfigSchema = z.strictObject({
  siteId: idSchema,
  siteName: idSchema,
  siteUrl: z.url(),
});

export const resendBindingConfigSchema = z.strictObject({
  domainId: idSchema,
  domainName: idSchema,
});

export type NeonBindingConfig = z.output<typeof neonBindingConfigSchema>;
export type SupabaseBindingConfig = z.output<typeof supabaseBindingConfigSchema>;
export type NetlifyBindingConfig = z.output<typeof netlifyBindingConfigSchema>;
export type ResendBindingConfig = z.output<typeof resendBindingConfigSchema>;

// `PUT /orgs/:orgId/projects/:projectId/connectors/:provider` bodies.

export const neonBindRequestSchema = neonBindingConfigSchema;

export const supabaseBindRequestSchema = supabaseBindingConfigSchema;

/** A Netlify site name: what Netlify accepts as a subdomain label. */
export const netlifySiteNameSchema = z.string().regex(/^[a-z0-9-]{1,63}$/u);

export const netlifyBindRequestSchema = z.union([
  z.strictObject({ siteId: idSchema }),
  z.strictObject({ createSite: z.strictObject({ name: netlifySiteNameSchema }) }),
]);

export const resendBindRequestSchema = z.strictObject({ domainId: idSchema });

export type NeonBindRequest = z.output<typeof neonBindRequestSchema>;
export type SupabaseBindRequest = z.output<typeof supabaseBindRequestSchema>;
export type NetlifyBindRequest = z.output<typeof netlifyBindRequestSchema>;
export type ResendBindRequest = z.output<typeof resendBindRequestSchema>;

/** The body schema for the path's provider. */
export const BIND_REQUEST_SCHEMAS = {
  neon: neonBindRequestSchema,
  netlify: netlifyBindRequestSchema,
  resend: resendBindRequestSchema,
  supabase: supabaseBindRequestSchema,
} as const satisfies Record<BindingProvider, z.ZodType>;

/**
 * `POST …/connectors/netlify/publish`: a release of this project — `succeeded`, or still building
 * (the publish waits for it). Without one, the head checkpoint is built and then published (or the
 * build already in flight is joined), so "Deploy to Netlify" is one request.
 */
export const netlifyPublishRequestSchema = z.strictObject({ deploymentId: z.uuid().optional() });

export type NetlifyPublishRequest = z.output<typeof netlifyPublishRequestSchema>;

export const bindingResourceSchema = z.strictObject({
  kind: resourceKindSchema,
  name: z.string().min(1),
  state: resourceStateSchema,
});

const bindingFields = {
  boundBy: actorSchema,
  connectionId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  id: z.uuid(),
  latestOperation: operationSchema.nullable(),
  projectId: z.uuid(),
  resources: z.array(bindingResourceSchema),
  state: bindingStateSchema,
  updatedAt: z.iso.datetime(),
};

export const bindingSchema = z.discriminatedUnion('provider', [
  z.strictObject({
    ...bindingFields,
    config: neonBindingConfigSchema,
    provider: z.literal('neon'),
  }),
  z.strictObject({
    ...bindingFields,
    config: supabaseBindingConfigSchema,
    provider: z.literal('supabase'),
  }),
  z.strictObject({
    ...bindingFields,
    config: netlifyBindingConfigSchema,
    provider: z.literal('netlify'),
  }),
  z.strictObject({
    ...bindingFields,
    config: resendBindingConfigSchema,
    /** The domain's Resend status while the key waits on verification (§ 2). */
    domainStatus: z.string().min(1).nullable(),
    provider: z.literal('resend'),
  }),
]);

export type Binding = z.output<typeof bindingSchema>;

/** `GET /orgs/:orgId/projects/:projectId/connectors`. */
export const bindingListSchema = z.strictObject({ items: z.array(bindingSchema) });

export type BindingList = z.output<typeof bindingListSchema>;

// The bind form's listings (`GET /orgs/:orgId/connectors/:connectionId/<provider>/…`).

export const listingQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  q: z.string().trim().max(100).optional(),
});

export type ListingQuery = z.output<typeof listingQuerySchema>;

const page = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item), nextCursor: cursorSchema.optional() });

export const netlifySitePageSchema = page(
  z.strictObject({ id: idSchema, name: z.string().min(1), url: z.url() }),
);

export const neonProjectPageSchema = page(
  z.strictObject({
    branches: z.array(
      z.strictObject({ default: z.boolean(), id: idSchema, name: z.string().min(1) }),
    ),
    databases: z.array(z.string().min(1)),
    id: idSchema,
    name: z.string().min(1),
    roles: z.array(z.string().min(1)),
  }),
);

export const supabaseProjectPageSchema = page(
  z.strictObject({
    name: z.string().min(1),
    ref: idSchema,
    region: z.string().min(1),
    status: z.string().min(1),
  }),
);

/** The platform's own sending domain is never listed (FR-021). */
export const resendDomainPageSchema = page(
  z.strictObject({ id: idSchema, name: z.string().min(1), status: z.string().min(1) }),
);

export type NetlifySitePage = z.output<typeof netlifySitePageSchema>;
export type NeonProjectPage = z.output<typeof neonProjectPageSchema>;
export type SupabaseProjectPage = z.output<typeof supabaseProjectPageSchema>;
export type ResendDomainPage = z.output<typeof resendDomainPageSchema>;

// Cloudflare DNS on a domain (§ 3).

export const CLOUDFLARE_OFFER_STATUSES = [
  'writable',
  'written',
  'zone-not-found',
  'not-connected',
  'needs-reauth',
] as const;

export const dnsRecordSchema = z.strictObject({
  content: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['CNAME', 'TXT']),
});

export type DnsRecord = z.output<typeof dnsRecordSchema>;

/** `GET /orgs/:orgId/domains/:domainId/cloudflare`. */
export const cloudflareOfferSchema = z.strictObject({
  /** The different record already at the name — any type, as the zone holds it (FR-011). */
  conflict: z
    .strictObject({ content: z.string(), name: z.string().min(1), type: z.string().min(1) })
    .optional(),
  records: z.array(dnsRecordSchema),
  status: z.enum(CLOUDFLARE_OFFER_STATUSES),
  zone: z.strictObject({ id: idSchema, name: z.string().min(1) }).optional(),
});

export type CloudflareOffer = z.output<typeof cloudflareOfferSchema>;
