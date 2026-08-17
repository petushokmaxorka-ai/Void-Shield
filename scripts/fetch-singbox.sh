#!/usr/bin/env bash
# Скачать sing-box для всех поддерживаемых платформ и положить в resources/bin/<platform>/.
# Запуск перед сборкой релиза: bash scripts/fetch-singbox.sh [--all] [version]
#
# Структура:
#   resources/bin/linux-x64/sing-box        (ELF)
#   resources/bin/windows-x64/sing-box.exe  (PE)
#   resources/bin/darwin-x64/sing-box       (Mach-O)
#   resources/bin/darwin-arm64/sing-box     (Mach-O ARM)
#
# Бинари НЕ коммитятся в git (resources/bin/ в .gitignore).
#
# sing-box даёт: Hysteria2, TUIC, ShadowTLS, AnyTLS, WireGuard, SSH, Naive
# + нативные urltest (авто-выбор быстрейшего) и selector outbounds +
# clash-api (для UI). Это основное ядро Hiddify/NekoBox.
set -euo pipefail

VERSION=""
FETCH_ALL=0
for arg in "$@"; do
  case "$arg" in
    --all) FETCH_ALL=1 ;;
    *) VERSION="$arg" ;;
  esac
done

DEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/resources/bin"
mkdir -p "${DEST_DIR}"

PROXY="${https_proxy:-${HTTPS_PROXY:-}}"
# --retry: GitHub release CDN occasionally RSTs mid-handshake (censorware);
# a couple of retries makes the fetch reliable.
CURL_OPTS=(-sS --max-time 180 -L --retry 5 --retry-all-errors --retry-delay 3)
if [ -n "${PROXY}" ]; then CURL_OPTS+=(-x "${PROXY}"); fi

# ─── Pinned release + sha256 digests (supply-chain hardening) ───
# Reproducible builds: default version is PINNED, not /latest.
# Bump: set new tag + refresh digests from the GitHub API —
#   curl -s https://api.github.com/repos/SagerNet/sing-box/releases/tags/<tag> \
#     | jq -r '.assets[] | "\(.name) \(.digest)"'
PINNED_VERSION="v1.13.19"
if [ -z "${VERSION}" ]; then
  VERSION="${PINNED_VERSION}"
fi
echo "sing-box version: ${VERSION}" >&2

# sha256 digests of release assets for ${PINNED_VERSION} (GitHub API asset.digest).
declare -A SHA256=(
  [sing-box-1.13.19-linux-amd64.tar.gz]="ef88a9e577d474210867bd708933d042e9b70106529df2656182c9db90106aa1"
  [sing-box-1.13.19-windows-amd64.zip]="e011a4def2f5e2b143ed54adb2b1a20a6be407806ab4442f3667f1dd817a2c8d"
  [sing-box-1.13.19-darwin-amd64.tar.gz]="31ee722237d95774e101fbffeae6be6776249c5f7db229ad8ff00b45b22e6a00"
  [sing-box-1.13.19-darwin-arm64.tar.gz]="23bf191906f2dfc9f00e9f0092f274f3426ba9377327e903ff94e636b64d0997"
)

# Verify a downloaded archive against its expected sha256.
# Empty expected (custom version without a digest entry) → skip with a warning.
verify_sha256() {
  local file="$1" expected="$2"
  if [ -z "${expected}" ]; then
    echo "  warn: no pinned digest for this version — checksum skipped" >&2
    return 0
  fi
  local actual=""
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "${file}" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "${file}" | awk '{print $1}')"
  else
    echo "  warn: sha256 tool not found — checksum skipped" >&2
    return 0
  fi
  if [ "${actual}" != "${expected}" ]; then
    echo "  CHECKSUM MISMATCH: expected ${expected}, got ${actual}" >&2
    return 1
  fi
  echo "  checksum ok" >&2
}

# Strip leading 'v' for asset-name composition (assets use bare version).
VER_NUM="${VERSION#v}"

# Map: target-dir -> sing-box asset name
declare -A TARGETS=(
  [linux-x64]="sing-box-${VER_NUM}-linux-amd64.tar.gz"
  [windows-x64]="sing-box-${VER_NUM}-windows-amd64.zip"
  [darwin-x64]="sing-box-${VER_NUM}-darwin-amd64.tar.gz"
  [darwin-arm64]="sing-box-${VER_NUM}-darwin-arm64.tar.gz"
)

