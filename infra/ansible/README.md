# `infra/ansible` — the fleet

Spec 025 · [tasks T022, T023, T050–T053](../../docs/specs/025-platform-delivery/tasks.md) ·
[research R6, R9](../../docs/specs/025-platform-delivery/research.md) ·
[architecture § 01](../../docs/architecture.md)

A play per pool role, an inventory per environment, and `infra/deploy.sh` taking an environment and
a digest. Compose plus Caddy plus Ansible, which § 13's threshold table says is the right size until
roughly ten app nodes — and nothing here prepares for a cluster.

| Play                           | Pool      | Runs                                                                                                                    |
| ------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| [`app.yml`](./app.yml)         | `app`     | Caddy (from [`infra/Caddyfile`](../Caddyfile)), `forge-app` as `api`, `forge-app` as `agent,events,cron`, node exporter |
| [`data.yml`](./data.yml)       | `data`    | OpenBao on Raft — **three voters**, the third being the witness — and its snapshot timer                                |
| [`gateway.yml`](./gateway.yml) | `gateway` | `forge-gateway` and the node exporter, with **no credential of any kind**                                               |

`daytona` and `ops` have inventory groups here and their plays belong to their own features; this
feature's tasks are the three above.

## Three voters, not two

[`data.yml`](./data.yml)'s first two tasks refuse a data pool that is not exactly three OpenBao Raft
voters, one of which declares `openbao_raft_role: witness`. § 01 is the reason:

> Two OpenBao Raft voters have a quorum of two, so losing either node takes the secret store — and
> therefore every tenant credential, and therefore every run — offline. The third data-plane node
> exists for that vote; it can be small, because it stores nothing.

The peer list in [`templates/openbao.hcl.j2`](./templates/openbao.hcl.j2) is derived from the whole
`data` group rather than hand-maintained, so the topology is whatever the inventory says and the
`retry_join` blocks cannot drift out of step with it.

**This play does not initialise, unseal, mount `transit` or issue the platform token.** Those are
[`docs/runbooks/openbao.md`](../../docs/runbooks/openbao.md) § 2–§ 5, performed by people with the
three key holders present (FR-021, FR-022). Automating them would put the unseal shares somewhere a
machine can reach, which is the failure the split exists to prevent. The play delivers three nodes
that are installed, configured, running and **sealed**, ready for the runbook's § 2.

## Snapshots

The runbook's § 7, as configuration: daily at `03:15 UTC` with `Persistent=true`, **and** after any
material change — [`data.yml`](./data.yml)'s `openbao material change` handler fires on a Raft peer
change, which is the one material change a converge can make; the other five are performed by hand
and run the same script. The snapshot ships to an object store outside this deployment and the local
copy is shredded, and the play refuses a snapshot endpoint that resolves into this fleet, because a
snapshot stored on the thing it restores is not a backup (FR-020).

## The gateway holds nothing

`gateway_env` in [`inventories/staging/group_vars/gateway.yml`](./inventories/staging/group_vars/gateway.yml)
is the whole environment `forge-gateway` is given. It is not merged with `forge_app_env`, which is
defined in `group_vars/app.yml` and is not in scope on a gateway host at all — the two pools share no
variable that could carry a credential across. [`gateway.yml`](./gateway.yml) then checks it four
ways: forbidden key prefixes and forbidden value patterns, on the environment it is about to set
**and** on the environment the running container actually ended up with. T048 asserts the same
property on the rendered environment in `infra/deploy.sh`.

## T053 — no pool needs a hand-edited file on a node

Run [`./check-repo-sourced.sh`](./check-repo-sourced.sh). It checks five properties and fails if any
of them stops holding, so a later play that introduces a hand edit is caught here rather than found
on a node. What it checks, and what it found on 2026-09-22:

1. **No play edits a file in place on a node.** No `lineinfile`, `blockinfile`, `replace`,
   `ini_file`, `sed -i`, editor or `patch` anywhere in the three plays or the five templates. Every
   managed file is written whole from a repository source, so a hand edit on a node is not amended
   by the next converge — it is overwritten by it.
2. **Every file a play puts on a node comes from this repository.** Each `src:` resolves: the four
   OpenBao files and the two systemd units from `templates/`, the edge configuration from
   `../Caddyfile`, and the web assets from a URL addressed by the build digest. Every `content:`
   renders from an inventory variable.
3. **Every template referenced exists here, and every template here is referenced.** Five templates,
   five uses; no orphan, no dangling reference.
4. **No play invents a host.** No `add_host` and no `delegate_to` off the inventory; every target
   comes from `inventories/<environment>/hosts.yml`.
5. **No configuration value comes from the operator.** No `vars_prompt`, no `lookup('env')`, no
   `lookup('pipe')`. Every value is in `group_vars` or in the ansible-vault file described in
   [`vault.yml.example`](./inventories/staging/group_vars/vault.yml.example) — which is encrypted
   **and committed**, so changing a staging credential is a commit and a converge rather than an ssh
   session and an editor.

Together those are FR-030 and FR-032: changing what a pool runs means changing this repository, and
a rebuilt node gets what its pool has because it gets it from here.

**What this does not prove.** There is no hardware and no Docker daemon in the implementation
environment, so none of these plays has been run against a node. What has been run is in
§ Verification below. The 15-minute rebuild target (SC-012) and the rejoin are quickstart Walk 4's
rows, and stay unproved until staging exists.

## Verification

Run from this directory:

```sh
ansible-playbook --syntax-check -i inventories/staging/hosts.yml data.yml app.yml gateway.yml
ansible-lint data.yml app.yml gateway.yml inventories/
./check-repo-sourced.sh
```

On 2026-09-22 all three were green — `ansible-lint` at its `production` profile, 0 failures and 0
warnings — with `ansible-core` 2.19 and `community.docker` 4.8.5.
