/**
 * The inbound webhook paths (spec 029, contracts/hooks-origin.md): the one list both the CSRF
 * exemption and the hooks-host middleware read, so a path served on the hooks origin is exempt by
 * construction and nothing else is. Exact paths, never prefixes, for the reason
 * `SIGNATURE_VERIFIED_WEBHOOK_PATHS` gives.
 */
export const INBOUND_PATHS = ['/api/v1/webhooks/github'] as const;
