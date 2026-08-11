#!/usr/bin/env bash
# Install VOID-SHIELD as an AppImage application for HereticArch.
#
# Builds (if needed) and installs a real executable AppImage — not a
# .desktop+shell-script combo. This matters because Dolphin/Plasma 6.6
# refuses to launch .desktop files on double-click (security), but runs
# AppImages as ordinary programs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="VoidShield"
APPIMAGE_SRC="${REPO_ROOT}/release/VoidShield-1.0.0.AppImage"
BIN_DIR="${HOME}/.local/bin"
APPS_DIR="${HOME}/.local/share/applications"
ICON_THEME="${HOME}/.local/share/icons/hicolor"
SVG_ICON="${REPO_ROOT}/resources/void-shield-icon.svg"
PNG_ICON="${REPO_ROOT}/resources/void-shield-icon.png"
DESKTOP_DST="${APPS_DIR}/void-shield.desktop"

mkdir -p "${BIN_DIR}" "${APPS_DIR}"

# ─── 1. Build the AppImage if missing or source changed ────────────────
needs_build() {
  [[ ! -f "${APPIMAGE_SRC}" ]] && return 0
  # Rebuild if any source/proto is newer than the AppImage
  find "${REPO_ROOT}/src" "${REPO_ROOT}/proto" "${REPO_ROOT}/package.json" \
       "${REPO_ROOT}/electron.vite.config.ts" -type f \
       -newer "${APPIMAGE_SRC}" 2>/dev/null | grep -q .
}

if needs_build; then
  echo "VOID-SHIELD: building AppImage..." >&2
  cd "${REPO_ROOT}"
  # Prefer curated PNG art; fall back to SVG rasterize.
  mkdir -p build
  if [[ -f "${PNG_ICON}" ]]; then
    cp -f "${PNG_ICON}" build/icon.png
  elif command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w 512 -h 512 "${SVG_ICON}" -o build/icon.png
  fi
  npm run build
  npx electron-builder --linux
fi

if [[ ! -f "${APPIMAGE_SRC}" ]]; then
  echo "ERROR: AppImage build failed — ${APPIMAGE_SRC} not found" >&2
  exit 1
fi

# ─── 2. Install the AppImage as a stable executable ────────────────────
cp "${APPIMAGE_SRC}" "${BIN_DIR}/${APP_NAME}"
chmod +x "${BIN_DIR}/${APP_NAME}"

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

# ─── 4. Menu entry — minimal, mirrors a working AppImage .desktop (e.g. ZCode)
# Plasma/Dolphin is fussy about .desktop contents; keep it lean. The app is
# launched from the application menu / KRunner (Super → type "void"), NOT by
# clicking a file on the desktop (Dolphin opens .desktop files as documents).
cat > "${DESKTOP_DST}" <<EOF
[Desktop Entry]
Name=VOID-SHIELD
Comment=Heretic Dark Mechanicus VPN — paste URL, ignite
Exec="${BIN_DIR}/${APP_NAME}" %U
Terminal=false
Type=Application
Icon=${ICON_ABS}
Categories=Network;
StartupWMClass=VoidShield
MimeType=x-scheme-handler/void-shield;
EOF
chmod 755 "${DESKTOP_DST}"
gtk-update-icon-cache -f "${ICON_THEME}" 2>/dev/null || true
update-desktop-database "${APPS_DIR}" 2>/dev/null || true
xdg-desktop-menu forceupdate 2>/dev/null || true
# Register the void-shield:// deep-link scheme so provider websites can do
# one-click import (void-shield://import?url=...).
xdg-mime default "${APP_NAME}.desktop" x-scheme-handler/void-shield 2>/dev/null || true

# ─── 5. Register AppImage launch handler ───────────────────────────────
# Dolphin/Plasma 6.6 opens AppImages as archives (SquashFS) by default,
# showing their contents instead of launching them. Register a MIME handler
# so AppImage files are EXECUTED, not inspected.
APPIMAGE_HANDLER="${APPS_DIR}/appimage-launch.desktop"
if [[ ! -f "${APPIMAGE_HANDLER}" ]]; then
  cat > "${APPIMAGE_HANDLER}" <<'HANDLER'
[Desktop Entry]
Type=Application
Name=AppImage Launcher
Exec=appimage-run %f
NoDisplay=true
MimeType=application/vnd.appimage;application/x-appimage;application/x-iso9660-appimage;
HANDLER
  chmod 644 "${APPIMAGE_HANDLER}"
fi
# The runner: make executable + launch (never inspect the archive)
APPIMAGE_RUNNER="${BIN_DIR}/appimage-run"
if [[ ! -f "${APPIMAGE_RUNNER}" ]]; then
  cat > "${APPIMAGE_RUNNER}" <<'RUNNER'
#!/usr/bin/env bash
set -e
f="$1"
[ -z "$f" ] && exit 1
chmod +x "$f"
exec "$f"
RUNNER
  chmod +x "${APPIMAGE_RUNNER}"
fi
xdg-mime default appimage-launch.desktop application/vnd.appimage 2>/dev/null || true
xdg-mime default appimage-launch.desktop application/x-appimage 2>/dev/null || true
# KDE/Ark also intercepts AppImages via x-iso9660-appimage — must override that too.
xdg-mime default appimage-launch.desktop application/x-iso9660-appimage 2>/dev/null || true

# ─── 6. Refresh caches ─────────────────────────────────────────────────
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "${ICON_THEME}" 2>/dev/null || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "${APPS_DIR}" 2>/dev/null || true
fi
if command -v kbuildsycoca6 >/dev/null 2>&1; then
  kbuildsycoca6 2>/dev/null || true
fi

cat <<EOF
VOID-SHIELD installed as AppImage.

  Binary   : ${BIN_DIR}/${APP_NAME}
  Menu     : ${DESKTOP_DST}
  Icon     : void-shield (hicolor theme)

Launch: open the application menu / KRunner (Super → type "void" → Enter).
EOF
