# Postman collection

The API in `apps/api`, as a collection you can import and send. Forty requests across thirteen
folders, covering every route the application exposes.

```text
apps/api/postman/
  forge-api.postman_collection.json          The collection
  environments/
    local.postman_environment.json           pnpm dev            -> http://localhost:3000/api/v1
    docker-compose.postman_environment.json  docker compose up   -> http://localhost:8080/api/v1
```

## Quick start

1. **Import.** Postman ▸ Import ▸ drop in `forge-api.postman_collection.json` and both files under
   `environments/`.
2. **Select an environment** from the picker, top right: _Forge API — Local (pnpm dev)_ if you are
   running `pnpm dev`, _Forge API — Docker Compose_ if you are running the container stack.
3. **Fill in `userEmail` and `userPassword`** — in the **Current value** column only. See
   [Keeping secrets out of the repository](#keeping-secrets-out-of-the-repository) for why that
   column and not the other one. No account yet? See [Getting an account](#getting-an-account).
4. **Send anything.** The first request that needs a session signs in for you.

There is no fourth step. You never have to run _Sign in_ by hand, copy a token between requests, or
configure auth on a request.

## How authentication works here, and what the collection does about it

This API issues **no bearer token**. A sign-in returns an opaque session token in a cookie —
`Secure`, `HttpOnly`, and named with the `__Host-` prefix — and keeps the session itself in Redis
(ADR 001). On top of that, **every unsafe request needs two more things**: a double-submit CSRF
token (the `forge_csrf` cookie, echoed back in `X-CSRF-Token`) and an `Origin` the API allows. Both
are required and neither is a fallback for the other, because their failure modes have nothing in
common — see `apps/api/src/common/csrf/csrf.middleware.ts`.

Postman is not a browser, so the **collection pre-request script** plays the part of one. On any
request that needs it, in order:

| Step | What it does                                                               | Why it works                                                                     |
| ---- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1    | `GET /` and read the `forge_csrf` cookie off the response                  | The CSRF middleware issues a token to any caller that presents none              |
| 2    | `POST /auth/login` with `userEmail` / `userPassword`, capture `Set-Cookie` | Only when no live session token is stored                                        |
| 3    | Attach `Cookie`, `X-CSRF-Token` and `Origin` to the outgoing request       | `X-CSRF-Token` on unsafe methods only, which is where the middleware requires it |

Step 1 has to be its own request: the refusal an unsafe request without a token would earn is the
thing being avoided. The server keeps no record of the CSRF token — the double submit asks only
whether the cookie and the header agree, which is exactly why the `Origin` check is required
alongside it.

When both tokens are already in hand the script takes a fully synchronous fast path and sends
nothing extra, so the cost is one round trip per session, not per request.

### Why an explicit `Cookie` header instead of Postman's cookie jar

Both cookies are `Secure`. Browsers special-case `http://localhost` and `http://127.0.0.1` as
trustworthy origins, which is what lets the real cookie attributes work unchanged over plain HTTP in
development (the root `README.md` explains this at length under _Quick start_). **Postman gives
`http://localhost` no such exemption.** A jar-managed session cookie would be stored and then never
sent to a local API over plain HTTP, and every request after sign-in would look unauthenticated for
a reason nothing in the response explains.

Capturing the token out of `Set-Cookie` and sending it back as an explicit header sidesteps that
entirely, and it works identically against a local HTTP API and an HTTPS deployment. If the jar does
hold the same cookies, the values agree with the ones the script sends, so the duplicate is inert.

### Requests inherit "No Auth", deliberately

None of this is one of Postman's built-in auth schemes, so the collection is set to **No Auth** and
the pre-request script owns the handshake. That is the single place to change it, and no request
carries credentials of its own — a `Cookie`, `Origin`, `X-CSRF-Token` or `Authorization` header
hardcoded on a request would be a second, invisible source of truth.

## Getting an account

`pnpm --filter @repo/db db:seed` creates the development organisation and an owner, but **gives it no
password** — it exists to own seeded rows, not to sign in. So make your own account through the API.
Run the **Account bootstrap** folder in order:

1. **Sign up.** `202`, and note that it answers `202` whether or not the address already has an
   account — the endpoint is deliberately not an account oracle, so a `202` is not evidence the
   account is new.
2. **Read the token out of the API log.** With `MAIL_PROVIDER=console` — the default, and refused on
   anything but a local deployment — the API prints each mail to stdout instead of sending it. Find
   the verification link in the terminal running `pnpm dev` and copy its `token` query parameter into
   the `verificationToken` environment variable:

   ```text
   http://localhost:5173/auth/verify?token=THIS_PART
   ```

3. **Verify email.** `200 { "status": "verified" }`.

Now put the same address and password in `userEmail` and `userPassword`, and everything else in the
collection works. The password must be at least 12 characters and is additionally checked
server-side for strength, breach membership and reuse of personal information — those refusals are
`password-too-weak`, `password-breached` and `password-uses-personal-information`.

The password reset and invitation flows work the same way: the token arrives in the log, and goes in
`resetToken` or `invitationToken`.

## Variables

Everything lives in the environment; the collection declares none. Deployment-shaped values ship
with real defaults, secrets ship empty, and the rest are captured for you as you go.

### Set once, per environment

| Variable                       | Local default                  | Notes                                                                                                                   |
| ------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`                      | `http://localhost:3000/api/v1` | Origin plus `API_PREFIX` and the version segment. Request paths start after it                                          |
| `appOrigin`                    | `http://localhost:5173`        | Sent as `Origin`. **Must** appear in the API's `CORS_ORIGINS` — the same list backs CORS and the CSRF origin check      |
| `sessionCookieName`            | `__Host-forge_session`         | The API's `SESSION_COOKIE_NAME`. Keeps the `__Host-` prefix; the API refuses to start without it                        |
| `csrfCookieName`               | `forge_csrf`                   | The API's `CSRF_COOKIE_NAME`. Must **not** carry the `__Host-` prefix — the client has to be able to read it            |
| `autoSignIn`                   | `true`                         | Set to `false` to stop the script signing in on demand and leave the session under the control of the _Sign in_ request |
| `orgName`, `orgSlug`           | `Acme Rockets`, `acme-rockets` | What _Create organisation_ sends. The slug is globally unique, so change it before a second run                         |
| `workspaceName`, `projectName` | `Launch`, `Storefront`         | What the create and rename requests send. Trimmed, 1–120 characters                                                     |
| `projectTemplate`              | `vite-react`                   | One of `vite-react`, `nextjs`, `node-api`, `python`. Immutable once the project exists                                  |

### You fill in

`userEmail`, `userPassword`, `newPassword`, `inviteEmail`, `verificationToken`, `resetToken`,
`invitationToken`, `totpCode`, `idempotencyKey`, `turnstileToken`, `oauthCode`, `oauthState`.

`totpCode` is worth a word: a TOTP code is valid for one 30-second step, so set it immediately
before sending. A recovery code works anywhere a TOTP code does, and _Confirm TOTP enrolment_ leaves
the first of yours in `recoveryCode`.

### Captured for you

| Variable                                                | Written by                                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `sessionToken`, `sessionExpiresAt`                      | The sign-in script, and the three routes that rotate the cookie                   |
| `csrfToken`                                             | The CSRF bootstrap                                                                |
| `currentUserId`                                         | _Sign in_, _Current user_, _Complete MFA challenge_                               |
| `orgId`                                                 | _Create organisation_; _List organisations_ when empty                            |
| `memberUserId`                                          | _List members_ — a member other than the caller                                   |
| `workspaceId`, `projectId`, `sessionId`, `invitationId` | The corresponding list and create requests; cleared again by the archive requests |

`sessionExpiresAt` comes from the session cookie's own `Max-Age`, not from a guess, and an expired
token is treated as absent — so the next request signs in again rather than spending a round trip
discovering a `401`. A `401` from anywhere has the same effect, via the collection test script.

## Keeping secrets out of the repository

Postman gives every variable two columns, and the distinction is the whole mechanism:

- **Initial value** is shared. It is what an export writes to the file, and what a teammate gets on
  import.
- **Current value** is local to your Postman installation. It is never exported and never synced.

**Put every secret in the Current value column only.** In the committed files, each secret is typed
`secret` (so Postman masks it) and ships **empty** — `userPassword`, `sessionToken`, `csrfToken`,
`newPassword`, the three mail tokens, `totpCode`, `recoveryCode`, `turnstileToken`, `oauthCode`,
`oauthState`. If you export an environment after filling those in, check the diff before committing;
if it is your own scratch environment, name it so `.gitignore` catches it:

```text
*.local.postman_environment.json
```

Two more things the collection does not do, on purpose: nothing is written to a **collection**
variable, because collection variables are exported with the collection itself; and the collection
test script asserts on every response that the session token **never appears in a body**, which is a
promise the API makes (spec 001, criterion 3) and worth checking from the client side.

## Running it from the command line

```bash
pnpm dlx newman run apps/api/postman/forge-api.postman_collection.json \
  -e apps/api/postman/environments/local.postman_environment.json \
  --env-var "userEmail=$FORGE_EMAIL" \
  --env-var "userPassword=$FORGE_PASSWORD" \
  --folder Service --folder Authentication --folder Organisations
```

Pass credentials as `--env-var`, never by committing them to the environment file.

**A whole-collection run is not a passing suite, and is not meant to be.** Several requests need a
value only a human can supply — a token printed in a log, a code from an authenticator app, an OAuth
round trip — and others are destructive by design (_Remove member_, _Revoke a device session_,
_Disable TOTP_, _Archive workspace_, _Archive project_ — an archive is permanent; there is no unarchive
route). Run the folders you mean, as above. The folders that pass unattended against a
signed-in account are **Service**, **Authentication**, **Signed-in devices**, **Organisations**,
**Projects** and **Workspaces** — in that order, because _Archive workspace_ closes the Workspaces
folder and takes the workspace's projects with it.

## Troubleshooting

| Symptom                                           | Cause and fix                                                                                                                                                    |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `403 csrf-check-failed`                           | `appOrigin` is not in the API's `CORS_ORIGINS`, or `csrfCookieName` disagrees with `CSRF_COOKIE_NAME`. A missing origin fails here rather than as a CORS error   |
| `401 unauthorized` on every request               | The sign-in did not happen. Open the Postman Console (`Ctrl`/`Cmd` + `Alt` + `C`) — the script logs `[auth]` lines saying exactly what it did and why            |
| `500` on sign-in, and `/health` answers `503`     | Postgres or Redis is down. `docker compose up -d postgres redis-session redis-cache redis-queue`, then `pnpm --filter @repo/db db:migrate`                       |
| `403 email-not-verified`                          | Finish **Account bootstrap** — the token is in the API log                                                                                                       |
| `404 not-found` from a workspace or project write | It is archived, or `workspaceId`/`projectId` is stale. Archived and unknown are deliberately one answer; re-run the list request to pick a live id               |
| `403 step-up-required`                            | Run **Step up** first; the window is about five minutes                                                                                                          |
| `409 conflict` from _Create organisation_         | The slug is globally unique. Change `orgSlug`, or enable the `Idempotency-Key` header to replay the first response instead                                       |
| `429 rate-limited`                                | Working as intended — sign-in, verification resend and password reset are throttled per account and per IP with a progressive delay. `Retry-After` says how long |
| A redirect test fails on the OAuth folder         | Turn off **Settings ▸ General ▸ Automatically follow redirects**, or Postman chases the `Location` into the provider                                             |
| Requests work but Postman shows no cookies        | Expected. The script sends them as an explicit header; the jar is not used                                                                                       |

## Maintaining this

Edit in Postman, then export back over the same paths — same file names, same collection and
environment ids, so a re-import updates in place instead of creating a duplicate.

`apps/api/postman/*.json` is in `.prettierignore`. These files are round-tripped through Postman's
exporter, which owns their formatting; reformatting them would leave `pnpm format:check` red after
every export, for a diff nobody reads. This `README.md` is not exempt.

When you add a route to the API, three things keep this collection honest:

1. Add the request to the folder its controller belongs to, with a description that says what the
   route needs — permission, step-up, verified address.
2. If the route is `@Public()` **and** needs no session, add its path to `SESSIONLESS_PATHS` in the
   collection pre-request script. Otherwise the script signs in before it, which is wasteful for a
   public route and wrong for one whose point is to be unauthenticated.
3. If the route writes a session cookie, capture it in the request's test script — as _Sign in_,
   _Complete MFA challenge_ and _Provider callback_ do. A rotated cookie the environment does not
   know about leaves a stale token behind and the next request `401`s.
