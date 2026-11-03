/**
 * The preview module's injection tokens (spec 017, contract § 7). Symbols, as `sandbox.constants.ts`
 * has them, so a suite can `overrideProvider` either without a string colliding elsewhere.
 */

/** `BrokerTransport`: the listener the gateway calls for routes and grants (research R4). */
export const BROKER_TRANSPORT = Symbol('forge.preview.brokerTransport');

/** `RouteSigner`: mints and verifies the EdDSA route records (research R3). */
export const ROUTE_SIGNER = Symbol('forge.preview.routeSigner');

/** How long a grant lives, and how long a rotated label's `pv:revoked:` marker outlives it (research R14). */
export const GRANT_TTL_SECONDS = 600;

/** `SESSION_REDIS` key the rotation consumer sets and the grant broker consults (plan § Storage). */
export const revokedLabelKey = (previousLabel: string): string => `pv:revoked:${previousLabel}`;

/** `SESSION_REDIS` counter the callback guard bumps per sandbox, 60 s window (data-model § Redis keys). */
export const callbackRateKey = (daytonaId: string): string => `pv:cb:${daytonaId}`;

/** `string`: `PREVIEW_DOMAIN`, the suffix every preview host carries (contract § 4). */
export const PREVIEW_DOMAIN = Symbol('forge.preview.domain');
