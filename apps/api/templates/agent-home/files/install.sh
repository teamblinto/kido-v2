#!/usr/bin/env bash
# The agent home image (spec 041): Node 24 for the hosted runner, and Claude Code installed as
# published, by its official installer, at a pinned version. Auto-update is switched off at run
# time (DISABLE_AUTOUPDATER=1 in the runner's environment), never by patching the binary.
set -euo pipefail

CLAUDE_VERSION="${1:?usage: install.sh <claude-version>}"

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# The runner needs Node >= 24; the base image's own Node is kept when it is new enough.
if [ "$(node_major)" -lt 24 ]; then
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
  esac
  base=https://nodejs.org/dist/latest-v24.x
  work=$(mktemp -d)
  curl -fsSL "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
  file=$(awk -v suffix="linux-$arch.tar.gz" '$2 ~ suffix"$" { print $2 }' "$work/SHASUMS256.txt")
  curl -fsSL "$base/$file" -o "$work/$file"
  (cd "$work" && grep " $file\$" SHASUMS256.txt | sha256sum -c -)
  sudo tar -xzf "$work/$file" -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE
  rm -rf "$work"
  hash -r
fi
node --version

# Claude Code, as the sandbox user, into ~/.local/bin (the official installer's own location).
curl -fsSL https://claude.ai/install.sh | bash -s "$CLAUDE_VERSION"
"$HOME/.local/bin/claude" --version

# Where the runner bundle and its token file are written on every start.
sudo mkdir -p /opt/baios
sudo chown "$(id -un):$(id -gn)" /opt/baios
mkdir -p "$HOME/.claude"