# By default (no --all) download only the host platform.
if [ "${FETCH_ALL}" -eq 0 ]; then
  OS="$(uname -s)"
  ARCH="$(uname -m)"
  case "${OS}-${ARCH}" in
    Linux-x86_64|Linux-amd64) HOST_TARGET="linux-x64" ;;
    Linux-aarch64|Linux-arm64) HOST_TARGET="linux-arm64" ;;
    Darwin-x86_64) HOST_TARGET="darwin-x64" ;;
    Darwin-arm64) HOST_TARGET="darwin-arm64" ;;
    MINGW*-*|MSYS*-*|CYGWIN*-*) HOST_TARGET="windows-x64" ;;
    *) echo "Unknown host platform ${OS}-${ARCH}, use --all" >&2; exit 1 ;;
  esac
  HOST_ASSET="${TARGETS[$HOST_TARGET]:-}"
  if [ -z "${HOST_ASSET}" ]; then
    echo "No sing-box asset mapped for ${HOST_TARGET}" >&2
    exit 1
  fi
  unset TARGETS
  declare -A TARGETS=( ["${HOST_TARGET}"]="${HOST_ASSET}" )
fi

extract_tarball() {
  # Extract a sing-box archive (.tar.gz or .zip) and locate the binary inside.
  # sing-box archives contain a top dir like sing-box-<ver>-<platform>/
  local archive="$1" ext="$2" out_dir="$3"
  local tmp; tmp="$(mktemp -d)"
  if [ "$ext" = "zip" ]; then
    if command -v unzip >/dev/null 2>&1; then
      unzip -o "$archive" -d "$tmp" >/dev/null
    else
      python3 -c "import zipfile; zipfile.ZipFile('$archive').extractall('$tmp')"
    fi
  else
    tar -xzf "$archive" -C "$tmp"
  fi
  # Find the sing-box binary (may be nested one level deep).
  local bin
  bin="$(find "$tmp" -type f -name 'sing-box*' | head -1)"
  [ -z "$bin" ] && { rm -rf "$tmp"; return 1; }
  cp "$bin" "$out_dir/"
  chmod +x "$out_dir/$(basename "$bin")" 2>/dev/null || true
  rm -rf "$tmp"
}

fetch_one() {
  local target="$1" asset="$2"
  local out_dir="${DEST_DIR}/${target}"
  mkdir -p "${out_dir}"
  local url="https://github.com/SagerNet/sing-box/releases/download/${VERSION}/${asset}"
  local ext="tar.gz"; [[ "$asset" == *.zip ]] && ext="zip"

  echo "  ${target}: downloading ${asset}..." >&2
  if ! curl "${CURL_OPTS[@]}" "${url}" -o "/tmp/singbox-${target}.${ext}"; then
    echo "  ${target}: FAILED to download ${url}" >&2
    return 1
  fi

  # Supply-chain gate: reject tampered/corrupted archives BEFORE extraction.
  local expected=""
  if [ "${VERSION}" = "${PINNED_VERSION}" ]; then expected="${SHA256[${asset}]:-}"; fi
  if ! verify_sha256 "/tmp/singbox-${target}.${ext}" "${expected}"; then
    echo "  ${target}: REJECTED — archive digest mismatch" >&2
    rm -f "/tmp/singbox-${target}.${ext}"
    return 1
  fi

  # On Windows the binary is sing-box.exe; elsewhere just sing-box.
  local bin_name="sing-box"
  [ "${target}" = "windows-x64" ] && bin_name="sing-box.exe"

  # Extract then normalize the name.
  extract_tarball "/tmp/singbox-${target}.${ext}" "$ext" "$out_dir"
  # rename sing-box → sing-box.exe on windows if needed
  if [ "${target}" = "windows-x64" ] && [ -f "${out_dir}/sing-box" ]; then
    mv "${out_dir}/sing-box" "${out_dir}/sing-box.exe"
  fi
  rm -f "/tmp/singbox-${target}.${ext}"

  if [ -f "${out_dir}/${bin_name}" ]; then
    echo "  ${target}: ok ($(ls -la "${out_dir}/${bin_name}" | awk '{print $5}') bytes)" >&2
  else
    echo "  ${target}: binary not found after extract" >&2
    return 1
  fi
}

echo "Downloading sing-box binaries..." >&2
FAILED=0
# Sort keys so output is deterministic.
for target in $(printf '%s\n' "${!TARGETS[@]}" | sort); do
  asset="${TARGETS[$target]}"
  fetch_one "$target" "$asset" || FAILED=1
done

echo "Done. Binaries in ${DEST_DIR}/" >&2
[ "${FAILED}" -eq 0 ] || { echo "Some platforms failed (see above)" >&2; exit 1; }
