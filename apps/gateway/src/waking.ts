import type { BrokerRouteResult, RouteRequestContext } from './broker-client.ts';
import { COULD_NOT_WAKE_PAGE, type Page, WAKING_PAGE } from './pages.ts';

export type WakeResult =
  Exclude<BrokerRouteResult, { kind: 'waking' }> | { kind: 'page'; page: Page };

/**
 * The waking flow (contract § 4, spec FR-029..FR-032, research R10/R12). The broker's `202` is the
 * resume trigger: the API enqueues one resume per label on that call, so the gateway's job is to
 * (1) render the waking page at once on a `202` — no retry, no upstream dial — and (2) never hammer
 * the broker: concurrent misses for one label (and visitor) share a single in-flight broker call.
 * A label that keeps answering `202` past `budgetMs`, or that the broker refuses after saying
 * `202`, gets the plain "could not be woken" page; the budget starts over on the next request so a
 * later resume can still succeed. An `unauthorised` answer passes through untouched and never
 * enters the waking state; the pipeline turns it into the grant exchange.
 */
export function createWaking(opts: {
  budgetMs: number;
  getRoute: (label: string, ctx: RouteRequestContext) => Promise<BrokerRouteResult>;
  max: number;
}) {
  const inflight = new Map<string, Promise<BrokerRouteResult>>();
  // ponytail: bounded by insertion order like RouteCache; entries are cleared on any non-202.
  const since = new Map<string, number>();

  return {
    /** Labels currently waiting on a resume (spec/e2e observability). */
    get pending(): readonly string[] {
      return [...since.keys()];
    },

    async resolve(label: string, ctx: RouteRequestContext): Promise<WakeResult> {
      // Keyed per visitor too: an unauthorised miss must not answer for a grant-carrying one.
      const key = `${label} ${ctx.grant ?? ''}`;
      let call = inflight.get(key);
      if (call === undefined) {
        call = opts.getRoute(label, ctx).finally(() => inflight.delete(key));
        inflight.set(key, call);
      }
      const answer = await call;
      const startedAt = since.get(label);
      if (answer.kind !== 'waking') {
        since.delete(label);
        // A refusal after a 202 is the resume failing (lost, errored): say so, without detail.
        return answer.kind === 'refused' && startedAt !== undefined
          ? { kind: 'page', page: COULD_NOT_WAKE_PAGE }
          : answer;
      }
      const now = Date.now();
      if (startedAt !== undefined && now - startedAt >= opts.budgetMs) {
        since.delete(label);
        return { kind: 'page', page: COULD_NOT_WAKE_PAGE };
      }
      if (startedAt === undefined) {
        if (since.size >= opts.max) {
          const oldest = since.keys().next().value;
          if (oldest !== undefined) {
            since.delete(oldest);
          }
        }
        since.set(label, now);
      }
      return { kind: 'page', page: WAKING_PAGE };
    },
  };
}

export type Waking = ReturnType<typeof createWaking>;
