#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

export PATH="$PATH:/usr/local/bin:/usr/bin:/bin:$HOME/.nodenv/shims:$HOME/.nvm/versions/node/*/bin"

for profile in "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
  if [ -f "$profile" ]; then
    # shellcheck disable=SC1090
    . "$profile" >/dev/null 2>&1 || true
  fi
done

if [ -d "$HOME/.nodenv" ]; then
  export PATH="$HOME/.nodenv/bin:$PATH"
  if command -v nodenv >/dev/null 2>&1; then
    eval "$(nodenv init - bash 2>/dev/null)" || true
    eval "$(nodenv init - zsh 2>/dev/null)" || true
  fi
  export PATH="$HOME/.nodenv/shims:$PATH"
fi

find_node_bin() {
  local candidate
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in \
    "$HOME/.nodenv/shims/node" \
    "$HOME/.nodenv/versions"/*/bin/node \
    "$HOME/.nvm/versions/node"/*/bin/node \
    /usr/bin/node \
    /usr/local/bin/node \
    /opt/node/bin/node; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(find_node_bin)" || { echo "Node.js was not found. Please install Node 22/23 or set the correct path." >&2; exit 127; }

export PORT="${PORT:-3002}"
export HOST="${HOST:-0.0.0.0}"

printf 'Starting WhatsApp service with %s\n' "$NODE_BIN"
printf 'Listening on %s:%s\n' "$HOST" "$PORT"
exec "$NODE_BIN" index.js
