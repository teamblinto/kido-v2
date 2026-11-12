# 046 — The platform as a remote MCP server

**Status** Built; unit, Postgres/Redis-backed e2e and tenant-isolation suites green locally,
2026-11-12. Verified live with the official MCP TypeScript client (v2.4) doing its own discovery,
dynamic registration, PKCE and token exchange against a running API. Not yet verified from
claude.ai, ChatGPT or Cursor against a public deployment.
**Architecture reference** §08 (guards), §10 (problems), §13 (tenancy), §14.7 (CSRF).
**Depends on** 008 (runs), 016 (checkpoints), 017 (preview), 022 (files), 024 (file write), 027
(deploy), 030/045 (connectors), 043 (subscription-only runs), 044 (GitHub sync).

## Why

Everything the product does was reachable only from its own web app, behind a cookie session. A
person who works in Claude, ChatGPT, Cursor or VS Code could not say "build me a SaaS landing page
and deploy it" there and have it happen here. MCP is the protocol those clients share, so the
platform becomes an MCP server: one connection, authorized by the person in their browser, and the
agent can create, build, inspect, fix, integrate and ship projects end to end.

## Decisions

- **One endpoint, stateless.** `POST /api/v1/mcp`, Streamable HTTP, SDK v2
  (`@modelcontextprotocol/server` 2.4 + `/node` 2.1, implementing spec 2026-07-28 and serving
  2025-era clients through its stateless legacy leg). Each request builds a fresh `McpServer` for
  its verified principal (`McpServerFactory`), so any API replica answers any request and no
  connection state lives in memory. GET/DELETE answer 405, as the SDK does when stateless.
- **Our own OAuth 2.1 authorization server, not an external IdP.** SDK v2 ships no authorization
  server; the product already owns identity, MFA and sessions, and an IdP would add a service to
  `compose.yaml` (ask-first). The server is small and standard:
  - Discovery: RFC 8414 at `/.well-known/oauth-authorization-server` (issuer = `APP_URL`'s
    origin) and RFC 9728 at `/.well-known/oauth-protected-resource/api/v1/mcp` and the bare path.
    Both are excluded from the `/api` prefix; Caddy and Vite send those two paths to the API.
  - Registration: RFC 7591 dynamic registration, **public clients only**
    (`token_endpoint_auth_method: none`). Redirect URIs must be https, loopback http, or a
    private-use app scheme; loopback matches on any port (RFC 8252 §7.3). CIMD is not advertised:
    every client we target falls back to DCR.
  - Authorization: the `authorization_endpoint` is the web page `/oauth/authorize`, which relays
    the request to `POST /api/v1/oauth/authorize[/preview]` under the person's session and CSRF.
    PKCE S256 only. The person picks the **one organisation** the grant may act in, and sees the
    client's name, redirect host and scopes. Deny returns `access_denied`; both carry `state` and
    `iss` (RFC 9207). An unknown client or unregistered redirect is never redirected to
    (`mcp-authorization-invalid`, shown on the page).
  - Codes: 32 random bytes, stored as `mcp:code:<sha256>` in the session Redis for 60 s, read with
    `GETDEL`, so a wrong verifier burns the code.
  - Tokens: opaque `mcp_at_…` (1 h) and `mcp_rt_…` (30 d, rotating), stored as SHA-256 in
    `mcp_grants`, like the `bld_` device token. A replayed, rotated-out refresh token revokes the
    whole grant (OAuth 2.1 §4.3.1). Tokens are bound to the one resource; a `resource` naming
    anything else is refused (RFC 8707). RFC 7009 revocation answers 200 whatever it was given.
- **A token is never more than the person.** Every tool checks three things independently, as the
  HTTP routes do: the token's scope (the SDK's `requireScopes`, answered as an RFC 6750
  `insufficient_scope` 403), the person's RBAC permission resolved afresh for this call
  (`PermissionResolutionService.for`, the same permission the equivalent route demands), and RLS
  under `runInTenantScope`. Leaving the org or losing a role takes effect on the next call; a
  refresh also re-checks membership.
- **Three scopes**, by consequence: `projects:read`, `projects:write` (build, edit, run commands,
  restore, GitHub, integrations), `projects:deploy` (deploy, release, offline, Netlify publish).
  Unknown requested scopes are dropped; asking for none of ours means all three, which the consent
  screen states.
- **Tables.** `mcp_clients` is a root (a registration belongs to nobody). `mcp_grants` is
  tenant-owned with the §09 RLS shape; the bearer lookup reads it by hash through `forge_bypass`,
  every write runs in the grant's tenant transaction (`0058`, `0059`).
