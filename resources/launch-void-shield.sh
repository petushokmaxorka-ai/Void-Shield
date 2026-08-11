#!/usr/bin/env bash
# VOID-SHIELD — canonical launcher (Electron, repo root)
# Autobuilds if source is newer than out/, closes stale instances.
set -euo pipefail

ROOT="/home/heretic/heretic-os/organa/void-shield-desktop"
cd "${ROOT}"

needs_build() {
  [[ ! -f out/main/index.js ]] && return 0
  find src package.json electron.vite.config.ts -type f -newer out/main/index.js 2>/dev/null | grep -q .
}

if needs_build; then
  echo "VOID-SHIELD: building latest..." >&2
  npm run build
fi

# Close stale instances (zombies break which build you see).
if pgrep -f "void-shield-desktop/node_modules/.bin/electron" >/dev/null 2>&1 \
   || pgrep -f "void-shield-desktop/node_modules/electron/dist/electron" >/dev/null 2>&1; then
  echo "VOID-SHIELD: closing previous window(s)..." >&2
  pkill -f "void-shield-desktop/node_modules/.bin/electron" 2>/dev/null || true
  pkill -f "void-shield-desktop/node_modules/electron/dist/electron" 2>/dev/null || true
  sleep 1
fi

# Cursor/agents set ELECTRON_RUN_AS_NODE=1 — breaks Electron main (app is undefined).
unset ELECTRON_RUN_AS_NODE

# electron-vite preview rebuilds on every start; run the built bundle directly.
exec "${ROOT}/node_modules/.bin/electron" .
