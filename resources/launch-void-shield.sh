#!/usr/bin/env bash
# VOID-SHIELD — repo launcher (Electron). Portable: no hardcoded home path.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

needs_build() {
  [[ ! -f out/main/index.js ]] && return 0
  find src package.json electron.vite.config.ts -type f -newer out/main/index.js 2>/dev/null | grep -q .
}

if needs_build; then
  echo "VOID-SHIELD: building latest..." >&2
  npm run build
fi

ELECTRON="${ROOT}/node_modules/.bin/electron"
if [[ ! -x "${ELECTRON}" ]]; then
  echo "VOID-SHIELD: missing ${ELECTRON} — run: npm install && npm run build" >&2
  exit 1
fi

if pgrep -f "${ROOT}/node_modules/electron/dist/electron" >/dev/null 2>&1; then
  echo "VOID-SHIELD: closing previous window(s)..." >&2
  pkill -f "${ROOT}/node_modules/electron/dist/electron" 2>/dev/null || true
  sleep 1
fi

unset ELECTRON_RUN_AS_NODE
exec "${ELECTRON}" "${ROOT}" "$@"
