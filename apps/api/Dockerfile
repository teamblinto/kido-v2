# Pinned by digest, not by tag alone: the tag moves, and a build that cannot be
# reproduced cannot be deployed by digest either (FR-006, research R1). The tag
# stays alongside it so a human can see what the digest is.
# node:24-alpine
FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder

WORKDIR /workspace
RUN corepack enable

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @repo/api... build
RUN pnpm --filter @repo/api deploy --prod /output/api
# deploy packs like `npm pack`, which drops every package-lock.json; the templates' `npm ci` needs them.
RUN rm -rf /output/api/templates && cp -r apps/api/templates /output/api/templates
# Spec 041: the hosted runner every agent home is given on start is the companion's bundle; the API
# reads it from AGENT_HOME_RUNNER_BUNDLE (below), never by importing the companion.
RUN pnpm --filter @repo/companion build && mkdir -p /output/api/runner && cp apps/companion/dist/main.js /output/api/runner/main.js

# node:24-alpine — the same digest as the builder stage.
FROM node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runner

ENV NODE_ENV=production
WORKDIR /app
ENV AGENT_HOME_RUNNER_BUNDLE=/app/runner/main.js

# git: the connector shells out to it for push and pull bundles (spec 018, plan § Ask-first).
RUN apk add --no-cache git && addgroup -S app && adduser -S app -G app
COPY --from=builder --chown=app:app /output/api ./

# Which build this is (spec 025 FR-033, research R7). Declared in the runner stage only — the
# builder's output must not vary with them, or two builds of the same commit would produce two
# digests. Baked as ENV so `GET /api/v1/version` can answer them, and so `environment.ts`'s
# refusal outside DEPLOY_ENV=local is satisfied by the image rather than by a deploy remembering
# to pass three more variables. Empty defaults keep a plain `docker build` working: a local image
# built without them is a local image, and `local` fills the values in itself.
ARG BUILD_DIGEST=""
ARG BUILD_COMMIT=""
ARG BUILD_AT=""

ENV BUILD_DIGEST=${BUILD_DIGEST}
ENV BUILD_COMMIT=${BUILD_COMMIT}
ENV BUILD_AT=${BUILD_AT}

USER app
EXPOSE 3000

CMD ["node", "dist/main.js"]