- **Tools reuse services, never re-implement them.** `McpPlatform` names the services the surface
  may call; each tool mirrors the controller of its HTTP route. Two seams were opened for it:
  `PreviewReader` (the preview controller's read, extracted unchanged) and module exports of
  `FilesService`, `DeploymentService`, `SiteService`, `DatabaseMigrationService`,
  `ConnectorListings`. Things the HTTP API does not allow are not added: no env-var editing (the
  values come from bindings), no provider-token paste (a token must never pass through a model;
  `list_integrations` points the person to Settings → Connectors).
- **`run_command` is the build agent's own `exec`**: the same allowlist and shell-operator guard
  (`SandboxPort.exec`), the same `scrubSecrets` on output, refused while a run is active. It writes
  no checkpoint; the next save or run records the tree.
- **Long work is a handle plus a bounded wait.** `start_agent_run`, `deploy_project` and
  `sync_github` return at once; `waitSeconds` (≤ 50, under client tool timeouts) polls with a fresh
  transaction per poll and streams `notifications/progress` on the request's own SSE response.
  Cancelling the call stops the wait, not the work. The agent loops with `sinceSeq` to get only
  new run activity. The MCP Tasks extension is not used: no client we target implements it and the
  SDK's server packages do not either.
- **Idempotency** reuses `IdempotencyStore` (the `Idempotency-Key` store), namespaced
  `mcp.<userId>` and fingerprinted on tool + arguments. Required on `deploy_project` and
  `restore_checkpoint` (their routes require it), optional on `create_project`,
  `start_agent_run`, `sync_github`.
- **Errors are results, not protocol failures.** A `DomainError` becomes `isError: true` with the
  problem title, detail and a next step keyed by slug (e.g. `subscription-not-connected` → stop and
  tell the person to connect a subscription or key). Unexpected errors are logged and reported
  without internals.
- **Limits.** Per grant 300 calls/min (`McpGrantThrottlerGuard`), per address 3 000/min on the MCP
  route because hosted clients share egress addresses; token 60/min, register 10/min, revoke
  30/min per address. Same in-memory throttler as every other route.
- **Audit.** `mcp.client-authorized` and `mcp.client-revoked` (by user, by client, or on refresh
  replay) in the grant's org. Every tool call is one structured log line (tool, grant, client,
  user, org, outcome, duration); mutations are audited by the services that perform them, with the
  person as actor, exactly as from the web app.
- **Edge.** The MCP route bypasses `compression` (it would hold SSE progress until the end) and
  sets `X-Accel-Buffering: no`; Caddy flushes `/api/v1/mcp` like the run stream.

## Surface

39 tools (`apps/api/src/modules/mcp/server/tools/`), 3 prompts (`build_app`, `fix_errors`,
`deploy_app`), 1 resource template (`baios://projects/{projectId}/files/{+path}`), and server
instructions describing the workflow. The tool reference is [`docs/mcp.md`](../../mcp.md).

## Web

- `/oauth/authorize`: the consent page (`oauth-authorize-page.tsx`).
- `/settings/mcp` ("AI agents"): server URL, per-client setup for Claude Code, Claude, ChatGPT,
  Cursor and VS Code, and the person's connected agents with revoke.

## Not done

- CIMD (client ID metadata documents) and a pre-registered-client path; the hosted clients fall
  back to DCR. Stale DCR registrations are not swept (`mcp_clients` grows by one per fresh connect).
- Admins cannot see or revoke other members' grants; each person manages their own.
- No tools for custom domains, Neon branch reset, sync commit or repo-link changes.
- The throttler is in-memory per process, as everywhere in the API.

## Success criteria

| #      | Criterion                                                                             | Proved by                                                                                                           |
| ------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| SC-001 | Discovery documents are served at the origin root with S256, DCR and the resource     | `mcp.e2e-spec.ts` › "publishes RFC 8414 and RFC 9728 discovery documents at the origin root"                        |
| SC-002 | An unauthenticated or forged-token MCP call gets 401 with the RFC 9728 challenge      | `mcp.e2e-spec.ts` › "answers an unauthenticated MCP request 401 with the resource-metadata challenge"               |
| SC-003 | Only public clients with safe redirect URIs can register                              | `mcp.e2e-spec.ts` › "registers public clients only, and only with safe redirect URIs"; `oauth-rules.spec.ts`        |
| SC-004 | Consent shows the client and scopes; unregistered redirects are refused               | `mcp.e2e-spec.ts` › "shows the consent screen, and refuses a redirect URI the client did not register"              |
| SC-005 | Deny returns `access_denied` with `state` and `iss`, and no code                      | `mcp.e2e-spec.ts` › "sends a denial back to the client as access_denied with its state and our issuer"              |
| SC-006 | A person cannot grant access to an org they do not belong to                          | `mcp.e2e-spec.ts` › "refuses to let a person connect an organization they do not belong to"                         |
| SC-007 | A code is single-use and needs its PKCE verifier                                      | `mcp.e2e-spec.ts` › "redeems a code once, and only with the matching PKCE verifier"; `oauth-rules.spec.ts`          |
| SC-008 | Tools act as the person, in the grant's org only; another tenant's project is refused | `mcp.e2e-spec.ts` › "lists every tool with annotations, and runs them as the person in their own organization only" |
| SC-009 | A tool outside the grant's scopes is refused with `insufficient_scope`                | `mcp.e2e-spec.ts` › "refuses a tool whose scope the grant does not carry"                                           |
| SC-010 | Refresh rotates; replaying a retired refresh token revokes the grant                  | `mcp.e2e-spec.ts` › "rotates refresh tokens, and revokes the whole grant when a retired one is replayed"            |
| SC-011 | The person can list and revoke their agents; revocation is immediate and audited      | `mcp.e2e-spec.ts` › "lets the person see and revoke a connected agent, which locks it out at once"                  |
| SC-012 | Every new route is probed or excused in the tenant-isolation gate                     | `tenant-isolation.e2e-spec.ts` (`:grantId` swept against a beta grant)                                              |
| SC-013 | `mcp_grants` has forced RLS; `mcp_clients` is a root                                  | `rls.spec.ts`, `schema.spec.ts`                                                                                     |
| SC-014 | Consent and settings pages behave (sign-in redirect, allow/deny, list, revoke)        | `oauth-authorize-page.test.tsx`, `mcp-settings-page.test.tsx`                                                       |
| SC-015 | A real MCP client completes discovery → DCR → PKCE → tools, with streamed progress    | Manual: official `@modelcontextprotocol/client` 2.4 against a live API, 2026-11-12 (see Status)                     |
| SC-016 | Works from claude.ai, ChatGPT and Cursor against a public deployment                  | ✗ — needs a publicly reachable deployment; not run                                                                  |
