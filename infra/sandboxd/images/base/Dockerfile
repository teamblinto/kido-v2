# Pinned by digest, not by tag alone (FR-006): the tag moves, the digest does not.
# node:24-bookworm-slim
FROM node@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

# No sudo: containers run as uid 1000 with all capabilities dropped and no-new-privileges.
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      git ripgrep python3 python3-venv curl ca-certificates findutils coreutils procps \
 && rm -rf /var/lib/apt/lists/* \
 && userdel -r node && groupadd -g 1000 daytona \
 && useradd -u 1000 -g 1000 -m -d /home/daytona -s /bin/bash daytona \
 && mkdir -p /opt/baios && chown 1000:1000 /opt/baios

WORKDIR /home/daytona
USER 1000
CMD ["sleep","infinity"]
