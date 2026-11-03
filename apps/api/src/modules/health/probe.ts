/**
 * The compose healthcheck gives the endpoint 3 seconds, and every probe runs concurrently, so a
 * single probe gets half of that. The number matters less than the fact that there is one: §14's
 * standing rule is that "every outbound call has a timeout — connect, read and total. An unbounded
 * call is a latent outage", and a health check that hangs reports nothing at all, which reads to
 * Docker as the same failure with none of the detail.
 */
export const PROBE_TIMEOUT_MS = 1_500;

/**
 * A dependency that is unreachable does not always fail. A `pg` pool with no `connectionTimeout` and
 * an ioredis client with an offline queue both *wait*, and waiting is the one answer a health check
 * cannot give.
 */
export async function withProbeTimeout<T>(operation: Promise<T>, dependency: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${dependency} did not answer within ${PROBE_TIMEOUT_MS}ms`)),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The reason a probe failed, in a form safe to serve.
 *
 * `/api/v1/health` is not an authenticated endpoint, so the failure message is a public string. The
 * credential scrub is not there because a driver is known to leak one — it is there because the
 * message comes from a dependency we do not control and this endpoint is a bad place to find out.
 */
export function describeProbeFailure(error: unknown): { message: string } {
  const message = error instanceof Error ? error.message : String(error);

  return { message: message.replace(/\/\/[^@\s/]*@/g, '//***@') };
}
