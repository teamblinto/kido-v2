#!/usr/bin/env bash
# The agent home image (spec 041): Node 24 for the hosted runner, and Claude Code installed as
# published, by its official installer, at a pinned version. Auto-update is switched off at run
# time (DISABLE_AUTOUPDATER=1 in the runner's environment), never by patching the binary.
set -euo pipefail

CLAUDE_VERSION="${1:?usage: install.sh <claude-version>}"

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# The runner needs Node >= 24; the base image's own Node is kept when it is new enough.
if [ "$(node_major)" -lt 24 ]; then
  echo "base image must provide Node >= 24" >&2; exit 1
fi
node --version

# Claude Code, as the sandbox user, into ~/.local/bin (the official installer's own location).
curl -fsSL https://claude.ai/install.sh | bash -s "$CLAUDE_VERSION"
"$HOME/.local/bin/claude" --version

# Where the runner bundle and its token file are written on every start.
mkdir -p /opt/baios
mkdir -p "$HOME/.claude"
