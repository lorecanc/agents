#!/usr/bin/env bash
set -e

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT_DIR"

if command -v bun >/dev/null 2>&1 && bun --version >/dev/null 2>&1; then
  exec bun "$ROOT_DIR/manage-agents/manage-agents.mjs" "$@"
fi

exec node "$ROOT_DIR/manage-agents/manage-agents.mjs" "$@"
