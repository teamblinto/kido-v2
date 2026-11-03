/**
 * R10: the provider circuit breaker as three pure functions over the two `connections` columns.
 * Durable because the columns are on the org's row; per organisation by construction.
 */
export interface CircuitState {
  readonly circuitOpenUntil: Date | null;
  readonly failureCount: number;
}

// ponytail: fixed 5/10m — make it per-connection config if a tenant ever needs it
export const FAILURES_TO_OPEN = 5;
export const CIRCUIT_OPEN_MS = 10 * 60_000;

/** One more transient failure: at the threshold (and every failure past it) the window restarts. */
export function afterFailure(row: CircuitState, now: Date): CircuitState {
  const failureCount = row.failureCount + 1;

  return {
    circuitOpenUntil:
      failureCount >= FAILURES_TO_OPEN ? new Date(now.getTime() + CIRCUIT_OPEN_MS) : null,
    failureCount,
  };
}

export function afterSuccess(): CircuitState {
  return { circuitOpenUntil: null, failureCount: 0 };
}

export function isOpen(row: CircuitState, now: Date): boolean {
  return row.circuitOpenUntil !== null && row.circuitOpenUntil.getTime() > now.getTime();
}

/** Whole seconds until the window closes, never below 1 — the `Retry-After` header value. */
export function retryAfterSeconds(row: CircuitState, now: Date): number {
  const remainingMs = (row.circuitOpenUntil?.getTime() ?? 0) - now.getTime();

  return Math.max(1, Math.ceil(remainingMs / 1000));
}
