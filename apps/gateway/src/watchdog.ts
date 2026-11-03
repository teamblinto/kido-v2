/**
 * The network-namespace watchdog (compose.vps.yaml: the gateway runs with `network_mode:
 * service:api`). When the api container restarts outside compose (a crash, `docker restart`),
 * Docker gives it a fresh network namespace; the gateway keeps the old one, where nothing listens
 * any more, so every preview fails until someone recreates it. Docker's own healthcheck only marks
 * it unhealthy. Exiting is the fix: `restart: unless-stopped` starts the same container again, and
 * a `container:` network mode is resolved at each start to `/proc/<api's current pid>/ns/net`
 * (moby `daemon/oci_linux.go`), i.e. the api's live namespace.
 *
 * Only a probe that gets no HTTP answer at all counts: a 503 from an api whose database is down is
 * a live namespace, and restarting the gateway would fix nothing. Failures inside `startPeriodMs`
 * are not counted, so a gateway that joined an api still booting is left alone; past it, a slow
 * boot costs at most one more restart, which is harmless.
 */
export interface WatchdogOptions {
  /** Consecutive failed probes, after the start period, that mean the namespace is dead. */
  readonly failures: number;
  readonly now: () => number;
  /** Called once. `main.ts` exits non-zero there. */
  readonly onDead: () => void;
  /** `true` when anything answered. */
  readonly probe: () => Promise<boolean>;
  readonly startPeriodMs: number;
}

/** One `tick` per probe interval; ticks must not overlap (the probe's timeout is under the interval). */
export function createWatchdog(opts: WatchdogOptions): { tick: () => Promise<void> } {
  const startedAt = opts.now();
  let failed = 0;
  let dead = false;

  return {
    async tick(): Promise<void> {
      if (dead) return;
      if (await opts.probe()) {
        failed = 0;
        return;
      }
      if (opts.now() - startedAt < opts.startPeriodMs) return;
      failed += 1;
      if (failed >= opts.failures) {
        dead = true;
        opts.onDead();
      }
    },
  };
}

/** Any HTTP response is `true`; a refused connect, a reset or a timeout is `false`. */
export function httpProbe(url: string, timeoutMs: number): () => Promise<boolean> {
  return () =>
    fetch(url, { signal: AbortSignal.timeout(timeoutMs) }).then(
      (response) => {
        // The body is not read; cancelled so the connection is not held until GC.
        void response.body?.cancel().catch(() => undefined);
        return true;
      },
      () => false,
    );
}
