/**
 * The edge that terminates TLS for a member's custom hostname and forwards it to the gateway
 * (spec 028 research R2, contracts/domain-serving.md § 3). One adapter, `CloudflareForSaasAdapter`,
 * over Cloudflare for SaaS custom hostnames; the port is named for what the platform needs, the
 * adapter for the vendor (constitution III).
 *
 * The adapter maps the vendor's states into the closed vocabulary below, so `evaluateCheck` (R6)
 * stays pure and its spec covers every vendor state without the vendor.
 *
 * Failures, for every call:
 *
 * - `429`, `5xx`, a timeout or a network error throw the outbox's `RetryableFailure`
 *   (`throttled`, `upstream-5xx`, `timeout`). A check that meets one is inconclusive (R6).
 * - Any other `4xx` throws `EdgeRefused` with the provider's first error message.
 * - With the `CLOUDFLARE_*` group absent, every call throws `EdgeNotConfigured`, following the
 *   `DaytonaAdapter` precedent.
 *
 * The API token appears in no log line, response or error.
 */

/**
 * The custom hostname's own state. Vendor mapping (R2): `active` → `active`; `blocked` and `moved`
 * → `blocked`; `deleted` and `pending_deletion` → `gone`; everything else → `pending`.
 */
export type EdgeHostnameState = 'active' | 'blocked' | 'gone' | 'pending';

/**
 * The certificate's state. Vendor mapping (R2): `active` → `active`; `*_timed_out` and `expired`
 * → `failed`; `deleted` → `gone`; everything else → `pending`.
 */
export type EdgeCertificateState = 'active' | 'failed' | 'gone' | 'pending';

/**
 * A TXT record the edge asks for to validate the certificate, when HTTP validation cannot complete
 * (R4). Shown to the member as the `certificate` record. `name` is fully qualified with no trailing
 * dot.
 */
export interface EdgeValidationRecord {
  readonly name: string;
  readonly value: string;
}

/** What `status(edgeId)` answers. */
export interface EdgeStatus {
  readonly hostname: EdgeHostnameState;
  readonly certificate: EdgeCertificateState;
  readonly validationRecords: readonly EdgeValidationRecord[];
  /** The provider's own messages about this hostname, verbatim, for the panel and the logs. */
  readonly errors: readonly string[];
}

export interface CustomHostnamePort {
  /**
   * Registers `hostname` (ASCII form) with an HTTP-validated DV certificate from the pinned CA
   * (R4). A duplicate-hostname answer is adopted through `findByHostname` (R9), so this is
   * idempotent for the row asking.
   */
  register(hostname: string): Promise<{ edgeId: string }>;
  status(edgeId: string): Promise<EdgeStatus>;
  /** The registration for `hostname`, or `undefined` when the edge has none. */
  findByHostname(hostname: string): Promise<{ edgeId: string } | undefined>;
  /** Removes the registration. An edge that no longer knows `edgeId` (`404`) counts as done. */
  deregister(edgeId: string): Promise<void>;
}

/** Symbol for the reason `database.constants.ts` gives: a string token collides silently. */
export const CUSTOM_HOSTNAMES = Symbol('forge.deploy.custom-hostnames');

/**
 * The edge refused the request with a `4xx` other than `429`. Terminal: repeating the request
 * repeats the answer. At registration it ends the domain `failed / provider-refused` at once (R6);
 * `message` is the provider's first error message, kept as `last_check.edgeMessage`.
 */
export class EdgeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EdgeRefused';
  }
}

/** The `CLOUDFLARE_*` environment group is absent, so no custom hostname can be registered. */
export class EdgeNotConfigured extends Error {
  constructor() {
    super('CLOUDFLARE_API_TOKEN is not set; no custom hostname can be registered.');
    this.name = 'EdgeNotConfigured';
  }
}
