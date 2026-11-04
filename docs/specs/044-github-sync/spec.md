# 044 — GitHub sync: every turn lands on GitHub

**Status** Built, 2026-11-04. Verified against Postgres, Redis, real git and a fixture GitHub; not yet
against live GitHub.
**Depends on** 016 (checkpoints), 018 (GitHub connector), 026 (import, webhook), 041/043 (runs).
**Product reference** Lovable's GitHub integration. **Pattern reference** T3 Code's stacked git actions.

## Why

Spec 018 built the safe core: a GitHub App, sealed tokens, one-repository tokens, an outbox-driven
fast-forward push, one in-flight operation per project. But nothing pushes unless a person clicks,
commit messages read `Turn 3`, a personal account cannot create a repository, and the branch is
fixed at link time. This spec closes those gaps. It does not rebuild the core.

## Decisions (the builder's calls, for review)

1. **The trigger is `checkpoint.created`.** Both executors (cloud, subscription) end a turn in
   `SandboxTools.checkpoint`, so one event covers every run, a hand edit and a revert. A new consumer
   on its own queue (`connector.autosync`) requests a push; a `pull` checkpoint never does.
2. **Auto-sync is on for new links, off for existing ones.** A deployment must not start pushing to
   repositories whose owners never asked for it.
3. **One slot, trailing-edge coalescing.** The partial unique index stays the concurrency control. A
   checkpoint that finds the slot taken is skipped; when a push settles it compares the head with
   what it pushed and queues one more if the head moved. It cannot loop: a follow-up needs a new head.
4. **Never force, never lose work.** When an automatic push finds GitHub ahead, diverged or the
   branch protected, the head goes to the side branch `kido-sync` by fast-forward, as Lovable's
   `lovable-sync`. The link records it and the panel says so. A side branch that itself moved fails
   as `diverged`; nothing is overwritten. A person's push on a link with auto-sync on falls back the
   same way, so one-click never strands work; with auto-sync off it keeps spec 018's refusal.
5. **A webhook still never pulls** (026 FR-034). Two-way auto-pull is left out; the panel offers Pull.
6. **Commit messages are deterministic.** Subject: the run's prompt, first line, secrets scrubbed,
   72 characters, ` (turn n)` past the first. Fallback `Turn n`. No model call: runs are paid for by the
   person's subscription (043), and a git push should not spend it. The T3 lesson stands: a message
   must never be able to block a commit.
7. **Personal accounts create repositories with a one-shot user token.** An installation token cannot
   use `POST /user/repos` reliably, so the panel sends the person through the App's OAuth once; the API
   exchanges the code, checks the login is the connected account, creates the repository, adds it to
   the installation (`PUT /user/installations/…`, needed for selected-repository installs; a refusal
   is fine if the App can already reach it), and revokes the token. It is never sealed or stored. Needs the optional `GITHUB_APP_CLIENT_SECRET`.
8. **One-click commit and push** is `POST …/sync/commit`: commits whatever is dirty as a member's
   `edit` checkpoint (message optional, generated from the files), then pushes. A clean tree skips the
   commit and still pushes, as T3's `skipped_no_changes`. A busy slot does not fail the commit: the
   trailing edge carries it.
9. **Switching branch moves where pushes go; it does not swap the project's files.** A project has one
   linear history. Switching to a branch that is not an ancestor reads as diverged. Refused during a
   run or an operation, as Lovable's picker is.
10. **Rename and transfer heal by id.** A push resolves the repository by its numeric id and rewrites
    the link's owner and name; a 404 closes the row as `repo-gone`. Branch routes heal the same way.
11. **A reconcile tick** (`connector.sync-reconcile`, 5 min) re-requests what a lost, transiently
    failed or pull-blocked operation left behind (a failure at most every 30 minutes), and closes
    stuck `queued` and `running` rows, either of which would otherwise hold the slot.

## Non-goals

Auto-pull; merging or rebasing on the platform; force push; pull requests; AI commit messages; GitHub
Enterprise-specific work; per-commit member co-authorship (commits stay under the app identity).

## Data

`repo_links`: `auto_sync boolean` (rows existing at migration false, new rows true), `side_branch text`.
`sync_operations`: `trigger` (`manual`|`auto`), `target_branch text`.
`sync_failure_reason`: `branch-protected`, `push-rejected`, `workflow-permission`, `repo-gone`,
`account-mismatch`.

`repo-link.ts` is widened deliberately; the SC-014 digest moves in the same change.

## API

| Route                         | Permission            | Does                                |
| ----------------------------- | --------------------- | ----------------------------------- |
| `PATCH …/repo-link`           | `project:files.write` | `autoSync`, `branch`                |
| `GET …/repo-link/branches`    | `project:read`        | The repository's branches           |
| `POST …/repo-link/branches`   | `project:files.write` | Create from the linked head, switch |
| `POST …/repo-link/authorize`  | `project:files.write` | Begin the personal-account create   |
| `POST …/repo-link/authorized` | `project:files.write` | Finish it: create, link, first push |
| `POST …/sync/commit`          | `project:files.write` | Commit and push                     |

## GitHub App settings

Repository: Administration (write), Contents (write), Metadata (read), Workflows (write). Subscribe to
`push`. Callback URL `<web>/connectors/github/authorized`. Setup URL as spec 018. A token asks for
`workflows: write` and falls back to without it, so an App not yet updated still pushes everything
else; a push touching `.github/workflows` then fails as `workflow-permission`.

## Success criteria

| Criterion                                           | Proved by                                                                                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A finished turn reaches GitHub with no click        | `a finished turn reaches GitHub with no click, marked automatic`; e2e `linking pushes the project with no click, through the real outbox` |
| Two turns during one push end with both on GitHub   | `two turns during one push: the slot holds, and both reach GitHub`                                                                        |
| GitHub ahead: work on `kido-sync`, `main` untouched | `push.real-git.spec.ts` (a real bare remote, no mocked git)                                                                               |
| Protected branch: same, with a reason               | `push.real-git.spec.ts` (a pre-receive hook printing GH006)                                                                               |
| Nothing ever force-pushes                           | `push.real-git.spec.ts` asserts argv after every test                                                                                     |
| A personal account creates a repository             | `repo-link.sync.spec.ts`, against the fixture GitHub                                                                                      |
| The user token is never stored                      | `the user token reaches no repository, secret, audit row, state, log or response`                                                         |
| One click commits and pushes dirty work             | `checkpoint.service.spec.ts`, `sync.service.auto.spec.ts`                                                                                 |
| A renamed repository keeps syncing                  | `push.real-git.spec.ts`; `a renamed repository heals before the owner/name route would refuse it`                                         |
| A lost job cannot wedge a project                   | `a queued row whose job was lost is closed too`                                                                                           |

## Known limits

- A push on a hibernated sandbox whose mirror is stale can fail until the sandbox wakes some other
  way: the bundler's wake rolls back with its own refusal, as it did before this spec. The reconcile
  tick retries. Commit & push wakes correctly.
- Linking an existing repository with unrelated history sends the project to `kido-sync`, and GitHub
  will not merge unrelated histories in a pull request without `--allow-unrelated-histories`. The
  import flow (026) is the better path for that repository.
- `listBranches` stops at 300 branches.
