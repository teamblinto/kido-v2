/**
 * Injection tokens for the database layer.
 *
 * Symbols rather than strings: two of these are handed to `@Inject()` in every module written from
 * here on, and a string token collides silently with any other package that picks the same word.
 */

/** Drizzle over the `forge_app` pool — the request path, subject to every RLS policy. */
export const APP_DATABASE = Symbol('forge.database.app');

/** The `pg` pool behind `APP_DATABASE`. Injected for health checks and for shutdown. */
export const APP_POOL = Symbol('forge.database.app.pool');

/**
 * Drizzle over the `forge_bypass` pool. `BYPASSRLS`, so it sees every tenant: §09 permits exactly
 * four uses — audit export, usage rollups, the future outbox relay, and (spec 017) the preview
 * broker's one-row probe of `projects_preview_label_key` to learn which tenant a label belongs to
 * before every further read runs under that tenant's transaction — on a separate pool, with every
 * statement audited. It is never the request path.
 */
export const BYPASS_DATABASE = Symbol('forge.database.bypass');

/** The `pg` pool behind `BYPASS_DATABASE`. */
export const BYPASS_POOL = Symbol('forge.database.bypass.pool');

/**
 * The port that answers "which tenant is this request for?". T06 ships the implementation that
 * always answers "none"; T15 teaches it to read the session and T26 to derive the org from the
 * resource being touched, which is the only derivation §11 allows.
 */
export const TENANT_SCOPE_RESOLVER = Symbol('forge.database.tenantScopeResolver');
