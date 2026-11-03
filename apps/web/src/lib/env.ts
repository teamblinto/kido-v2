import { z } from 'zod';

const clientEnvironmentSchema = z.object({
  VITE_API_URL: z.union([z.url(), z.literal('')]).default(''),
  VITE_APP_NAME: z.string().trim().min(1).default('Production Monorepo'),
  /**
   * The name of the double-submit CSRF cookie, which this client reads and echoes back.
   *
   * It mirrors the API's `CSRF_COOKIE_NAME`, and the duplication is unavoidable rather than
   * careless: the value is only useful to code running in the browser, and the browser is given no
   * other way to learn it. Both default to `forge_csrf`, so the pair only has to be thought about
   * on a deployment that deliberately renames one.
   *
   * The session cookie is deliberately absent. This client never reads it — it cannot, and the
   * `__Host-` prefix is what guarantees that.
   */
  VITE_CSRF_COOKIE_NAME: z.string().trim().min(1).default('forge_csrf'),
  /**
   * The Cloudflare Turnstile site key, absent on every developer machine.
   *
   * Optional for the same reason `TURNSTILE_SECRET_KEY` is optional on the API: a deployment
   * without the pair runs the flows with no challenge at all, and `TurnstileGuard` logs once and
   * admits everybody. A widget rendered against no key would be a permanently failing control on
   * the signup form of every local checkout.
   */
  VITE_TURNSTILE_SITE_KEY: z.string().trim().min(1).optional(),
});

const result = clientEnvironmentSchema.safeParse(import.meta.env);

if (!result.success) {
  throw new Error(`Invalid client environment: ${z.prettifyError(result.error)}`);
}

export const env = result.data;
