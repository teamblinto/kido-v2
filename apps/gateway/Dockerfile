# Pinned by digest, not by tag alone: the tag moves, and a build that cannot be
# reproduced cannot be deployed by digest either (FR-006, research R1). The tag
# stays alongside it so a human can see what the digest is.
# node:24-alpine
FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder

WORKDIR /workspace
RUN corepack enable

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @repo/gateway... build
RUN pnpm --filter @repo/gateway deploy --prod /output/gateway

# node:24-alpine — the same digest as the builder stage.
FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runner

ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S app && adduser -S app -G app
COPY --from=builder --chown=app:app /output/gateway ./

USER app
EXPOSE 3200

CMD ["node", "src/main.ts"]
