import type { INestApplication } from '@nestjs/common';

/**
 * One route, as the running application actually serves it.
 *
 * The path is post-prefix and post-version — `/api/v1/orgs/:orgId/members`, not `orgs/:orgId/members`
 * — because it is read off the router Nest built, after `setGlobalPrefix` and `enableVersioning`
 * have had their say. That matters: a suite that rebuilt paths from `@Controller()` metadata would
 * be asserting against a URL space nobody serves.
 */
export interface EnumeratedRoute {
  /** Upper case, as it appears in a request line. */
  readonly method: string;
  /** `['orgId', 'projectId']` for `/api/v1/orgs/:orgId/projects/:projectId`. In path order. */
  readonly parameters: readonly string[];
  readonly path: string;
}

/** `:orgId` in `/api/v1/orgs/:orgId/members`. */
const PARAMETER = /:([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * A path made only of literal segments and `:name` parameters — which every route a controller
 * declares is.
 *
 * The router also carries paths that are not routes at all. `setGlobalPrefix` registers
 * `/api/{*path}`, `/api/*splat` and `/api$` across every method Express knows, so that a request
 * under the prefix which matches no controller is answered by Nest rather than falling through. They
 * are scaffolding, they take no parameters, and pointing a cross-tenant probe at one would be
 * pointing it at a 404.
 *
 * They are recognised by shape rather than by name, and {@link partitionRoutes} hands them back
 * separately instead of dropping them — so the isolation suite can assert that the set of things it
 * declined to probe is still exactly the set it was told about, and a future non-plain path has to
 * be looked at by a person before the gate will pass again.
 */
const APPLICATION_PATH = /^(?:\/(?:[A-Za-z0-9_.~-]+|:[A-Za-z_][A-Za-z0-9_]*))+$/;

/**
 * Express does not publish its router, so every property this file touches is read structurally and
 * every absence is an error rather than an empty result. That asymmetry is the whole point: an
 * enumerator that quietly returns `[]` when Express changes shape turns the isolation gate into a
 * suite that passes by testing nothing.
 */
interface LayerLike {
  readonly handle?: unknown;
  readonly route?: {
    readonly methods?: Readonly<Record<string, boolean>>;
    readonly path?: unknown;
  };
}

interface RouterLike {
  readonly stack?: readonly LayerLike[];
}

/** Express 5 exposes `app.router`; Express 4 kept it on `app._router`. Both are handled. */
interface ExpressLike {
  readonly _router?: RouterLike;
  readonly router?: RouterLike;
}

/**
 * The router could not be read, so the suite knows nothing about what it is meant to be covering.
 *
 * Thrown rather than returned, and never caught by {@link enumerateRoutes}'s callers, because the
 * failure mode this class exists to prevent is silent: a Nest or Express upgrade that moves the
 * route table would otherwise leave the tenant-isolation suite green over an empty list.
 */
export class RouterNotEnumerableError extends Error {
  constructor(reason: string) {
    super(
      `Cannot enumerate the Nest router: ${reason}. The tenant-isolation gate is enumerated from ` +
        'the router at runtime, so this is a hard failure rather than an empty route list — ' +
        'teach test/support/route-enumerator.ts the new shape before trusting the suite again.',
    );
    this.name = 'RouterNotEnumerableError';
  }
}

/**
 * Every route the application serves, read from the router Nest built.
 *
 * This is the one property T32 is really about. A hand-written array of paths is a snapshot of the
 * day somebody wrote it: the route added six months later is not in it, the suite stays green, and
 * the gate has decayed into a test of history. Reading the router means a new controller is covered
 * the moment it is mounted, and a new *parameter* the fixture cannot point at the other tenant fails
 * the suite until somebody decides what it means.
 *
 * `app.init()` must have run: Nest registers handlers on the adapter during initialisation, and
 * before that the router is empty — which is exactly the silent-emptiness case
 * {@link RouterNotEnumerableError} is here to make loud.
 */
export function enumerateRoutes(app: INestApplication): EnumeratedRoute[] {
  const instance = app.getHttpAdapter().getInstance() as ExpressLike;
  const stack = (instance.router ?? instance._router)?.stack;

  if (stack === undefined) {
    throw new RouterNotEnumerableError('neither app.router nor app._router carries a stack');
  }

  const routes = new Map<string, EnumeratedRoute>();

  for (const layer of stack) {
    // A mounted sub-router. Nest does not use one today, so rather than guess at its mount prefix —
    // which Express only materialises while a request is being matched — this refuses. Under-
    // reporting here would hide a whole controller from the gate; failing says so.
    if (isSubRouter(layer)) {
      throw new RouterNotEnumerableError(
        'the stack contains a mounted sub-router, whose prefix this enumerator cannot reconstruct',
      );
    }

    if (layer.route === undefined) {
      continue;
    }

    for (const path of pathsOf(layer.route.path)) {
      for (const method of methodsOf(layer.route.methods)) {
        routes.set(`${method} ${path}`, { method, parameters: parametersOf(path), path });
      }
    }
  }

  if (routes.size === 0) {
    throw new RouterNotEnumerableError('the router carries no routes at all');
  }

  // Sorted so a failure names the same route on every machine and a diff of the covered set is
  // readable. By path first, because that is how a reader looks for one.
  return [...routes.values()].sort(
    (left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method),
  );
}

/**
 * The router's contents, split into the routes controllers declared and the prefix scaffolding
 * Express was handed by `setGlobalPrefix`.
 *
 * Both halves are returned. The suite probes the first and asserts the second is unchanged, which is
 * what stops "we skipped it" from silently growing into "we skipped most of it".
 */
export function partitionRoutes(routes: readonly EnumeratedRoute[]): {
  application: EnumeratedRoute[];
  scaffolding: EnumeratedRoute[];
} {
  return {
    application: routes.filter((route) => APPLICATION_PATH.test(route.path)),
    scaffolding: routes.filter((route) => !APPLICATION_PATH.test(route.path)),
  };
}

/** The parameter names in a registered path, in the order they appear. */
export function parametersOf(path: string): string[] {
  return [...path.matchAll(PARAMETER)].map(([, name]) => name!);
}

/**
 * Substitute every `:name` with a value, failing loudly on a parameter nobody supplied.
 *
 * The throw is deliberate. Leaving an unsubstituted `:projectId` in the URL produces a request that
 * matches the route and carries a literal colon where an id should be — which is refused for a
 * reason that has nothing to do with tenancy, and would let the gate pass on a route it never
 * really exercised.
 */
export function fillRoutePath(path: string, values: Readonly<Record<string, string>>): string {
  return path.replace(PARAMETER, (_match, name: string) => {
    const value = values[name];

    if (value === undefined) {
      throw new Error(`no value supplied for the :${name} parameter of ${path}`);
    }

    return value;
  });
}

/** Express allows an array of paths on one route; Nest registers one, and both are read. */
function pathsOf(path: unknown): string[] {
  if (typeof path === 'string') {
    return [path];
  }

  if (Array.isArray(path) && path.every((entry) => typeof entry === 'string')) {
    return path;
  }

  throw new RouterNotEnumerableError(`a route carries a path of type ${typeof path}`);
}

/** `_all` is Express's book-keeping for `router.all()`, not a method anybody can send. */
function methodsOf(methods: Readonly<Record<string, boolean>> | undefined): string[] {
  if (methods === undefined) {
    throw new RouterNotEnumerableError('a route carries no method table');
  }

  const named = Object.entries(methods)
    .filter(([method, enabled]) => enabled && method !== '_all')
    .map(([method]) => method.toUpperCase());

  if (named.length === 0) {
    throw new RouterNotEnumerableError('a route carries an empty method table');
  }

  return named;
}

function isSubRouter(layer: LayerLike): boolean {
  const handle = layer.handle as { stack?: unknown } | undefined;

  return layer.route === undefined && Array.isArray(handle?.stack) && handle.stack.length > 0;
}
