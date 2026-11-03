# Pinned by digest, like the gateway image (FR-006): the tag stays alongside it so a human can see
# what the digest is. node:24-alpine
FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder

WORKDIR /workspace
RUN corepack enable

COPY . .
RUN pnpm install --frozen-lockfile
# sandboxd runs from source (node strips the types), so there is no build step, only a prod deploy.
RUN pnpm --filter @repo/sandboxd deploy --prod /output/sandboxd

# node:24-alpine — the same digest as the builder stage.
FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runner

ENV NODE_ENV=production
WORKDIR /app

# iptables/ip6tables/bash: infra/sandboxd/firewall.sh. It addresses bridges by name and never calls
# the docker CLI, so none is installed (the engine API over the socket is all sandboxd uses).
RUN apk add --no-cache iptables ip6tables bash
COPY --from=builder /output/sandboxd ./
# network.ts resolves the script as `../../../infra/sandboxd/firewall.sh` from /app/src, which
# lands on /infra/sandboxd/ here.
COPY infra/sandboxd/firewall.sh /infra/sandboxd/firewall.sh

# Deliberately root, unlike the gateway. sandboxd is the one process allowed to talk to
# /var/run/docker.sock (root-equivalent on the host) and to load iptables rules (CAP_NET_ADMIN,
# which only a real-root process in the host user namespace gets). There is no unprivileged
# version of either job; the compose service therefore runs with `userns_mode: host`, a read-only
# root filesystem and nothing but NET_ADMIN/NET_RAW added.
EXPOSE 3986

CMD ["node", "src/main.ts"]
