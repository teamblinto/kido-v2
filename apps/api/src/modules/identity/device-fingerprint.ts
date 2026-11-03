import { createHash } from 'node:crypto';

/**
 * What §11 means by "a device fingerprint recorded for the session list", reduced to the three
 * fields a session row can honestly show.
 *
 * There is no attempt at a clever device identity here — no canvas hash, no font probe, nothing
 * that would make this a tracking primitive. The address and the agent are what the request already
 * told us, and the fingerprint is their digest: enough for T18 to say "this is the device you are
 * using now" and for a user to recognise the one they do not recognise, and no more.
 */
export interface DeviceFingerprint {
  /** A stable id for the address-and-agent pair. Hex, so it is a legible Redis hash field. */
  readonly fingerprint: string;
  readonly ip: string;
  readonly userAgent: string;
}

/**
 * Long enough for every real browser's agent string, short enough that the header cannot be used to
 * push kilobytes into a `noeviction` instance one unauthenticated request at a time (§09).
 */
export const USER_AGENT_MAX_LENGTH = 256;

/** What a field says when the request did not. Better than an empty cell in a list of devices. */
export const UNKNOWN_DEVICE_FIELD = 'unknown';

/** The part of the request this reads, declared structurally so nothing here imports Express. */
export interface DeviceBearingRequest {
  readonly ip?: string;
  readonly userAgent?: string;
}

export function deviceFingerprintOf(request: DeviceBearingRequest): DeviceFingerprint {
  const ip = sanitise(request.ip);
  const userAgent = sanitise(request.userAgent);

  return {
    // Over the sanitised values, not the raw ones: a fingerprint that changed when a header grew
    // past the limit would show one device as two, on the screen whose whole job is recognising it.
    fingerprint: createHash('sha256').update(`${userAgent}\n${ip}`).digest('hex').slice(0, 32),
    ip,
    userAgent,
  };
}

/**
 * Both fields are attacker-chosen — the agent is a header, and behind the edge the address is one
 * (§03) — and both end up in a Redis hash, in a log line and on a screen. Control characters are
 * replaced rather than dropped so `curl\r\nX-Forged: yes` cannot close one field and open another
 * (§05), and the result is bounded so the store is not a place to put four kilobytes for free.
 */
function sanitise(value: string | undefined): string {
  const cleaned = (value ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, USER_AGENT_MAX_LENGTH);

  return cleaned.length === 0 ? UNKNOWN_DEVICE_FIELD : cleaned;
}
