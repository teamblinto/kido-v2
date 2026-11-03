import { z } from 'zod';

/**
 * Custom domains (spec 028, contracts/domains.md § Shapes): a member's own hostname pointed at a
 * project's site. `removed` is a stored state but is never returned, so it is not in
 * `DOMAIN_STATES`. The ownership token is never on the wire — only the TXT record built from it.
 */

export const DOMAIN_STATES = ['pending', 'active', 'drifted', 'removing', 'failed'] as const;

export const domainStateSchema = z.enum(DOMAIN_STATES);

export type DomainState = z.output<typeof domainStateSchema>;

export const DOMAIN_FAILURE_REASONS = [
  'ownership-not-found',
  'routing-not-found',
  'caa-blocked',
  'certificate-failed',
  'verification-timeout',
  'provider-refused',
] as const;

export const domainFailureReasonSchema = z.enum(DOMAIN_FAILURE_REASONS);

export type DomainFailureReason = z.output<typeof domainFailureReasonSchema>;

/**
 * The `reason` a `409 conflict` carries on the domain routes (contracts/domains.md § Refusals) —
 * no new problem slug. The API raises exactly these; the web panel has copy for each.
 */
export const DOMAIN_CONFLICT_REASONS = [
  'apex-not-supported',
  'domain-limit',
  'domains-unavailable',
  'hostname-unavailable',
  'invalid-hostname',
  'not-deployable',
  'not-retryable',
  'project-archived',
  'reserved-hostname',
] as const;

export type DomainConflictReason = (typeof DOMAIN_CONFLICT_REASONS)[number];

/** One DNS record the member must create, with what the last check saw. */
export const domainRecordSchema = z.strictObject({
  purpose: z.enum(['ownership', 'routing', 'certificate']),
  type: z.enum(['TXT', 'CNAME']),
  /** Fully qualified, no trailing dot: `_forge-challenge.app.acme.com`. */
  name: z.string(),
  /** `forge-verify=<token>` · the `CUSTOM_HOSTNAME_TARGET` · the edge's TXT value. */
  value: z.string(),
  status: z.enum(['found', 'missing', 'mismatch', 'apex', 'unchecked']),
});

export type DomainRecord = z.output<typeof domainRecordSchema>;

export const domainCheckSchema = z.strictObject({
  at: z.iso.datetime(),
  conclusive: z.boolean(),
  /** Null until registered at the edge. */
  hostnameActive: z.boolean().nullable(),
  certificateActive: z.boolean().nullable(),
  caa: z.discriminatedUnion('verdict', [
    z.strictObject({ verdict: z.literal('permitted') }),
    z.strictObject({ verdict: z.literal('blocked'), zone: z.string(), record: z.string() }),
  ]),
  /** The edge's refusal text, when `provider-refused`. */
  message: z.string().nullable(),
});

export type DomainCheck = z.output<typeof domainCheckSchema>;

export const domainSchema = z.strictObject({
  id: z.uuid(),
  /** ASCII (punycode) form. */
  hostname: z.string(),
  /** Unicode form, for display only. */
  displayHostname: z.string(),
  state: domainStateSchema,
  failureReason: domainFailureReasonSchema.nullable(),
  /** Ownership + routing, + certificate when the edge asks for one. */
  records: z.array(domainRecordSchema),
  /** Null until the first check. */
  check: domainCheckSchema.nullable(),
  /** Pending only: `window_started_at` + 72 h. */
  windowEndsAt: z.iso.datetime().nullable(),
  addedBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  activatedAt: z.iso.datetime().nullable(),
  driftedAt: z.iso.datetime().nullable(),
  /** Drifted only: `drifted_at` + 30 d. */
  releaseAt: z.iso.datetime().nullable(),
  /** Check-now limit (FR-012); null means now. */
  checkAvailableAt: z.iso.datetime().nullable(),
});

export type Domain = z.output<typeof domainSchema>;

/** `POST …/domains`. The hostname is normalised server-side (research R8). */
export const addDomainRequestSchema = z.strictObject({
  hostname: z.string().trim().min(1).max(300),
});

export type AddDomainRequest = z.output<typeof addDomainRequestSchema>;

/** Add, get, check and retry all answer `{ domain }`. */
export const domainResponseSchema = z.strictObject({
  domain: domainSchema,
});

export type DomainResponse = z.output<typeof domainResponseSchema>;

/** `GET …/domains` — newest first; at most 10 live per project, so unpaged. */
export const domainListResponseSchema = z.strictObject({
  items: z.array(domainSchema),
  /** The caller holds `org:domains.manage` (research R12). */
  canManage: z.boolean(),
});

export type DomainListResponse = z.output<typeof domainListResponseSchema>;

/** `DELETE …/domains/:domainId` — the domain in `removing`, and the records the member may delete. */
export const removeDomainResponseSchema = z.strictObject({
  domain: domainSchema,
  deletableRecords: z.array(domainRecordSchema.pick({ name: true, type: true, value: true })),
});

export type RemoveDomainResponse = z.output<typeof removeDomainResponseSchema>;
