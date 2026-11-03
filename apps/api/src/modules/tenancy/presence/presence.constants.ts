/**
 * Presence (spec 031, research R9): one Redis hash per project, one field per user, expired by
 * the hash's TTL. The TTL is the guarantee that a closed tab or sleeping device drops off.
 */
export const PRESENCE_TTL_SECONDS = 30;

/** `presence:{orgId}:{projectId}` — the hash holding everyone present on one project. */
export const presenceKey = (orgId: string, projectId: string): string =>
  `presence:${orgId}:${projectId}`;
