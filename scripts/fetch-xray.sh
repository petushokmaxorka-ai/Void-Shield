#!/usr/bin/env bash
# Скачать xray-core для всех поддерживаемых платформ и положить в resources/bin/<platform>/.
# Запуск перед сборкой AppImage/rel: bash scripts/fetch-xray.sh [--all] [version]
#
# Структура:
#   resources/bin/linux-x64/xray        (ELF)
#   resources/bin/windows-x64/xray.exe  (PE)
#   resources/bin/darwin-x64/xray       (Mach-O)
#   resources/bin/darwin-arm64/xray     (Mach-O ARM)
#
# Бинари НЕ коммитятся в git (resources/bin/ в .gitignore).
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
CURL_OPTS=(-sS --max-time 90 -L --retry 3 --retry-delay 2)
if [ -n "${PROXY}" ]; then CURL_OPTS+=(-x "${PROXY}"); fi
# ─── Pinned release + sha256 digests (supply-chain hardening) ───
# Reproducible builds: default version is PINNED, not /latest.
# Bump: set new tag + refresh digests from the GitHub API —
#   curl -s https://api.github.com/repos/XTLS/Xray-core/releases/tags/<tag> \
#     | jq -r '.assets[] | "\(.name) \(.digest)"'
PINNED_VERSION="v26.3.27"
if [ -z "${VERSION}" ]; then
  VERSION="${PINNED_VERSION}"
fi
echo "xray-core version: ${VERSION}" >&2

# sha256 digests of release assets for ${PINNED_VERSION} (GitHub API asset.digest).
declare -A SHA256=(
  [Xray-linux-64.zip]="23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae"
  [Xray-windows-64.zip]="d004c39288ce9ada487c6f398c7c545f7d749e44bdfdd59dbc9f865afba4e1ad"
  [Xray-macos-64.zip]="f5b0471d3459eff1b82e48af0aeac186abcc3298210070afbbbd8437a4e8b203"
  [Xray-macos-arm64-v8a.zip]="2e93a67e8aa1936ecefb307e120830fcbd4c643ab9b1c46a2d0838d5f8409eaf"
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

# Map: target-dir -> xray asset name
# (Xray-core asset naming convention — ARM variants use the -v8a suffix)
declare -A TARGETS=(
  [linux-x64]="Xray-linux-64.zip"
  [windows-x64]="Xray-windows-64.zip"
  [darwin-x64]="Xray-macos-64.zip"
  [darwin-arm64]="Xray-macos-arm64-v8a.zip"
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
    echo "No xray asset mapped for ${HOST_TARGET}" >&2
    exit 1
  fi
  unset TARGETS
  declare -A TARGETS=( ["${HOST_TARGET}"]="${HOST_ASSET}" )
fi

fetch_one() {
  local target="$1" asset="$2"
  local out_dir="${DEST_DIR}/${target}"
  mkdir -p "${out_dir}"
  local url="https://github.com/XTLS/Xray-core/releases/download/${VERSION}/${asset}"
  local tmp; tmp="$(mktemp -d)"

  echo "  ${target}: downloading ${asset}..." >&2
  if ! curl "${CURL_OPTS[@]}" "${url}" -o "${tmp}/xray.zip"; then
    echo "  ${target}: FAILED to download ${url}" >&2
    rm -rf "${tmp}"
    return 1
  fi

  # Supply-chain gate: reject tampered/corrupted archives BEFORE extraction.
  local expected=""
  if [ "${VERSION}" = "${PINNED_VERSION}" ]; then expected="${SHA256[${asset}]:-}"; fi
  if ! verify_sha256 "${tmp}/xray.zip" "${expected}"; then
    echo "  ${target}: REJECTED — archive digest mismatch" >&2
    rm -rf "${tmp}"
    return 1
  fi

  if command -v unzip >/dev/null 2>&1; then
    unzip -o "${tmp}/xray.zip" -d "${tmp}/out" >/dev/null
  else
    python3 -c "import zipfile; zipfile.ZipFile('${tmp}/xray.zip').extractall('${tmp}/out')"
  fi

  # On Windows the binary is xray.exe; elsewhere just xray.
  local bin_name="xray"
  [ "${target}" = "windows-x64" ] && bin_name="xray.exe"
  # Also copy wintun.dll for Windows TUN support if present in the archive.
  cp "${tmp}/out/${bin_name}" "${out_dir}/${bin_name}"
  chmod +x "${out_dir}/${bin_name}" 2>/dev/null || true
  # wintun.dll (Windows TUN driver) — extract if present.
  if [ -f "${tmp}/out/wintun.dll" ]; then
    cp "${tmp}/out/wintun.dll" "${out_dir}/wintun.dll"
  fi
  rm -rf "${tmp}"
  echo "  ${target}: ok ($(ls -la "${out_dir}/${bin_name}" | awk '{print $5}') bytes)" >&2
}

echo "Downloading xray-core binaries..." >&2
FAILED=0
for target in "${!TARGETS[@]}"; do
  asset="${TARGETS[$target]}"
  fetch_one "$target" "$asset" || FAILED=1
done

# ─── geoip.dat + geosite.dat (routing rule data) ────────────
# xray needs these for geoip:private / geosite:ru rules. Source: Loyalsoldier
# (most comprehensive, regularly updated). Without them, any config using
# geoip: rules fails with exit=23 "failed to open geoip.dat".
echo "Downloading geoip.dat + geosite.dat..." >&2
for dat in geoip geosite; do
  out="${DEST_DIR}/${dat}.dat"
  if [ -s "${out}" ]; then
    echo "  ${dat}.dat: already present ($(stat -c%s "${out}") bytes)" >&2
    continue
  fi
  url="https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/${dat}.dat"
  if curl "${CURL_OPTS[@]}" "${url}" -o "${out}" 2>/dev/null && [ "$(stat -c%s "${out}" 2>/dev/null)" -gt 100000 ]; then
    echo "  ${dat}.dat: ok ($(stat -c%s "${out}") bytes)" >&2
  else
    echo "  ${dat}.dat: FAILED — copy manually from /usr/share/v2ray or ~/.local/bin/" >&2
    rm -f "${out}"
  fi
done

echo "Done. Binaries in ${DEST_DIR}/" >&2
[ "${FAILED}" -eq 0 ] || { echo "Some platforms failed (see above)" >&2; exit 1; }
