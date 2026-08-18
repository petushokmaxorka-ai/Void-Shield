#!/usr/bin/env bash
# Install VOID-SHIELD into the user application menu.
#
# AppImage needs FUSE (/dev/fuse) — that fails on this host and in many
# containers. Menu entry therefore launches the unpacked Electron binary
# or the repo launcher (same VPN surface as the dashboard: paste URL).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCHER="${REPO_ROOT}/resources/launch-void-shield.sh"
UNPACKED="${REPO_ROOT}/release/linux-unpacked/void-shield"
BIN_DIR="${HOME}/.local/bin"
APPS_DIR="${HOME}/.local/share/applications"
ICON_THEME="${HOME}/.local/share/icons/hicolor"
SVG_ICON="${REPO_ROOT}/resources/void-shield-icon.svg"
PNG_ICON="${REPO_ROOT}/resources/void-shield-icon.png"
DESKTOP_DST="${APPS_DIR}/void-shield.desktop"
WRAP="${BIN_DIR}/void-shield"

mkdir -p "${BIN_DIR}" "${APPS_DIR}"

# Never leave the electron-builder AppImage on PATH. It is a second,
# stale xray (118 old TCP nodes) and is not the dashboard VPN.
if [[ -f "${BIN_DIR}/VoidShield" ]] && file "${BIN_DIR}/VoidShield" | grep -q ELF; then
  mkdir -p "${HOME}/.local/share/void-shield-archive"
  mv -f "${BIN_DIR}/VoidShield" "${HOME}/.local/share/void-shield-archive/VoidShield.appimage.bak"
fi

if [[ -x "${UNPACKED}" ]]; then
  cat > "${WRAP}" <<EOF
#!/usr/bin/env bash
unset ELECTRON_RUN_AS_NODE
exec "${UNPACKED}" "\$@"
EOF
  chmod +x "${WRAP}"
elif [[ -x "${LAUNCHER}" ]]; then
  # Real file, not a symlink — writing through a symlink once overwrote
  # launch-void-shield.sh and made the launcher recurse forever.
  cat > "${WRAP}" <<EOF
#!/usr/bin/env bash
unset ELECTRON_RUN_AS_NODE
exec "${LAUNCHER}" "\$@"
EOF
  chmod +x "${WRAP}"
else
  echo "ERROR: no unpacked binary at ${UNPACKED} and no ${LAUNCHER}" >&2
  echo "  From a git clone: npm install && npm run build && npm run build:unpack" >&2
  echo "  Or: npm install && npm run build, then re-run this installer." >&2
  exit 1
fi

# ─── 3. Icons (hicolor theme) ──────────────────────────────────────────
ICON_SRC="${PNG_ICON}"
[[ -f "${ICON_SRC}" ]] || ICON_SRC="${REPO_ROOT}/build/icon.png"
if [[ -f "${ICON_SRC}" ]] && command -v convert >/dev/null 2>&1; then
  for size in 48 128 256 512; do
    mkdir -p "${ICON_THEME}/${size}x${size}/apps"
    convert "${ICON_SRC}" -resize "${size}x${size}" \
      "${ICON_THEME}/${size}x${size}/apps/void-shield.png" 2>/dev/null || true
  done
elif [[ -f "${ICON_SRC}" ]]; then
  mkdir -p "${ICON_THEME}/256x256/apps" "${ICON_THEME}/512x512/apps"
  cp -f "${ICON_SRC}" "${ICON_THEME}/256x256/apps/void-shield.png"
  cp -f "${ICON_SRC}" "${ICON_THEME}/512x512/apps/void-shield.png"
elif command -v rsvg-convert >/dev/null 2>&1; then
  for size in 48 128 256; do
    mkdir -p "${ICON_THEME}/${size}x${size}/apps"
    rsvg-convert -w "${size}" -h "${size}" "${SVG_ICON}" \
      -o "${ICON_THEME}/${size}x${size}/apps/void-shield.png" 2>/dev/null || true
  done
fi
mkdir -p "${ICON_THEME}/scalable/apps"
# Prefer crimson PNG; do not leave gold SVG as the theme's scalable pick.
rm -f "${ICON_THEME}/scalable/apps/void-shield.svg"
if [[ -f "${REPO_ROOT}/resources/icon.png" ]]; then
  cp -f "${REPO_ROOT}/resources/icon.png" "${ICON_THEME}/scalable/apps/void-shield.png"
elif [[ -f "${PNG_ICON}" ]]; then
  cp -f "${PNG_ICON}" "${ICON_THEME}/scalable/apps/void-shield.png"
fi
ICON_ABS="${ICON_THEME}/512x512/apps/void-shield.png"
[[ -f "${ICON_ABS}" ]] || ICON_ABS="${ICON_THEME}/256x256/apps/void-shield.png"
[[ -f "${ICON_ABS}" ]] || ICON_ABS="void-shield"

# ─── 4. Menu entry
cat > "${DESKTOP_DST}" <<EOF
[Desktop Entry]
Version=1.0
Name=VOID-SHIELD
Comment=Same VPN as the dashboard — heretic-vpn on :7890
Exec=${WRAP} %U
Terminal=false
Type=Application
Icon=${ICON_ABS}
Categories=Network;
StartupNotify=true
StartupWMClass=void-shield
MimeType=x-scheme-handler/void-shield;
EOF
chmod 644 "${DESKTOP_DST}"
cp -f "${DESKTOP_DST}" "${APPS_DIR}/VoidShield.desktop"
gtk-update-icon-cache -f "${ICON_THEME}" 2>/dev/null || true
update-desktop-database "${APPS_DIR}" 2>/dev/null || true
xdg-desktop-menu forceupdate 2>/dev/null || true
xdg-mime default void-shield.desktop x-scheme-handler/void-shield 2>/dev/null || true

if command -v kbuildsycoca6 >/dev/null 2>&1; then
  kbuildsycoca6 2>/dev/null || true
fi

cat <<EOF
VOID-SHIELD installed (no FUSE / AppImage).

  Launcher : ${WRAP}
  Menu     : ${DESKTOP_DST}

Launch from the application menu / KRunner (Super → type "void" → Enter).
EOF
