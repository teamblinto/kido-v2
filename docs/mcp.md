# Connecting AI agents (MCP)

The platform is a remote [Model Context Protocol](https://modelcontextprotocol.io) server. Connect
Claude, ChatGPT, Cursor, VS Code or any MCP client to your account and ask it, in plain language,
to build, change, debug, integrate and deploy your projects. The agent does the work here, through
the same build agent, workspaces, checkpoints and deploys you use in the web app.

- **Server URL:** `https://<your app host>/api/v1/mcp` (Streamable HTTP). The exact URL, with copy
  buttons and per-client snippets, is in the web app under **Settings → AI agents**.
- **Authorization:** OAuth 2.1. Your client opens a sign-in page here, you choose the organization
  and approve. No API keys to copy.

Design and decisions: [spec 046](specs/046-mcp-server/spec.md).

## Connect your client

Replace `<url>` with your server URL. The first time the client connects, it opens the consent page
in your browser.

| Client                                  | How                                                                                                                                                                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code**                         | `claude mcp add --transport http baios <url>`, then run `/mcp` inside Claude Code and choose **Authenticate**. Add `--scope project` to share it through `.mcp.json`.       |
| **Claude (claude.ai, Desktop, mobile)** | Settings → Connectors → **Add custom connector** → paste `<url>` → Connect.                                                                                                 |
| **ChatGPT**                             | Settings → Apps & Connectors → Advanced → turn on **Developer mode**, then **Create** → paste `<url>`, authentication **OAuth**. Availability depends on your ChatGPT plan. |
| **Cursor**                              | `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a repo): `{"mcpServers": {"baios": {"url": "<url>"}}}`                                                                       |
| **VS Code (Copilot agent mode)**        | `.vscode/mcp.json`: `{"servers": {"baios": {"type": "http", "url": "<url>"}}}`, then **Start** on the server.                                                               |
| **Anything else**                       | Any client that supports Streamable HTTP and the MCP authorization spec (dynamic client registration + PKCE).                                                               |

### What you approve

The consent page shows the client's name, where it will send the result (its redirect host), the
**one organization** it may act in, and what it may do:

| Scope             | Allows                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `projects:read`   | See projects, files, conversations, previews, checkpoints, deployments, integrations                                         |
| `projects:write`  | Run the build agent, edit files, run commands, restore checkpoints, sync GitHub, manage integrations and database migrations |
| `projects:deploy` | Deploy, release or take a site offline, publish to Netlify                                                                   |

A connected agent can never do more than **you** can: every call is checked against your current
role in the organization and project, exactly as the web app is. Losing access in the web app
takes effect on the agent's next call.

### Manage and revoke

**Settings → AI agents** lists every agent you connected to the current organization, its scopes
and when it was last used. **Revoke** cuts it off immediately. Each authorization is recorded in
the organization's audit log (`mcp.client-authorized`, `mcp.client-revoked`).

## What you can ask

> Build me a SaaS landing page with sign-up and a pricing table.

> Add a dashboard with subscription management to the "Acme" project.

> Connect my project to Supabase and set up email/password authentication.

> The preview is broken — find the errors and fix them.

> Deploy Acme and give me the URL. Then push it to GitHub.

The client also offers three ready-made prompts: **Build a new app** (`build_app`), **Fix errors**
(`fix_errors`) and **Deploy** (`deploy_app`).

### How the agent works here

1. Finds or creates the project (`list_projects`, `create_project` — with a `prompt` it starts
   building at once).
2. Hands the work to the platform's **build agent** (`start_agent_run`), which edits the code,
   installs packages, runs the app and fixes its own errors. It follows the run with
   `get_agent_run` and answers questions with `reply_to_agent_run`.
3. Checks the result: `get_preview` (live URL and dev-server state), files, `run_command` for
   `npm run build` / `npx tsc --noEmit`.
4. Ships: `deploy_project`; on a failed build it reads the log the tool returns, has the build
   agent fix it and deploys again.

A build agent run is paid for the same way as in the web app: your connected Claude subscription
or the organization's API key. Without one, the agent is told to ask you to connect one.

## Tool reference

Read-only tools are annotated `readOnlyHint`; ones that destroy or overwrite are `destructiveHint`,
so clients can ask before running them. Errors come back as tool results (`isError`) with what
went wrong and what to do next.

**Long-running work** returns immediately with an id. Tools that follow work take
`waitSeconds` (≤ 50): the call waits for it to finish, sending progress notifications, and answers
with the current state if it has not. Call again to keep following. **Retries** of
`create_project`, `start_agent_run`, `deploy_project`, `restore_checkpoint` and `sync_github` are
safe with an `idempotencyKey`.

### Account and projects

| Tool              | Scope               | What it does                                                                                  |
| ----------------- | ------------------- | --------------------------------------------------------------------------------------------- |
| `get_account`     | read                | The organization this connection acts in, granted scopes, whether you can manage integrations |
| `list_projects`   | read                | Projects you can see                                                                          |
| `get_project`     | read                | One project, with its preview URL and state                                                   |
| `list_templates`  | read                | Starter templates (Vite React, Next.js, Node API, Python…)                                    |
| `create_project`  | write               | New project from a template; optional `prompt` starts the build agent                         |
| `rename_project`  | write               | Rename                                                                                        |
| `archive_project` | write · destructive | Archive (remove from the list, stop the preview, release integrations)                        |

### Build agent

| Tool                 | Scope               | What it does                                                                                                   |
| -------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `start_agent_run`    | write               | Give the build agent a task (`prompt`, optional `model`, `useClaudeSubscription`, `waitSeconds`)               |
| `get_agent_run`      | read                | Status, files changed, tools run, errors, latest reply and next step since `sinceSeq`; `waitSeconds` to follow |
| `reply_to_agent_run` | write               | Answer a run that is `awaiting_input`, or send a follow-up                                                     |
| `cancel_agent_run`   | write · destructive | Stop a run (finished turns stay checkpointed)                                                                  |
| `list_agent_runs`    | read                | Run history                                                                                                    |
| `get_conversation`   | read                | What was asked and answered in the project                                                                     |

### Files, commands and preview

| Tool                          | Scope | What it does                                                                                                                                     |
| ----------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_files`                  | read  | One directory (wakes a sleeping workspace)                                                                                                       |
| `read_file`                   | read  | One file and its `baseCheckpointId`                                                                                                              |
| `write_file`                  | write | Create or overwrite a file, recorded as a checkpoint; pass `baseCheckpointId` from `read_file`                                                   |
| `search_files` / `find_files` | read  | Text search / filename glob                                                                                                                      |
| `run_command`                 | write | One allowlisted program (npm, npx, pnpm, node, git, grep, rg, sed, rm, mv, cp, mkdir…), no shell operators, 120 s; output is scrubbed of secrets |
| `get_preview`                 | read  | Live preview URL, dev-server stage, visibility; `wake: true` starts the workspace                                                                |

### Checkpoints

| Tool                  | Scope               | What it does                                                    |
| --------------------- | ------------------- | --------------------------------------------------------------- |
| `list_checkpoints`    | read                | History (each agent turn and manual save)                       |
| `get_checkpoint_diff` | read                | What a checkpoint changed                                       |
| `restore_checkpoint`  | write · destructive | Restore the project to a checkpoint (requires `idempotencyKey`) |

### Deploy

| Tool                 | Scope                | What it does                                                                                                                  |
| -------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `deploy_project`     | deploy               | Build and deploy (requires `idempotencyKey`; `waitSeconds` to follow). On failure the answer carries the end of the build log |
| `get_deployment`     | read                 | State, site URL when live, log tail on failure; `includeLog`, `waitSeconds`                                                   |
| `list_deployments`   | read                 | History                                                                                                                       |
| `get_site`           | read                 | The live site and its current release                                                                                         |
| `set_site_release`   | deploy · destructive | Release a specific deployment, or take the site offline                                                                       |
| `publish_to_netlify` | deploy               | Publish a deployment to the bound Netlify site                                                                                |

### GitHub

| Tool                                    | Scope | What it does                                                             |
| --------------------------------------- | ----- | ------------------------------------------------------------------------ |
| `get_github_link`                       | read  | The linked repository and branch (linking itself is done in the web app) |
| `sync_github`                           | write | Push to or pull from the linked repository; `waitSeconds` to follow      |
| `get_github_sync` / `list_github_syncs` | read  | One sync / history                                                       |

### Integrations (Supabase, Neon, Netlify, Resend)

| Tool                        | Scope               | What it does                                                                                                                           |
| --------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `list_integrations`         | read                | Connected accounts, the project's bindings, and the **names** of the environment variables the app receives (values are never exposed) |
| `list_provider_resources`   | read                | Sites, databases, projects or domains in a connected account, to bind                                                                  |
| `bind_integration`          | write               | Bind a resource to the project (needs the org's _manage integrations_ permission)                                                      |
| `unbind_integration`        | write · destructive | Remove a binding                                                                                                                       |
| `get_database_migrations`   | read                | Which SQL migrations (from `supabase/migrations` or `db/migrations`) are applied or pending                                            |
| `apply_database_migrations` | write · destructive | Apply pending migrations you approved                                                                                                  |

Connecting a provider **account** happens in the web app (**Settings → Connectors**), never by
pasting a token into a chat. The agent will point you there.

### Resources

`baios://projects/{projectId}/files/{path}` — a project file, for clients that attach context by
URI.

## For operators

- **URLs** come from `APP_URL`: issuer `https://<host>`, resource `https://<host>/api/v1/mcp`.
  Change `APP_URL` and every discovery document follows.
- **Edge:** `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource*`
  must reach the API, and `/api/v1/mcp` must not be buffered (both done in `infra/Caddyfile*` and
  the Vite dev proxy).
- **Endpoints:** `POST /api/v1/oauth/register` (RFC 7591), `POST /api/v1/oauth/token`,
  `POST /api/v1/oauth/revoke` (RFC 7009); authorization at `/oauth/authorize` (web page).
- **Tokens:** access 1 hour, refresh 30 days with rotation; stored hashed. Revocation is
  immediate.
- **Limits:** 300 MCP calls per minute per connection; registration 10/min and token 60/min per
  address.
- **Logs:** one `mcp tool call` line per call with tool, grant, client, user, org, outcome and
  duration.

### Try it locally

```sh
pnpm dev                                    # web on :5173, API on :3000
claude mcp add --transport http baios-local http://localhost:5173/api/v1/mcp
```

Then `/mcp` → Authenticate in Claude Code, sign in, pick an organization and allow.

## Troubleshooting

| Symptom                                                    | Cause                                                                                                             |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Client says it cannot find authorization metadata          | `/.well-known/oauth-*` is not routed to the API at your edge                                                      |
| "This connection request is not valid" on the consent page | The client registered a different redirect URI, or points at another server's resource; reconnect from the client |
| Tools fail with _Permission Denied_                        | Your role in that project or organization does not allow it — the same answer the web app gives                   |
| `start_agent_run` says nothing can pay for the run         | Connect your Claude subscription or add an organization API key in Settings                                       |
| _The project workspace is still starting_                  | A hibernated workspace is resuming; retry in ~15 s                                                                |
| Progress never appears, then the result arrives at once    | A proxy is buffering `/api/v1/mcp`; disable buffering for it                                                      |
